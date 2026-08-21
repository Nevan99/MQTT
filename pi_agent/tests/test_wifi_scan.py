"""Scan behavior: the trigger/dump split, cache vs. fresh scan, parsing.

These pin down the contract the async conversion has to preserve - notably
that a cache read never invokes a radio-driving scan, and that both scan
modes parse to the same fields.
"""
import conftest
from conftest import DUMP_SECONDS, FULL_SCAN_SECONDS


class TestScanModes:
    async def test_cache_read_uses_scan_dump_not_a_full_scan(self, agent, fake_cmds):
        await agent.get_wifi_scan_detail("wlan1", use_cache=True)

        assert fake_cmds.ran("iw dev wlan1 scan dump")
        # The radio-driving form is `iw dev wlan1 scan` with no subcommand.
        assert not any(c.endswith("scan") for c in fake_cmds.commands())

    async def test_fresh_scan_drives_the_radio(self, agent, fake_cmds):
        await agent.get_wifi_scan_detail("wlan1", use_cache=False)

        assert any(c.endswith("iw dev wlan1 scan") for c in fake_cmds.commands())
        assert not fake_cmds.ran("scan dump")

    async def test_default_is_a_fresh_scan(self, agent, fake_cmds):
        """use_cache must default False: callers that predate the split
        (and any that genuinely need this instant's air) keep old behavior."""
        await agent.get_wifi_scan_detail("wlan1")

        assert any(c.endswith("iw dev wlan1 scan") for c in fake_cmds.commands())

    async def test_both_modes_parse_to_the_same_networks(self, agent, fake_cmds):
        fresh = await agent.get_wifi_scan_detail("wlan1", use_cache=False)
        cached = await agent.get_wifi_scan_detail("wlan1", use_cache=True)

        def shape(result):
            return [(n["bssid"], n["ssid"], n["channel"]) for n in result["networks"]]

        assert shape(fresh) == shape(cached)
        assert shape(fresh) == [
            ("54:7e:1a:18:30:ea", "Telia-test", 6),
            ("aa:bb:cc:dd:ee:01", "Other-AP", 36),
        ]

    async def test_result_marks_where_it_came_from(self, agent):
        assert (await agent.get_wifi_scan_detail("wlan1", use_cache=True))["from_cache"] is True
        assert (await agent.get_wifi_scan_detail("wlan1", use_cache=False))["from_cache"] is False

    async def test_cache_read_is_fast(self, agent, fake_cmds):
        import time
        t0 = time.time()
        await agent.get_wifi_scan_detail("wlan1", use_cache=True)
        elapsed = time.time() - t0

        # Nowhere near a full scan; this is the whole point of the split.
        assert elapsed < FULL_SCAN_SECONDS / 2

    async def test_missing_interface_is_an_error_not_a_crash(self, agent):
        assert "error" in await agent.get_wifi_scan_detail(None)

    async def test_scan_failure_surfaces_as_error(self, agent, fake_cmds):
        fake_cmds.register("iw dev wlan1 scan dump", returncode=1, stderr="No such device")
        result = await agent.get_wifi_scan_detail("wlan1", use_cache=True)

        assert result["error"] == "No such device"
        assert "networks" not in result


class TestBackgroundScanCycle:
    async def test_cycle_triggers_then_reads_cache(self, agent, fake_cmds):
        await agent._wifi_background_scan_one("wlan1")

        cmds = fake_cmds.commands()
        assert any("scan trigger" in c for c in cmds)
        assert any("scan dump" in c for c in cmds)
        # Never the blocking form.
        assert not any(c.endswith("iw dev wlan1 scan") for c in cmds)

    async def test_cycle_publishes_a_result(self, agent):
        await agent._wifi_background_scan_one("wlan1")

        results = conftest.published_results(agent)
        assert len(results) == 1
        assert results[0]["action"] == "wifi_detail_scan"
        assert results[0]["interface"] == "wlan1"
        assert len(results[0]["networks"]) == 2

    async def test_busy_trigger_still_publishes_cached_results(self, agent, fake_cmds):
        """EBUSY on the trigger is survivable: whatever the last completed
        scan left in the cache is still worth publishing."""
        fake_cmds.register("iw dev wlan1 scan trigger", returncode=240, stderr="Device or resource busy")

        await agent._wifi_background_scan_one("wlan1")

        results = conftest.published_results(agent)
        assert len(results) == 1
        assert len(results[0]["networks"]) == 2

    async def test_trigger_is_not_retried_with_backoff(self, agent, fake_cmds):
        """The blocking scan path retries EBUSY with sleeps; the background
        trigger must not, since those sleeps used to happen under the lock."""
        fake_cmds.register("iw dev wlan1 scan trigger", returncode=240, stderr="busy")

        await agent._wifi_background_scan_one("wlan1")

        assert fake_cmds.count("scan trigger") == 1
