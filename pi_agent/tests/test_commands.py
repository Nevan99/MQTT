"""handle_command routing: which actions dispatch off-thread, which reply
inline, and that every path publishes a correlatable result."""
import json
import time

import conftest


class TestRouting:
    def test_unknown_action_is_reported_not_swallowed(self, agent):
        agent.handle_command({"action": "does_not_exist", "command_id": "c1"})

        result = conftest.published_results(agent)[0]
        assert "unknown action" in result["error"]
        assert result["command_id"] == "c1"

    def test_inline_actions_publish_correlation_fields(self, agent):
        agent.handle_command({"action": "wifi_detail_scan", "interface": "wlan1", "command_id": "c7"})

        result = conftest.published_results(agent)[0]
        assert result["command_id"] == "c7"
        assert result["action"] == "wifi_detail_scan"
        assert result["pi_id"] == agent.pi_id
        assert "timestamp" in result

    def test_wifi_detail_scan_is_served_from_cache(self, agent, fake_cmds):
        """It runs inline on the MQTT network thread, so it must never do a
        radio-driving scan there."""
        agent.handle_command({"action": "wifi_detail_scan", "interface": "wlan1", "command_id": "c1"})

        assert fake_cmds.ran("scan dump")
        assert not any(c.endswith("iw dev wlan1 scan") for c in fake_cmds.commands())

    def test_wifi_detail_scan_returns_promptly(self, agent):
        t0 = time.time()
        agent.handle_command({"action": "wifi_detail_scan", "interface": "wlan1", "command_id": "c1"})
        assert time.time() - t0 < 1.0

    def test_scan_wifi_uses_the_nmcli_table(self, agent, fake_cmds):
        agent.handle_command({"action": "scan_wifi", "interface": "wlan1", "command_id": "c1"})
        assert fake_cmds.ran("nmcli")

    def test_an_exception_becomes_an_error_result(self, agent, monkeypatch):
        monkeypatch.setattr(
            type(agent), "get_link_info",
            lambda self, i: (_ for _ in ()).throw(RuntimeError("iw exploded")),
        )
        agent.handle_command({"action": "link_info", "interface": "wlan1", "command_id": "c1"})

        result = conftest.published_results(agent)[0]
        assert result["error"] == "iw exploded"
        assert result["command_id"] == "c1"


class TestDispatchedActions:
    """connect/disconnect/mode-switch must return immediately and publish
    their own result later, so paho's keepalive keeps running."""

    def test_connect_wifi_returns_immediately(self, agent, monkeypatch):
        monkeypatch.setattr(type(agent), "connect_wifi",
                            lambda self, *a, **kw: (time.sleep(1.0), {"connected": True})[1])

        t0 = time.time()
        agent.handle_command({
            "action": "connect_wifi", "interface": "wlan1",
            "ssid": "Telia-test", "password": "x", "command_id": "c1",
        })
        assert time.time() - t0 < 0.3

    def test_connect_wifi_publishes_asynchronously(self, agent, monkeypatch):
        monkeypatch.setattr(type(agent), "connect_wifi",
                            lambda self, *a, **kw: {"connected": True, "ssid": "Telia-test"})

        agent.handle_command({
            "action": "connect_wifi", "interface": "wlan1",
            "ssid": "Telia-test", "password": "x", "command_id": "c1",
        })
        assert conftest.wait_for(lambda: conftest.published_results(agent))

        result = conftest.published_results(agent)[0]
        assert result["action"] == "connect_wifi"
        assert result["command_id"] == "c1"
        assert result["connected"] is True

    def test_disconnect_wifi_returns_immediately(self, agent, monkeypatch):
        monkeypatch.setattr(type(agent), "disconnect_wifi",
                            lambda self, i: (time.sleep(1.0), {"disconnected": True})[1])

        t0 = time.time()
        agent.handle_command({"action": "disconnect_wifi", "interface": "wlan1", "command_id": "c1"})
        assert time.time() - t0 < 0.3

    def test_disconnect_wifi_publishes_asynchronously(self, agent, monkeypatch):
        monkeypatch.setattr(type(agent), "disconnect_wifi",
                            lambda self, i: {"disconnected": True, "interface": i})

        agent.handle_command({"action": "disconnect_wifi", "interface": "wlan1", "command_id": "c9"})
        assert conftest.wait_for(lambda: conftest.published_results(agent))

        result = conftest.published_results(agent)[0]
        assert result["action"] == "disconnect_wifi"
        assert result["command_id"] == "c9"
        assert result["disconnected"] is True

    def test_set_interface_mode_is_dispatched_too(self, agent, monkeypatch):
        monkeypatch.setattr(type(agent), "set_interface_mode",
                            lambda self, i, m: {"applied": True, "mode": m})

        agent.handle_command({
            "action": "set_interface_mode", "interface": "wlan1",
            "mode": "monitor", "command_id": "c1",
        })
        assert conftest.wait_for(lambda: conftest.published_results(agent))
        assert conftest.published_results(agent)[0]["mode"] == "monitor"


class TestMessageHandling:
    def test_malformed_json_is_ignored(self, agent):
        msg = type("Msg", (), {"payload": b"not json at all"})()
        agent.on_message(None, None, msg)  # must not raise
        assert conftest.published_results(agent) == []

    def test_valid_message_is_handled(self, agent):
        msg = type("Msg", (), {
            "payload": json.dumps({"action": "wifi_detail_scan", "interface": "wlan1", "command_id": "c1"}).encode(),
        })()
        agent.on_message(None, None, msg)

        assert conftest.published_results(agent)[0]["command_id"] == "c1"

    def test_on_connect_subscribes_and_announces_online(self, agent):
        agent.on_connect(agent.client, None, None, 0)

        assert agent.cmd_topic_mine in agent.client.subscriptions
        assert agent.cmd_topic_all in agent.client.subscriptions
        assert any(m["topic"] == agent.status_topic and m["payload"] == "online"
                   for m in agent.client.published)

    def test_background_loops_start_once_across_reconnects(self, agent):
        agent.on_connect(agent.client, None, None, 0)
        agent.on_connect(agent.client, None, None, 0)
        agent.on_connect(agent.client, None, None, 0)

        assert agent._wifi_scan_loop_started is True
        assert agent._interface_status_loop_started is True
