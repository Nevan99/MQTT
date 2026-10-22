import asyncio
import json
from datetime import datetime, timezone

from . import proc as proc_mod


class StreamingMixin:
    """Live view streaming (syslog/tcpdump over a socket to the backend),
    pcap capture recording, and the throughput/syslog-dump one-shot actions.
    See PiAgent (core.py) for the locks/state this relies on
    (self._pcap_*, self._streaming_*, self._tcpdump_*).

    Every relay here used to be a daemon thread blocked on a pipe read and a
    blocking socket send. They are asyncio tasks now, reading the child's
    StreamReader and writing to an asyncio StreamWriter - so a stalled
    backend socket parks a task instead of pinning a thread, and a capture
    that never gets stopped can be cancelled rather than leaked.
    """

    # tcpdump fails fast on a bad interface or missing capture permissions
    # (needs root or cap_net_raw+cap_net_admin). Both start paths wait this
    # long and then check the process is still alive, so a start doesn't
    # report success for a tcpdump that already died.
    TCPDUMP_STARTUP_GRACE_SECONDS = 0.3

    async def run_iperf_server_test(self, duration=10, interface=None):
        """Runs the throughput test against the broker host. Without an
        interface, iperf3 goes out over whatever the OS routing table picks
        for that destination - same as before. With one, `-B <local-ip>%
        <interface>` both binds the client socket to that interface's own
        address AND sets SO_BINDTODEVICE (the `%<interface>` suffix, Linux-
        only, needs root - which this agent already runs as) on it.

        The plain `-B <local-ip>` form (no `%<interface>`) only fixes the
        socket's *source address* - it does not force the packet's physical
        egress interface. On a Pi with several interfaces that can all
        route to the broker (a wired eth0 plus several wifi radios, same as
        the docstring above already warned about for the no-interface
        case), the kernel's normal destination-based route lookup can still
        pick a *different*, faster interface and just stamp the requested
        address on as the source - so a throughput test "pinned" to a
        wifi radio capped by connect_wifi's max_standard could silently
        measure a completely different link's speed instead (confirmed via
        `iw dev <if> link` staying at the radio's real, capped rate for the
        whole test while iperf reported several times that rate). The
        %<interface> suffix closes that gap by actually binding the socket
        to the device, not just its address.
        """
        cmd = ["iperf3", "-c", self.broker_host, "-t", str(duration), "-J"]
        if interface:
            bind_ip = await self.get_interface_ip(interface)
            if not bind_ip:
                return {"error": f"{interface} has no IPv4 address to bind to"}
            cmd += ["-B", f"{bind_ip}%{interface}"]
        result = await proc_mod.run(cmd, timeout=duration + 15)
        data = json.loads(result.stdout)
        return {
            "interface": interface,
            "throughput_mbps": data["end"]["sum_received"]["bits_per_second"] / 1e6,
            "retransmits": data["end"]["sum_sent"].get("retransmits"),
        }

    async def get_syslog(self, lines=100):
        """Pull recent journal lines."""
        out = (await proc_mod.run(["journalctl", "-n", str(lines), "--no-pager"])).stdout
        return out.splitlines()

    # --- shared helpers ---------------------------------------------------

    async def _open_capture_socket(self, header):
        """Connect to the backend's capture socket server and send the
        newline-terminated header that tells it what this stream is."""
        reader, writer = await asyncio.open_connection(
            self.capture_socket_host, self.capture_socket_port,
        )
        writer.write((json.dumps(header) + "\n").encode())
        await writer.drain()
        return reader, writer

    async def _spawn_tcpdump(self, interface):
        """Start tcpdump writing raw pcap to stdout, and confirm it survived
        startup before the caller commits to it."""
        process = await asyncio.create_subprocess_exec(
            "tcpdump", "-i", interface, "-w", "-", "-U",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        await asyncio.sleep(self.TCPDUMP_STARTUP_GRACE_SECONDS)
        if process.returncode is not None:
            err = b""
            if process.stderr is not None:
                try:
                    err = await asyncio.wait_for(process.stderr.read(), 2)
                except asyncio.TimeoutError:
                    pass
            output = err.decode(errors="replace").strip()
            raise RuntimeError(output or f"tcpdump exited immediately (code {process.returncode})")
        return process

    @staticmethod
    async def _terminate(process, timeout=10):
        if process is None or process.returncode is not None:
            return
        try:
            process.terminate()
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(process.wait(), timeout)
        except asyncio.TimeoutError:
            try:
                process.kill()
                await asyncio.wait_for(process.wait(), 5)
            except (ProcessLookupError, asyncio.TimeoutError):
                pass

    @staticmethod
    def _track(task_set, task):
        task_set.add(task)
        task.add_done_callback(task_set.discard)
        return task

    # --- pcap capture (recorded) -----------------------------------------

    async def start_pcap_capture(self, interface, name=None):
        """Start a pcap capture for one interface, piped live to the backend's
        capture socket server as tcpdump produces it - independent of the
        parsed-line tcpdump stream (both can run on the same interface at
        once). Streaming continuously instead of writing to a local file
        means stop only has to close a socket, not upload a whole finished
        file - that upload-at-the-end approach was why stopping a capture
        used to take so long."""
        async with self._pcap_lock:
            if interface in self._pcap_procs:
                old_process = self._pcap_procs[interface]
                old_state = self._pcap_state.get(interface)
                # Only a capture that's still recording blocks a new one. If
                # tcpdump exited or the upload socket died (e.g. the backend
                # restarted), its relay task has already finished and the
                # backend no longer knows about it - drop the stale entry
                # instead of answering "already running" forever.
                # The backend never sends anything before its final ack, so
                # EOF on the reader means its end of the socket is gone -
                # the only sign of that on a quiet interface, where nothing
                # gets written that would fail.
                relay_done = old_state is not None and old_state["done"].is_set()
                backend_gone = old_state is not None and old_state["reader"].at_eof()
                if old_process.returncode is None and not relay_done and not backend_gone:
                    return False
                self._pcap_procs.pop(interface, None)
                self._pcap_state.pop(interface, None)
                if old_process.returncode is None:
                    await self._terminate(old_process)
            process = await self._spawn_tcpdump(interface)

            capture_name = name or f"{self.pi_id}-pcap-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}"
            try:
                reader, writer = await self._open_capture_socket({
                    "kind": "record", "pi_id": self.pi_id,
                    "name": capture_name, "interface": interface,
                })
            except Exception:
                await self._terminate(process)
                raise

            state = {
                "error": None, "capture_id": None, "byte_count": 0,
                "done": asyncio.Event(), "reader": reader,
            }
            task = asyncio.create_task(
                self._relay_pcap(process, reader, writer, state), name=f"pcap-relay-{interface}",
            )
            self._track(self._background_tasks, task)

            self._pcap_procs[interface] = process
            self._pcap_state[interface] = state
        return True

    async def _relay_pcap(self, process, reader, writer, state):
        """Pump tcpdump's stdout into the capture socket until tcpdump exits
        (stdout hits EOF), then half-close the socket and read the backend's
        ack off the same connection."""
        try:
            while True:
                chunk = await process.stdout.read(65536)
                if not chunk:
                    break
                writer.write(chunk)
                await writer.drain()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            state["error"] = str(e)
        finally:
            try:
                # Half-close so the backend sees EOF and answers with its
                # ack on the same connection.
                if writer.can_write_eof():
                    writer.write_eof()
            except OSError:
                pass
            try:
                ack_line = await asyncio.wait_for(reader.readline(), 15)
                ack = json.loads(ack_line) if ack_line else {}
                state["capture_id"] = ack.get("capture_id")
                state["byte_count"] = ack.get("byte_count", 0)
                if ack.get("error"):
                    state["error"] = state["error"] or ack["error"]
            except Exception as e:
                state["error"] = state["error"] or str(e)
            finally:
                writer.close()
                try:
                    await writer.wait_closed()
                except Exception:
                    pass
                state["done"].set()

    async def stop_pcap_capture(self, interface):
        """Stop the pcap capture for an interface and return the saved
        capture's metadata once the relay task's socket stream finishes."""
        async with self._pcap_lock:
            process = self._pcap_procs.pop(interface, None)
            state = self._pcap_state.pop(interface, None)
        if process is None:
            return {"error": f"no pcap capture running on {interface}"}

        await self._terminate(process)

        try:
            await asyncio.wait_for(state["done"].wait(), 15)
        except asyncio.TimeoutError:
            return {"error": "timed out waiting for the capture upload to finish", "interface": interface}

        if state["error"]:
            return {"error": state["error"], "interface": interface}

        return {
            "interface": interface,
            "byte_count": state["byte_count"],
            "capture_id": state["capture_id"],
            "saved": True,
        }

    # --- tcpdump live view -------------------------------------------------

    async def _stream_tcpdump_socket(self, interface, process, state):
        """Pump this view-only tcpdump process's stdout to the backend over
        a socket connection tagged kind=stream_tcpdump - decoded to text and
        relayed live by the backend, never written to a capture file (that's
        start_pcap_capture's job, a wholly separate tcpdump process)."""
        writer = None
        try:
            _, writer = await self._open_capture_socket({
                "kind": "stream_tcpdump", "pi_id": self.pi_id, "interface": interface,
            })
            while True:
                # Small read size (vs. 65536) so packets on a quiet
                # interface get forwarded as soon as tcpdump -U flushes
                # them, instead of sitting in the pipe until a large chunk
                # fills up.
                chunk = await process.stdout.read(4096)
                if not chunk:
                    break
                writer.write(chunk)
                await writer.drain()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            state["error"] = str(e)
        finally:
            if writer is not None:
                writer.close()
                try:
                    await writer.wait_closed()
                except Exception:
                    pass
            async with self._tcpdump_lock:
                self._tcpdump_running.discard(interface)
                self._tcpdump_procs.pop(interface, None)

    async def start_tcpdump_stream(self, interface):
        """Start a live decoded-tcpdump view for one interface, no-op if
        already running. Independent of start_pcap_capture - both can run
        on the same interface at once, one for viewing, one for saving."""
        async with self._tcpdump_lock:
            if interface in self._tcpdump_running:
                return False
            process = await self._spawn_tcpdump(interface)
            state = {"error": None}
            self._tcpdump_running.add(interface)
            self._tcpdump_procs[interface] = process
        task = asyncio.create_task(
            self._stream_tcpdump_socket(interface, process, state),
            name=f"tcpdump-stream-{interface}",
        )
        self._track(self._background_tasks, task)
        return True

    async def stop_tcpdump_stream(self, interface):
        """Stop the tcpdump view for one interface, if running."""
        async with self._tcpdump_lock:
            if interface not in self._tcpdump_running:
                return False
            self._tcpdump_running.discard(interface)
            process = self._tcpdump_procs.pop(interface, None)
        await self._terminate(process)
        return True

    # --- syslog live view --------------------------------------------------

    async def _stream_syslog_socket(self, process):
        """Pump journalctl -f's output to the backend over a socket
        connection tagged kind=stream_syslog - relayed live as text lines,
        never persisted (same "view only" contract as stream_tcpdump)."""
        writer = None
        try:
            _, writer = await self._open_capture_socket({
                "kind": "stream_syslog", "pi_id": self.pi_id,
            })
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                writer.write(line.rstrip(b"\n") + b"\n")
                await writer.drain()
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        finally:
            if writer is not None:
                writer.close()
                try:
                    await writer.wait_closed()
                except Exception:
                    pass
            async with self._streaming_lock:
                if self._syslog_proc is process:
                    self._streaming_started = False
                    self._syslog_proc = None

    async def start_syslog_stream(self):
        """Start the syslog streaming task: the pi-agent daemon's own
        journal, whole-daemon (not per interface)."""
        cmd = ["journalctl", "-u", "pi-agent.service", "-l", "-f", "--no-pager"]

        async with self._streaming_lock:
            if self._streaming_started:
                return False
            self._streaming_started = True

        # StreamReader.readline yields each journal line as soon as
        # journalctl writes it - the asyncio equivalent of the bufsize=1
        # line buffering this used under Popen, which existed so lines
        # weren't held back until a full block accumulated on the pipe.
        process = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE,
        )
        async with self._streaming_lock:
            self._syslog_proc = process
        task = asyncio.create_task(
            self._stream_syslog_socket(process), name="syslog-stream",
        )
        self._track(self._background_tasks, task)
        return True

    async def stop_syslog_stream(self):
        """Stop the syslog streaming task, if running."""
        async with self._streaming_lock:
            if not self._streaming_started:
                return False
            self._streaming_started = False
            process = self._syslog_proc
            self._syslog_proc = None
        await self._terminate(process)
        return True
