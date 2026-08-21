"""Concurrency semantics: who waits for whom on an interface.

This is the file the async conversion most needed to keep passing. The
assertions are about observable behavior - elapsed time, ordering, which
commands ran - not about the locking primitive, which is exactly why they
survived the move from threading.Lock to asyncio.Lock: the threads became
tasks and the acquires became `async with`, but what is being asserted did
not change.
"""
import asyncio

import conftest
from conftest import FULL_SCAN_SECONDS


async def run_concurrently(first, second, gap=0.2):
    """Starts `first` as a task, waits `gap`, then awaits `second`.
    Returns how long `second` took to get going."""
    task = asyncio.create_task(first())
    await asyncio.sleep(gap)
    loop = asyncio.get_running_loop()
    t0 = loop.time()
    await second()
    elapsed = loop.time() - t0
    await task
    return elapsed


class TestCommandsAreNotStarvedByScans:
    async def test_command_does_not_wait_for_a_background_scan_cycle(self, agent):
        """The regression this whole design exists for: a disconnect
        arriving mid-scan-cycle used to block for the scan's full duration."""
        async def scan_cycle():
            await agent._wifi_background_scan_one("wlan1")

        async def command():
            async with agent._wifi_pending_command("wlan1"):
                async with agent._wifi_lock_for("wlan1"):
                    pass

        waited = await run_concurrently(scan_cycle, command, gap=0.05)
        assert waited < 0.5, f"command stalled {waited:.2f}s behind a scan cycle"

    async def test_a_queued_command_makes_the_next_scan_cycle_skip(self, agent, fake_cmds):
        """The lock is deliberately left FREE here.

        This is the exact window the pending flag exists for: a command has
        been dispatched and is about to take the lock, but hasn't yet - so
        it holds nothing, and the scanner's `locked()` check would pass and
        let it cut ahead. Holding the lock in this test instead would pass
        even with the pending check deleted, since the locked() check alone
        would then do the skipping."""
        assert not agent._wifi_lock_for("wlan1").locked(), "lock must be free for this test"

        async with agent._wifi_pending_command("wlan1"):
            fake_cmds.clear()
            await agent._wifi_background_scan_one("wlan1")
            assert fake_cmds.commands() == [], "scan ran despite a queued command"

    async def test_a_queued_command_wins_the_race_for_a_free_lock(self, agent, fake_cmds):
        """End-to-end version of the above: a command dispatched while the
        lock is free must not have a scan cycle jump in front of it."""
        order = []

        async def command():
            async with agent._wifi_pending_command("wlan1"):
                await asyncio.sleep(0.1)        # the gap before it acquires
                async with agent._wifi_lock_for("wlan1"):
                    order.append("command")

        task = asyncio.create_task(command())
        await asyncio.sleep(0.02)               # scan fires inside that gap
        fake_cmds.clear()
        await agent._wifi_background_scan_one("wlan1")
        if fake_cmds.commands():
            order.append("scan")
        await task

        assert order == ["command"], f"scan cut ahead of a queued command: {order}"

    async def test_scan_skips_while_a_command_holds_the_lock(self, agent, fake_cmds):
        async with agent._wifi_lock_for("wlan1"):
            fake_cmds.clear()
            await agent._wifi_background_scan_one("wlan1")
            assert fake_cmds.commands() == []

    async def test_scan_runs_normally_when_nothing_is_pending(self, agent, fake_cmds):
        fake_cmds.clear()
        await agent._wifi_background_scan_one("wlan1")
        assert fake_cmds.ran("scan trigger")


class TestPendingCounter:
    async def test_pending_is_visible_while_held_and_cleared_after(self, agent):
        assert agent._wifi_command_pending("wlan1") is False
        async with agent._wifi_pending_command("wlan1"):
            assert agent._wifi_command_pending("wlan1") is True
        assert agent._wifi_command_pending("wlan1") is False

    async def test_nested_commands_do_not_clear_each_other(self, agent):
        """Two commands queued on the same interface: the first to finish
        must not clear the flag out from under the second."""
        async with agent._wifi_pending_command("wlan1"):
            async with agent._wifi_pending_command("wlan1"):
                assert agent._wifi_command_pending("wlan1") is True
            assert agent._wifi_command_pending("wlan1") is True
        assert agent._wifi_command_pending("wlan1") is False

    async def test_pending_clears_even_if_the_command_raises(self, agent):
        try:
            async with agent._wifi_pending_command("wlan1"):
                raise RuntimeError("boom")
        except RuntimeError:
            pass
        assert agent._wifi_command_pending("wlan1") is False

    async def test_pending_is_per_interface(self, agent):
        async with agent._wifi_pending_command("wlan1"):
            assert agent._wifi_command_pending("wlan1") is True
            assert agent._wifi_command_pending("wlan2") is False


class TestInterfaceIsolation:
    async def test_two_interfaces_do_not_block_each_other(self, agent):
        """Different radios must run fully in parallel - this is what makes
        4-interfaces-per-Pi viable."""
        async def slow_on_wlan1():
            async with agent._wifi_lock_for("wlan1"):
                await asyncio.sleep(1.0)

        async def command_on_wlan2():
            async with agent._wifi_pending_command("wlan2"):
                async with agent._wifi_lock_for("wlan2"):
                    pass

        waited = await run_concurrently(slow_on_wlan1, command_on_wlan2, gap=0.1)
        assert waited < 0.2, "wlan2 was blocked by work on wlan1"

    async def test_four_radios_scan_concurrently_not_serially(self, agent, fake_cmds):
        """The payoff of the conversion: four interfaces' scan cycles
        overlap rather than queueing, since none of them occupies a thread
        while it waits on iw."""
        interfaces = ["wlan0", "wlan1", "wlan2", "wlan3"]
        for i in interfaces:
            fake_cmds.register(f"iw dev {i} scan trigger", duration=0.2)
            fake_cmds.register(f"iw dev {i} scan dump", stdout="", duration=0.2)
            fake_cmds.register(f"iw dev {i} link", stdout="Not connected.")

        loop = asyncio.get_running_loop()
        t0 = loop.time()
        await asyncio.gather(*(agent._wifi_background_scan_one(i) for i in interfaces))
        elapsed = loop.time() - t0

        # Serial would be 4 x 0.4s = 1.6s; concurrent is ~0.4s.
        assert elapsed < 0.9, f"four radios took {elapsed:.2f}s - they serialised"

    async def test_same_interface_commands_serialise(self, agent):
        """Two commands on one interface must not overlap - they'd race on
        the same radio state."""
        overlapping = []
        active = []

        async def command(hold):
            async with agent._wifi_lock_for("wlan1"):
                active.append(1)
                if len(active) > 1:
                    overlapping.append(True)
                await asyncio.sleep(hold)
                active.pop()

        await asyncio.gather(*(command(0.05) for _ in range(3)))
        assert not overlapping, "two commands held the same interface at once"


class TestDispatch:
    async def test_dispatch_publishes_result_with_correlation_fields(self, agent):
        async def fake_command(interface):
            return {"interface": interface, "ok": True}

        agent._dispatch_wifi_command("connect_wifi", "cmd-123", "wlan1", fake_command, "wlan1")
        assert await conftest.wait_for(lambda: conftest.published_results(agent))

        result = conftest.published_results(agent)[0]
        assert result["command_id"] == "cmd-123"
        assert result["action"] == "connect_wifi"
        assert result["pi_id"] == agent.pi_id
        assert result["ok"] is True
        assert "timestamp" in result

    async def test_dispatch_reports_an_exception_as_an_error_result(self, agent):
        async def exploding(interface):
            raise RuntimeError("nmcli went missing")

        agent._dispatch_wifi_command("connect_wifi", "cmd-1", "wlan1", exploding, "wlan1")
        assert await conftest.wait_for(lambda: conftest.published_results(agent))

        result = conftest.published_results(agent)[0]
        assert result["error"] == "nmcli went missing"
        assert result["command_id"] == "cmd-1"

    async def test_dispatch_releases_the_lock_after_a_failure(self, agent):
        """A raised command must not deadlock every later command on that
        interface."""
        async def exploding(interface):
            raise RuntimeError("boom")

        agent._dispatch_wifi_command("connect_wifi", "c1", "wlan1", exploding, "wlan1")
        assert await conftest.wait_for(lambda: conftest.published_results(agent))

        assert not agent._wifi_lock_for("wlan1").locked(), "lock left held after a failure"
        assert agent._wifi_command_pending("wlan1") is False

    async def test_dispatch_does_not_block_the_caller(self, agent):
        """It runs as its own task - the point is that the message loop keeps
        pulling commands while a slow one runs."""
        async def slow(interface):
            await asyncio.sleep(1.0)
            return {"ok": True}

        loop = asyncio.get_running_loop()
        t0 = loop.time()
        task = agent._dispatch_wifi_command("connect_wifi", "c1", "wlan1", slow, "wlan1")
        assert loop.time() - t0 < 0.2
        task.cancel()

    async def test_dispatched_task_is_strongly_referenced(self, agent):
        """asyncio only holds weak references to tasks, so a fire-and-forget
        task nobody keeps can be garbage-collected mid-command."""
        async def slow(interface):
            await asyncio.sleep(0.2)
            return {"ok": True}

        agent._dispatch_wifi_command("connect_wifi", "c1", "wlan1", slow, "wlan1")
        assert len(agent._wifi_tasks) == 1

        assert await conftest.wait_for(lambda: conftest.published_results(agent))
        # ...and dropped again once it finishes, so the set can't grow forever.
        assert await conftest.wait_for(lambda: not agent._wifi_tasks)
