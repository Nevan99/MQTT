"""Async replacements for the blocking subprocess calls the agent is built on.

Every mixin drives CLI tools (iw, nmcli, wpa_cli, dhcpcd, ip). Under the
old threading model each of those was a blocking subprocess.run on some
worker thread; under asyncio they all funnel through `run`/`run_hard`
here, so a slow `iw scan` on one interface no longer occupies anything
while it waits - the event loop just services the other three radios.

Both functions return subprocess.CompletedProcess, unchanged from what
the sync code returned, so callers only had to grow an `await`.

This module is also the single seam the test suite fakes: patching
agent.proc.run replaces the CLI layer for every mixin at once.
"""
import asyncio
import os
import signal
import subprocess
import tempfile

# Matches the old sync default: calls that pass no timeout used to be able
# to hang forever. Under asyncio a hung call no longer blocks a thread, but
# it does hold whatever interface lock its caller took, so a ceiling still
# matters.
DEFAULT_TIMEOUT = 30


async def run(cmd, timeout=DEFAULT_TIMEOUT):
    """Run `cmd`, capture its output, and return a CompletedProcess.

    On timeout the process is killed and a CompletedProcess with
    returncode -9 is returned, rather than raising - callers throughout the
    agent branch on returncode and treat a failure as a reportable result,
    never as an exception to propagate to the MQTT loop.
    """
    cmd = [str(c) for c in cmd]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    except (FileNotFoundError, PermissionError, OSError) as e:
        # A missing binary (iw/nmcli not installed on this image) is a
        # reportable result, not an agent-level crash.
        return subprocess.CompletedProcess(cmd, 127, "", str(e))

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        await _kill(proc)
        return subprocess.CompletedProcess(
            cmd, -9, "", f"[pi_agent] {cmd[0]} killed after exceeding {timeout}s",
        )

    return subprocess.CompletedProcess(
        cmd, proc.returncode, _decode(stdout), _decode(stderr),
    )


async def run_hard(cmd, timeout, detach_output=False):
    """Like `run`, but guarantees the whole process *group* dies on timeout.

    Killing only the direct child isn't always enough: dhcpcd and nmcli
    fork background helpers that inherit the stdout/stderr pipes, and
    communicate() keeps waiting on those pipes even after the direct child
    is gone. Starting the child in its own session lets the timeout path
    signal every process that inherited them.

    This matters more than it looks: the caller holds an interface's wifi
    lock until this returns, so a call that outlives its nominal timeout
    doesn't just leave one command pending - it blocks every later
    connect/disconnect on that interface.

    detach_output goes a step further and stops the daemon inheriting our
    pipes at all, writing output to a temporary file instead. The kill-on-
    timeout above bounds that hazard but does not avoid it: a command like
    `dhcpcd` that *succeeds* by daemonizing leaves a child holding the
    pipes open, so communicate() waits out the full timeout on a call that
    actually finished in seconds, and the process group then gets SIGKILLed
    - taking the working daemon with it. With a file there is no pipe to
    hold open, so the call returns as soon as the direct child exits and
    the daemon it left behind is free to keep running. Output is still
    captured, just read back afterwards rather than streamed.
    """
    cmd = [str(c) for c in cmd]
    kwargs = {}
    if hasattr(os, "killpg"):
        kwargs["start_new_session"] = True

    out_file = None
    if detach_output:
        out_file = tempfile.TemporaryFile()
        kwargs["stdout"] = out_file
        kwargs["stderr"] = subprocess.STDOUT
    else:
        kwargs["stdout"] = asyncio.subprocess.PIPE
        kwargs["stderr"] = asyncio.subprocess.PIPE

    try:
        proc = await asyncio.create_subprocess_exec(*cmd, **kwargs)
    except (FileNotFoundError, PermissionError, OSError) as e:
        if out_file is not None:
            out_file.close()
        return subprocess.CompletedProcess(cmd, 127, "", str(e))

    if out_file is not None:
        try:
            await asyncio.wait_for(proc.wait(), timeout)
        except asyncio.TimeoutError:
            _killpg(proc)
            try:
                await asyncio.wait_for(proc.wait(), 5)
            except asyncio.TimeoutError:
                pass
            return subprocess.CompletedProcess(
                cmd, -9, _read_and_close(out_file),
                f"[pi_agent] {cmd[0]} killed after exceeding {timeout}s (process group)",
            )
        return subprocess.CompletedProcess(
            cmd, proc.returncode, _read_and_close(out_file), "",
        )

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        _killpg(proc)
        stdout, stderr = b"", b""
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), 5)
        except (asyncio.TimeoutError, Exception):
            pass
        return subprocess.CompletedProcess(
            cmd, -9, _decode(stdout),
            _decode(stderr) + f"\n[pi_agent] {cmd[0]} killed after exceeding {timeout}s (process group)",
        )

    return subprocess.CompletedProcess(
        cmd, proc.returncode, _decode(stdout), _decode(stderr),
    )


def _read_and_close(out_file):
    """Drain a detach_output temp file. Best-effort: losing the diagnostic
    text must never turn an otherwise successful command into an error."""
    try:
        out_file.seek(0)
        return _decode(out_file.read())
    except OSError:
        return ""
    finally:
        try:
            out_file.close()
        except OSError:
            pass


async def _kill(proc):
    try:
        proc.kill()
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(proc.wait(), 5)
    except asyncio.TimeoutError:
        pass


def _killpg(proc):
    if not hasattr(os, "killpg"):
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        return
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


def _decode(raw):
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    return raw.decode(errors="replace")
