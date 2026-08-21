import asyncio
"""handle_command routing: which actions dispatch off-thread, which reply
inline, and that every path publishes a correlatable result."""
import json
import time

import conftest


class TestRouting:
    async def test_unknown_action_is_reported_not_swallowed(self, agent):
        await agent.handle_command({"action": "does_not_exist", "command_id": "c1"})

        result = conftest.published_results(agent)[0]
        assert "unknown action" in result["error"]
        assert result["command_id"] == "c1"

    async def test_inline_actions_publish_correlation_fields(self, agent):
        await agent.handle_command({"action": "wifi_detail_scan", "interface": "wlan1", "command_id": "c7"})

        result = conftest.published_results(agent)[0]
        assert result["command_id"] == "c7"
        assert result["action"] == "wifi_detail_scan"
        assert result["pi_id"] == agent.pi_id
        assert "timestamp" in result

    async def test_wifi_detail_scan_is_served_from_cache(self, agent, fake_cmds):
        """It runs inline on the MQTT network thread, so it must never do a
        radio-driving scan there."""
        await agent.handle_command({"action": "wifi_detail_scan", "interface": "wlan1", "command_id": "c1"})

        assert fake_cmds.ran("scan dump")
        assert not any(c.endswith("iw dev wlan1 scan") for c in fake_cmds.commands())

    async def test_wifi_detail_scan_returns_promptly(self, agent):
        t0 = time.time()
        await agent.handle_command({"action": "wifi_detail_scan", "interface": "wlan1", "command_id": "c1"})
        assert time.time() - t0 < 1.0

    async def test_scan_wifi_uses_the_nmcli_table(self, agent, fake_cmds):
        await agent.handle_command({"action": "scan_wifi", "interface": "wlan1", "command_id": "c1"})
        assert fake_cmds.ran("nmcli")

    async def test_an_exception_becomes_an_error_result(self, agent, monkeypatch):
        async def exploding(self, i):
            raise RuntimeError("iw exploded")
        monkeypatch.setattr(type(agent), "get_link_info", exploding)
        await agent.handle_command({"action": "link_info", "interface": "wlan1", "command_id": "c1"})

        result = conftest.published_results(agent)[0]
        assert result["error"] == "iw exploded"
        assert result["command_id"] == "c1"


class TestDispatchedActions:
    """connect/disconnect/mode-switch must return immediately and publish
    their own result later, so paho's keepalive keeps running."""

    async def test_connect_wifi_returns_immediately(self, agent, monkeypatch):
        async def slow_connect(self, *a, **kw):
            await asyncio.sleep(1.0)
            return {"connected": True}
        monkeypatch.setattr(type(agent), "connect_wifi", slow_connect)

        t0 = time.time()
        await agent.handle_command({
            "action": "connect_wifi", "interface": "wlan1",
            "ssid": "Telia-test", "password": "x", "command_id": "c1",
        })
        assert time.time() - t0 < 0.3

    async def test_connect_wifi_publishes_asynchronously(self, agent, monkeypatch):
        monkeypatch.setattr(type(agent), "connect_wifi",
                            conftest.returns({"connected": True, "ssid": "Telia-test"}))

        await agent.handle_command({
            "action": "connect_wifi", "interface": "wlan1",
            "ssid": "Telia-test", "password": "x", "command_id": "c1",
        })
        assert await conftest.wait_for(lambda: conftest.published_results(agent))

        result = conftest.published_results(agent)[0]
        assert result["action"] == "connect_wifi"
        assert result["command_id"] == "c1"
        assert result["connected"] is True

    async def test_disconnect_wifi_returns_immediately(self, agent, monkeypatch):
        async def slow_disconnect(self, i):
            await asyncio.sleep(1.0)
            return {"disconnected": True}
        monkeypatch.setattr(type(agent), "disconnect_wifi", slow_disconnect)

        t0 = time.time()
        await agent.handle_command({"action": "disconnect_wifi", "interface": "wlan1", "command_id": "c1"})
        assert time.time() - t0 < 0.3

    async def test_disconnect_wifi_publishes_asynchronously(self, agent, monkeypatch):
        async def fake_disconnect(self, i):
            return {"disconnected": True, "interface": i}
        monkeypatch.setattr(type(agent), "disconnect_wifi", fake_disconnect)

        await agent.handle_command({"action": "disconnect_wifi", "interface": "wlan1", "command_id": "c9"})
        assert await conftest.wait_for(lambda: conftest.published_results(agent))

        result = conftest.published_results(agent)[0]
        assert result["action"] == "disconnect_wifi"
        assert result["command_id"] == "c9"
        assert result["disconnected"] is True

    async def test_set_interface_mode_is_dispatched_too(self, agent, monkeypatch):
        async def fake_mode(self, i, m):
            return {"applied": True, "mode": m}
        monkeypatch.setattr(type(agent), "set_interface_mode", fake_mode)

        await agent.handle_command({
            "action": "set_interface_mode", "interface": "wlan1",
            "mode": "monitor", "command_id": "c1",
        })
        assert await conftest.wait_for(lambda: conftest.published_results(agent))
        assert conftest.published_results(agent)[0]["mode"] == "monitor"


class TestMessageHandling:
    async def test_malformed_json_is_ignored(self, agent):
        msg = type("Msg", (), {"payload": b"not json at all"})()
        await agent.on_message(msg)  # must not raise
        assert conftest.published_results(agent) == []

    async def test_valid_message_is_handled(self, agent):
        msg = type("Msg", (), {
            "payload": json.dumps({"action": "wifi_detail_scan", "interface": "wlan1", "command_id": "c1"}).encode(),
        })()
        await agent.on_message(msg)

        assert conftest.published_results(agent)[0]["command_id"] == "c1"

    async def test_on_connect_subscribes_and_announces_online(self, agent):
        await agent.on_connect()

        assert agent.cmd_topic_mine in agent.client.subscriptions
        assert agent.cmd_topic_all in agent.client.subscriptions
        assert any(m["topic"] == agent.status_topic and m["payload"] == "online"
                   for m in agent.client.published)

    async def test_background_loops_start_once_across_reconnects(self, agent):
        await agent.on_connect()
        await agent.on_connect()
        await agent.on_connect()

        names = [t.get_name() for t in agent._background_tasks]
        assert names.count("wifi-scan-loop") == 1
        assert names.count("interface-status-loop") == 1
        for t in agent._background_tasks:
            t.cancel()
