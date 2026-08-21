"""Concurrency semantics: who waits for whom on an interface.

This is the file the async conversion most needs to keep passing. The
assertions are deliberately about observable behavior (elapsed time,
ordering, which commands ran) rather than about threading.Lock specifically,
so they stay meaningful once the locks become asyncio.Locks.
"""
import threading
import time

import conftest
from conftest import FULL_SCAN_SECONDS


def run_concurrently(first, second, gap=0.2):
    """Starts `first` in a thread, waits `gap`, then runs `second` inline.
    Returns how long `second` took to get going."""
    t = threading.Thread(target=first)
    t.start()
    time.sleep(gap)
    t0 = time.time()
    second()
    elapsed = time.time() - t0
    t.join()
    return elapsed


class TestCommandsAreNotStarvedByScans:
    def test_command_does_not_wait_for_a_background_scan_cycle(self, agent):
        """The regression this whole design exists for: a disconnect
        arriving mid-scan-cycle used to block for the scan's full duration."""
        def scan_cycle():
            agent._wifi_background_scan_one("wlan1")

        def command():
            with agent._wifi_pending_command("wlan1"):
                lock = agent._wifi_lock_for("wlan1")
                lock.acquire()
                lock.release()

        waited = run_concurrently(scan_cycle, command, gap=0.05)
        assert waited < 0.5, f"command stalled {waited:.2f}s behind a scan cycle"

    def test_a_queued_command_makes_the_next_scan_cycle_skip(self, agent, fake_cmds):
        """The lock is deliberately left FREE here.

        This is the exact window the pending flag exists for: a command has
        been dispatched and is about to take the lock, but hasn't yet - so
        it holds nothing, and the scanner's non-blocking acquire would
        succeed and cut ahead of it. Holding the lock in this test instead
        would pass even with the pending check deleted, since the acquire
        alone would then do the skipping."""
        assert agent._wifi_lock_for("wlan1").acquire(blocking=False), "lock must be free for this test"
        agent._wifi_lock_for("wlan1").release()

        with agent._wifi_pending_command("wlan1"):
            fake_cmds.clear()
            agent._wifi_background_scan_one("wlan1")
            assert fake_cmds.commands() == [], "scan ran despite a queued command"

    def test_a_queued_command_wins_the_race_for_a_free_lock(self, agent, fake_cmds):
        """End-to-end version of the above: a command that is dispatched
        while the lock is free must not have a scan cycle jump in front of
        it and take the radio."""
        order = []

        def command():
            with agent._wifi_pending_command("wlan1"):
                time.sleep(0.1)          # the gap before it acquires
                lock = agent._wifi_lock_for("wlan1")
                lock.acquire()
                try:
                    order.append("command")
                finally:
                    lock.release()

        t = threading.Thread(target=command)
        t.start()
        time.sleep(0.02)                 # scan cycle fires inside that gap
        fake_cmds.clear()
        agent._wifi_background_scan_one("wlan1")
        if fake_cmds.commands():
            order.append("scan")
        t.join()

        assert order == ["command"], f"scan cut ahead of a queued command: {order}"

    def test_scan_skips_while_a_command_holds_the_lock(self, agent, fake_cmds):
        lock = agent._wifi_lock_for("wlan1")
        lock.acquire()
        try:
            fake_cmds.clear()
            agent._wifi_background_scan_one("wlan1")
            assert fake_cmds.commands() == []
        finally:
            lock.release()

    def test_scan_runs_normally_when_nothing_is_pending(self, agent, fake_cmds):
        fake_cmds.clear()
        agent._wifi_background_scan_one("wlan1")
        assert fake_cmds.ran("scan trigger")


class TestPendingCounter:
    def test_pending_is_visible_while_held_and_cleared_after(self, agent):
        assert agent._wifi_command_pending("wlan1") is False
        with agent._wifi_pending_command("wlan1"):
            assert agent._wifi_command_pending("wlan1") is True
        assert agent._wifi_command_pending("wlan1") is False

    def test_nested_commands_do_not_clear_each_other(self, agent):
        """Two commands queued on the same interface: the first to finish
        must not clear the flag out from under the second."""
        with agent._wifi_pending_command("wlan1"):
            with agent._wifi_pending_command("wlan1"):
                assert agent._wifi_command_pending("wlan1") is True
            assert agent._wifi_command_pending("wlan1") is True
        assert agent._wifi_command_pending("wlan1") is False

    def test_pending_clears_even_if_the_command_raises(self, agent):
        try:
            with agent._wifi_pending_command("wlan1"):
                raise RuntimeError("boom")
        except RuntimeError:
            pass
        assert agent._wifi_command_pending("wlan1") is False

    def test_pending_is_per_interface(self, agent):
        with agent._wifi_pending_command("wlan1"):
            assert agent._wifi_command_pending("wlan1") is True
            assert agent._wifi_command_pending("wlan2") is False


class TestInterfaceIsolation:
    def test_two_interfaces_do_not_block_each_other(self, agent, fake_cmds):
        """Different radios must run fully in parallel - this is what makes
        4-interfaces-per-Pi viable."""
        fake_cmds.register("iw dev wlan1 scan", stdout="", duration=FULL_SCAN_SECONDS)

        def slow_on_wlan1():
            lock = agent._wifi_lock_for("wlan1")
            lock.acquire()
            try:
                time.sleep(1.0)
            finally:
                lock.release()

        def command_on_wlan2():
            with agent._wifi_pending_command("wlan2"):
                lock = agent._wifi_lock_for("wlan2")
                lock.acquire()
                lock.release()

        waited = run_concurrently(slow_on_wlan1, command_on_wlan2, gap=0.1)
        assert waited < 0.2, "wlan2 was blocked by work on wlan1"

    def test_same_interface_commands_serialise(self, agent):
        """Two commands on one interface must not overlap - they'd race on
        the same radio state."""
        overlapping = []
        active = []
        guard = threading.Lock()

        def command(hold):
            lock = agent._wifi_lock_for("wlan1")
            lock.acquire()
            try:
                with guard:
                    active.append(1)
                    if len(active) > 1:
                        overlapping.append(True)
                time.sleep(hold)
                with guard:
                    active.pop()
            finally:
                lock.release()

        threads = [threading.Thread(target=command, args=(0.2,)) for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not overlapping, "two commands held the same interface at once"


class TestDispatch:
    def test_dispatch_publishes_result_with_correlation_fields(self, agent):
        done = threading.Event()

        def fake_command(interface):
            return {"interface": interface, "ok": True}

        agent._dispatch_wifi_command("connect_wifi", "cmd-123", "wlan1", fake_command, "wlan1")
        assert conftest.wait_for(lambda: conftest.published_results(agent))

        result = conftest.published_results(agent)[0]
        assert result["command_id"] == "cmd-123"
        assert result["action"] == "connect_wifi"
        assert result["pi_id"] == agent.pi_id
        assert result["ok"] is True
        assert "timestamp" in result

    def test_dispatch_reports_an_exception_as_an_error_result(self, agent):
        def exploding(interface):
            raise RuntimeError("nmcli went missing")

        agent._dispatch_wifi_command("connect_wifi", "cmd-1", "wlan1", exploding, "wlan1")
        assert conftest.wait_for(lambda: conftest.published_results(agent))

        result = conftest.published_results(agent)[0]
        assert result["error"] == "nmcli went missing"
        assert result["command_id"] == "cmd-1"

    def test_dispatch_releases_the_lock_after_a_failure(self, agent):
        """A raised command must not deadlock every later command on that
        interface."""
        def exploding(interface):
            raise RuntimeError("boom")

        agent._dispatch_wifi_command("connect_wifi", "c1", "wlan1", exploding, "wlan1")
        assert conftest.wait_for(lambda: conftest.published_results(agent))

        lock = agent._wifi_lock_for("wlan1")
        assert lock.acquire(blocking=False), "lock was left held after a failure"
        lock.release()
        assert agent._wifi_command_pending("wlan1") is False

    def test_dispatch_does_not_block_the_caller(self, agent):
        """It runs off the MQTT network thread - the point is that paho's
        keepalive keeps ticking while a slow command runs."""
        def slow(interface):
            time.sleep(1.0)
            return {"ok": True}

        t0 = time.time()
        agent._dispatch_wifi_command("connect_wifi", "c1", "wlan1", slow, "wlan1")
        assert time.time() - t0 < 0.2
