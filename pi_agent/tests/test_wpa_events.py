"""The wpa_supplicant control-socket listener that replaced status polling.

The socket half needs AF_UNIX, so those tests are skipped on Windows. The
parsing and the _wait_for_wpa_state integration run everywhere, since those
are where the behavior that matters lives.
"""
import asyncio
import os
import socket
import sys
import tempfile

import pytest

import conftest
from agent import wpa_events

needs_unix = pytest.mark.skipif(
    not hasattr(socket, "AF_UNIX"), reason="wpa control sockets need AF_UNIX",
)


class TestParseEvent:
    def test_strips_the_priority_prefix(self):
        name, fields = wpa_events.parse_event("<3>CTRL-EVENT-CONNECTED")
        assert name == "CTRL-EVENT-CONNECTED"
        assert fields == {}

    def test_extracts_the_disconnect_reason(self):
        """The whole point of listening: a status poll shows
        wpa_state=DISCONNECTED but never says why."""
        name, fields = wpa_events.parse_event(
            "<3>CTRL-EVENT-DISCONNECTED bssid=54:7e:1a:18:30:ea reason=3 locally_generated=1"
        )
        assert name == "CTRL-EVENT-DISCONNECTED"
        assert fields["bssid"] == "54:7e:1a:18:30:ea"
        assert fields["reason"] == "3"
        assert fields["locally_generated"] == "1"

    def test_extracts_an_assoc_reject_status_code(self):
        name, fields = wpa_events.parse_event("<3>CTRL-EVENT-ASSOC-REJECT status_code=17")
        assert name == "CTRL-EVENT-ASSOC-REJECT"
        assert fields["status_code"] == "17"

    def test_handles_a_line_with_no_prefix(self):
        name, _ = wpa_events.parse_event("CTRL-EVENT-SCAN-STARTED")
        assert name == "CTRL-EVENT-SCAN-STARTED"

    def test_handles_an_empty_line(self):
        assert wpa_events.parse_event("") == ("", {})

    def test_ignores_bare_tokens_without_a_value(self):
        name, fields = wpa_events.parse_event("<3>CTRL-EVENT-BSS-ADDED 7 54:7e:1a:18:30:ea")
        assert name == "CTRL-EVENT-BSS-ADDED"
        assert fields == {}


class FakeSupplicant:
    """A stand-in wpa_supplicant control socket.

    Answers ATTACH, then pushes whatever events the test scripts back to
    whichever address attached - the same datagram protocol the real one
    speaks.
    """

    def __init__(self, directory, interface):
        self.path = os.path.join(directory, interface)
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        self.sock.bind(self.path)
        self.sock.setblocking(False)
        self.peer = None
        self._task = None

    async def serve(self):
        loop = asyncio.get_running_loop()
        while True:
            try:
                data, addr = await loop.sock_recvfrom(self.sock, 4096)
            except (BlockingIOError, InterruptedError):
                await asyncio.sleep(0.01)
                continue
            except OSError:
                return
            if data == b"ATTACH":
                self.peer = addr
                self.sock.sendto(b"OK\n", addr)
            elif data == b"DETACH":
                self.sock.sendto(b"OK\n", addr)
            elif data == b"STATUS":
                self.sock.sendto(b"wpa_state=SCANNING\n", addr)

    def start(self):
        self._task = asyncio.create_task(self.serve())
        return self

    def emit(self, line):
        assert self.peer is not None, "nothing attached yet"
        self.sock.sendto(line.encode(), self.peer)

    async def close(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self.sock.close()
        try:
            os.unlink(self.path)
        except OSError:
            pass


@needs_unix
class TestListener:
    async def test_attach_and_receive_events(self):
        with tempfile.TemporaryDirectory() as d:
            fake = FakeSupplicant(d, "wlan1").start()
            try:
                listener = wpa_events.WpaEventListener("wlan1", ctrl_dir=d)
                assert listener.available
                async with listener:
                    await asyncio.sleep(0.05)
                    fake.emit("<3>CTRL-EVENT-CONNECTED - Connection to 54:7e:1a:18:30:ea completed")

                    received = []
                    async for line in listener.events(timeout=2):
                        received.append(line)
                        break
                    assert "CTRL-EVENT-CONNECTED" in received[0]
            finally:
                await fake.close()

    async def test_events_stops_at_its_timeout(self):
        with tempfile.TemporaryDirectory() as d:
            fake = FakeSupplicant(d, "wlan1").start()
            try:
                async with wpa_events.WpaEventListener("wlan1", ctrl_dir=d) as listener:
                    loop = asyncio.get_running_loop()
                    t0 = loop.time()
                    got = [line async for line in listener.events(timeout=0.3)]
                    assert got == []
                    assert loop.time() - t0 < 1.0
            finally:
                await fake.close()

    async def test_detach_cleans_up_the_bind_path(self):
        with tempfile.TemporaryDirectory() as d:
            fake = FakeSupplicant(d, "wlan1").start()
            try:
                listener = wpa_events.WpaEventListener("wlan1", ctrl_dir=d)
                await listener.attach()
                local = listener._local_path
                assert os.path.exists(local)
                await listener.detach()
                assert not os.path.exists(local), "left a socket file behind"
            finally:
                await fake.close()

    async def test_unavailable_when_no_socket_exists(self):
        with tempfile.TemporaryDirectory() as d:
            assert not wpa_events.WpaEventListener("wlan1", ctrl_dir=d).available


class TestWaitForWpaState:
    """_wait_for_wpa_state's contract, independent of which mechanism it
    used to get there."""

    async def test_falls_back_to_polling_without_a_control_socket(self, agent, fake_cmds, monkeypatch):
        monkeypatch.setattr(wpa_events.WpaEventListener, "available", property(lambda self: False))
        fake_cmds.register("wpa_cli -i wlan1 status", stdout="wpa_state=COMPLETED\n")

        assert await agent._wait_for_wpa_state("wlan1", "COMPLETED", timeout=5) is True
        assert fake_cmds.ran("wpa_cli -i wlan1 status")

    async def test_polling_gives_up_at_the_timeout(self, agent, fake_cmds, monkeypatch):
        monkeypatch.setattr(wpa_events.WpaEventListener, "available", property(lambda self: False))
        fake_cmds.register("wpa_cli -i wlan1 status", stdout="wpa_state=4WAY_HANDSHAKE\n")

        loop = asyncio.get_running_loop()
        t0 = loop.time()
        assert await agent._wait_for_wpa_state("wlan1", "COMPLETED", timeout=1.5) is False
        assert loop.time() - t0 < 4

    @needs_unix
    async def test_returns_as_soon_as_connected_arrives(self, agent, fake_cmds, monkeypatch):
        """The latency win: _wait_for_wpa_state returns on the event, not on
        the next poll tick. Patching CTRL_DIR is enough to point the real
        listener at the fake socket, since that is where it looks."""
        with tempfile.TemporaryDirectory() as d:
            monkeypatch.setattr(wpa_events, "CTRL_DIR", d)
            fake = FakeSupplicant(d, "wlan1").start()
            try:
                # Polling would never succeed here, so a pass proves the
                # event path is what returned.
                fake_cmds.register("wpa_cli -i wlan1 status", stdout="wpa_state=SCANNING\n")

                async def emit_soon():
                    await asyncio.sleep(0.2)
                    fake.emit("<3>CTRL-EVENT-CONNECTED - Connection completed")

                loop = asyncio.get_running_loop()
                t0 = loop.time()
                emitter = asyncio.create_task(emit_soon())
                result = await agent._wait_for_wpa_state("wlan1", "COMPLETED", timeout=5)
                elapsed = loop.time() - t0
                await emitter

                assert result is True
                assert elapsed < 1.0, f"took {elapsed:.2f}s - no better than polling"
            finally:
                await fake.close()

    async def test_assoc_reject_is_recorded_as_a_failure_reason(self, agent, monkeypatch):
        """A wrong-PSK or rejected association should surface *why*, not
        just 'not connected'."""
        class StubListener:
            def __init__(self, interface, ctrl_dir=None):
                pass
            available = True
            async def attach(self):
                return self
            async def detach(self):
                pass
            async def events(self, timeout=None):
                yield "<3>CTRL-EVENT-ASSOC-REJECT status_code=17"

        monkeypatch.setattr(wpa_events, "WpaEventListener", StubListener)

        assert await agent._wait_for_wpa_state("wlan1", "COMPLETED", timeout=5) is False
        assert "CTRL-EVENT-ASSOC-REJECT" in agent.last_wpa_failure
        assert "status_code=17" in agent.last_wpa_failure

    async def test_failure_reason_reaches_the_connect_result(self, agent, fake_cmds, monkeypatch):
        monkeypatch.setattr(type(agent), "_wpa_ctrl_socket_exists", lambda self, i: True)
        fake_cmds.register("wpa_cli -i wlan1 add_network", stdout="0\n")

        async def rejected(self, interface, target, timeout=60):
            self.last_wpa_failure = "CTRL-EVENT-ASSOC-REJECT status_code=17"
            return False
        monkeypatch.setattr(type(agent), "_wait_for_wpa_state", rejected)

        result = await agent.connect_wifi("Telia-test", "wrong", "wlan1")

        assert result["connected"] is False
        assert result["failure_reason"] == "CTRL-EVENT-ASSOC-REJECT status_code=17"

    async def test_failure_reason_is_cleared_between_attempts(self, agent, fake_cmds, monkeypatch):
        """A stale reason from a previous connect must not be reported
        against a later, successful one."""
        monkeypatch.setattr(wpa_events.WpaEventListener, "available", property(lambda self: False))
        agent.last_wpa_failure = "CTRL-EVENT-ASSOC-REJECT status_code=17"
        fake_cmds.register("wpa_cli -i wlan1 status", stdout="wpa_state=COMPLETED\n")

        assert await agent._wait_for_wpa_state("wlan1", "COMPLETED", timeout=5) is True
        assert agent.last_wpa_failure is None
