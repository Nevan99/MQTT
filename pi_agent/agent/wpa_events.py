"""Event-driven access to wpa_supplicant's control socket.

`wpa_cli -i wlan1 status` in a poll loop answers "what state is it in now?"
once a second. The control socket answers "tell me the moment it changes",
which is both faster (an association that completes 100ms in is seen at
100ms, not at the next tick) and strictly more informative: the async
events carry the reason codes a status poll never shows.

    CTRL-EVENT-DISCONNECTED bssid=54:7e:1a:18:30:ea reason=3
    CTRL-EVENT-ASSOC-REJECT status_code=17
    CTRL-EVENT-SSID-TEMP-DISABLED ... auth_failures=1

That reason field is the difference between "the AP steered us off" and
"the PSK was wrong" - exactly what the fleet's steering tests need, and
what a poll of wpa_state=DISCONNECTED cannot tell you.

The protocol is small: bind a Unix datagram socket, connect it to
/var/run/wpa_supplicant/<iface>, send ATTACH once, then every unsolicited
event arrives as a datagram prefixed with a priority like "<3>". This is a
minimal pure-Python equivalent of libwpa_client's wpa_ctrl_attach/recv,
with no dependency beyond the stdlib.
"""
import asyncio
import contextlib
import os
import socket
import tempfile

CTRL_DIR = "/var/run/wpa_supplicant"

# Events that mean an association attempt failed for good, so a waiter can
# stop early rather than sitting out its whole timeout. Each carries the
# detail that says *why*, which is the point of listening at all.
FAILURE_EVENTS = (
    "CTRL-EVENT-ASSOC-REJECT",
    "CTRL-EVENT-AUTH-REJECT",
    "CTRL-EVENT-SSID-TEMP-DISABLED",
)


class WpaEventListener:
    """An attached control-socket connection for one interface.

    Not safe to share across tasks: one listener, one consumer. Use as an
    async context manager so the socket and its temporary bind path are
    always cleaned up, including on cancellation.
    """

    def __init__(self, interface, ctrl_dir=None):
        # Resolved at call time, not bound as a default at import time, so
        # the module constant stays overridable (tests point this at a
        # fake socket; a non-standard image could point it elsewhere).
        self.interface = interface
        self.ctrl_path = os.path.join(ctrl_dir or CTRL_DIR, interface)
        self._sock = None
        self._local_path = None
        self._queue = asyncio.Queue()
        self._reader_task = None

    @property
    def available(self):
        return os.path.exists(self.ctrl_path)

    @property
    def closed(self):
        """True once the socket reader has stopped - no more events will
        ever arrive, so a waiter should stop listening and poll instead."""
        return self._reader_task is None or self._reader_task.done()

    async def __aenter__(self):
        await self.attach()
        return self

    async def __aexit__(self, *exc):
        await self.detach()
        return False

    async def attach(self):
        """Bind, connect and register for unsolicited events."""
        self._sock, self._local_path = _open_ctrl_socket(self.interface, self.ctrl_path)

        loop = asyncio.get_running_loop()
        await loop.sock_sendall(self._sock, b"ATTACH")
        reply = await asyncio.wait_for(loop.sock_recv(self._sock, 4096), 5)
        if reply.strip() not in (b"OK", b"OK\n"):
            raise RuntimeError(f"ATTACH refused by wpa_supplicant: {reply!r}")

        self._reader_task = asyncio.create_task(
            self._read_loop(), name=f"wpa-events-{self.interface}",
        )
        return self

    async def _read_loop(self):
        loop = asyncio.get_running_loop()
        try:
            while True:
                data = await loop.sock_recv(self._sock, 4096)
                if not data:
                    break
                await self._queue.put(data.decode(errors="replace").strip())
        except asyncio.CancelledError:
            raise
        except (OSError, RuntimeError):
            pass
        finally:
            # Unblock any waiter rather than leaving it until its timeout.
            await self._queue.put(None)

    async def detach(self):
        if self._reader_task is not None:
            self._reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reader_task
            self._reader_task = None
        if self._sock is not None:
            with contextlib.suppress(OSError):
                self._sock.send(b"DETACH")
            self._sock.close()
            self._sock = None
        if self._local_path is not None:
            with contextlib.suppress(OSError):
                os.unlink(self._local_path)
            self._local_path = None

    async def events(self, timeout=None):
        """Yield event lines as they arrive, until `timeout` elapses."""
        loop = asyncio.get_running_loop()
        deadline = None if timeout is None else loop.time() + timeout
        while True:
            remaining = None if deadline is None else deadline - loop.time()
            if remaining is not None and remaining <= 0:
                return
            try:
                event = await asyncio.wait_for(self._queue.get(), remaining)
            except asyncio.TimeoutError:
                return
            if event is None:      # reader ended
                return
            yield event

    async def request(self, command, timeout=5):
        """Send a control command and read its reply.

        Replies and unsolicited events share this socket; async events are
        prefixed with a priority (`<3>`), replies are not, so anything
        prefixed is requeued rather than mistaken for the answer.
        """
        loop = asyncio.get_running_loop()
        await loop.sock_sendall(self._sock, command.encode())
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            data = await asyncio.wait_for(
                loop.sock_recv(self._sock, 4096), deadline - loop.time(),
            )
            text = data.decode(errors="replace").strip()
            if text.startswith("<"):
                await self._queue.put(text)
                continue
            return text
        raise asyncio.TimeoutError(f"no reply to {command!r}")


def _open_ctrl_socket(interface, ctrl_path):
    """Bound, connected, non-blocking datagram socket to a wpa_supplicant
    control interface. Returns (sock, local_path); the caller owns both."""
    if not hasattr(socket, "AF_UNIX"):
        raise RuntimeError("wpa_supplicant control sockets need AF_UNIX")

    # wpa_supplicant replies to the *bound* path, so the local socket
    # needs a real filesystem name, unique per connection.
    fd, local_path = tempfile.mkstemp(prefix=f"wpa_ctrl_{interface}_")
    os.close(fd)
    os.unlink(local_path)

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    try:
        sock.bind(local_path)
        sock.setblocking(False)
        sock.connect(ctrl_path)
    except OSError:
        sock.close()
        with contextlib.suppress(OSError):
            os.unlink(local_path)
        raise
    return sock, local_path


class WpaCtrlConnection:
    """A plain (never ATTACHed) control-socket connection for sending
    commands like STATUS directly, instead of spawning `wpa_cli` for each
    one - a wait loop re-reading state every couple of seconds would
    otherwise start a fresh process every time.

    Deliberately separate from WpaEventListener: that socket is ATTACHed,
    so its background reader would swallow command replies along with the
    events. A socket that never ATTACHes gets nothing unsolicited, so every
    datagram on it is the reply to the command just sent.
    """

    def __init__(self, interface, ctrl_dir=None):
        self.interface = interface
        self.ctrl_path = os.path.join(ctrl_dir or CTRL_DIR, interface)
        self._sock = None
        self._local_path = None
        self._lock = asyncio.Lock()

    def open(self):
        self._sock, self._local_path = _open_ctrl_socket(self.interface, self.ctrl_path)
        return self

    def close(self):
        if self._sock is not None:
            self._sock.close()
            self._sock = None
        if self._local_path is not None:
            with contextlib.suppress(OSError):
                os.unlink(self._local_path)
            self._local_path = None

    async def request(self, command, timeout=5):
        """Send one command and return its reply text. Raises OSError /
        asyncio.TimeoutError if wpa_supplicant can't be reached."""
        loop = asyncio.get_running_loop()
        async with self._lock:
            # Drop anything left over from an earlier request that timed
            # out, so its late reply can't be read as this one's.
            with contextlib.suppress(BlockingIOError, InterruptedError):
                while self._sock.recv(4096):
                    pass
            await loop.sock_sendall(self._sock, command.encode())
            data = await asyncio.wait_for(loop.sock_recv(self._sock, 8192), timeout)
        return data.decode(errors="replace")


def parse_status(text):
    """`STATUS` reply (key=value lines) -> dict, same shape as parsing
    `wpa_cli status` output."""
    status = {}
    for line in text.splitlines():
        key, sep, value = line.partition("=")
        if sep:
            status[key] = value
    return status


def parse_event(line):
    """Split one event line into (name, fields).

    "<3>CTRL-EVENT-DISCONNECTED bssid=54:7e:1a:18:30:ea reason=3"
      -> ("CTRL-EVENT-DISCONNECTED", {"bssid": "54:7e:1a:18:30:ea", "reason": "3"})
    """
    text = line
    if text.startswith("<") and ">" in text:
        text = text.split(">", 1)[1]
    parts = text.split()
    if not parts:
        return "", {}
    name = parts[0]
    fields = {}
    for token in parts[1:]:
        if "=" in token:
            key, _, value = token.partition("=")
            fields[key] = value
    return name, fields
