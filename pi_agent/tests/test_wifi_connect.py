"""connect_wifi / disconnect_wifi: the wpa_supplicant + dhcpcd sequence."""
import conftest


def _wpa_status(state):
    return f"bssid=54:7e:1a:18:30:ea\nssid=Telia-test\nwpa_state={state}\n"


class TestConnect:
    async def test_requires_an_interface(self, agent):
        assert "error" in await agent.connect_wifi("Telia-test", interface=None)

    async def test_requires_ssid_or_bssid(self, agent):
        assert "error" in await agent.connect_wifi(None, interface="wlan1")

    async def test_happy_path_reaches_completed_and_gets_an_ip(self, agent, fake_cmds, monkeypatch):
        monkeypatch.setattr(type(agent), "_wpa_ctrl_socket_exists", lambda self, i: True)
        fake_cmds.register("wpa_cli -i wlan1 add_network", stdout="0\n")
        fake_cmds.register("wpa_cli -i wlan1 status", stdout=_wpa_status("COMPLETED"))
        monkeypatch.setattr(type(agent), "get_interface_ip", conftest.returns("192.168.1.50"))

        result = await agent.connect_wifi("Telia-test", "secret", "wlan1")

        assert result["connected"] is True
        assert result["ip_address"] == "192.168.1.50"
        assert result["ssid"] == "Telia-test"
        assert fake_cmds.ran("dhcpcd")

    async def test_psk_is_set_when_a_password_is_given(self, agent, fake_cmds, monkeypatch):
        monkeypatch.setattr(type(agent), "_wpa_ctrl_socket_exists", lambda self, i: True)
        fake_cmds.register("wpa_cli -i wlan1 add_network", stdout="0\n")
        fake_cmds.register("wpa_cli -i wlan1 status", stdout=_wpa_status("COMPLETED"))
        monkeypatch.setattr(type(agent), "get_interface_ip", conftest.returns("192.168.1.50"))

        await agent.connect_wifi("Telia-test", "secret", "wlan1")

        assert any("set_network 0 psk" in c for c in fake_cmds.commands())
        assert not any("key_mgmt NONE" in c for c in fake_cmds.commands())

    async def test_open_network_uses_key_mgmt_none(self, agent, fake_cmds, monkeypatch):
        monkeypatch.setattr(type(agent), "_wpa_ctrl_socket_exists", lambda self, i: True)
        fake_cmds.register("wpa_cli -i wlan1 add_network", stdout="0\n")
        fake_cmds.register("wpa_cli -i wlan1 status", stdout=_wpa_status("COMPLETED"))
        monkeypatch.setattr(type(agent), "get_interface_ip", conftest.returns("10.0.0.5"))

        await agent.connect_wifi("OpenAP", None, "wlan1")

        assert any("key_mgmt NONE" in c for c in fake_cmds.commands())

    async def test_no_dhcp_attempt_if_association_never_completes(self, agent, fake_cmds, monkeypatch):
        """A wrong PSK stalls at 4WAY_HANDSHAKE - running dhcpcd then would
        just burn the caller's time for nothing."""
        monkeypatch.setattr(type(agent), "_wpa_ctrl_socket_exists", lambda self, i: True)
        monkeypatch.setattr(type(agent), "_wait_for_wpa_state", conftest.returns(False))
        fake_cmds.register("wpa_cli -i wlan1 add_network", stdout="0\n")

        result = await agent.connect_wifi("Telia-test", "wrong", "wlan1")

        assert result["connected"] is False
        assert not fake_cmds.ran("dhcpcd")

    async def test_channel_pins_scan_freq(self, agent, fake_cmds, monkeypatch):
        monkeypatch.setattr(type(agent), "_wpa_ctrl_socket_exists", lambda self, i: True)
        monkeypatch.setattr(type(agent), "_wait_for_wpa_state", conftest.returns(True))
        monkeypatch.setattr(type(agent), "get_interface_ip", conftest.returns("192.168.1.50"))
        fake_cmds.register("wpa_cli -i wlan1 add_network", stdout="0\n")

        await agent.connect_wifi("Telia-test", "secret", "wlan1", channel=6)

        assert any("scan_freq 2437" in c for c in fake_cmds.commands())


class TestBssidResolution:
    async def test_bssid_resolves_from_the_cache_without_a_full_scan(self, agent, fake_cmds, monkeypatch):
        monkeypatch.setattr(type(agent), "_wpa_ctrl_socket_exists", lambda self, i: True)
        monkeypatch.setattr(type(agent), "_wait_for_wpa_state", conftest.returns(True))
        monkeypatch.setattr(type(agent), "get_interface_ip", conftest.returns("192.168.1.50"))
        fake_cmds.register("wpa_cli -i wlan1 add_network", stdout="0\n")

        result = await agent.connect_wifi(None, "secret", "wlan1", bssid="54:7E:1A:18:30:EA")

        assert result["ssid"] == "Telia-test"
        assert fake_cmds.ran("scan dump")
        assert not any(c.endswith("iw dev wlan1 scan") for c in fake_cmds.commands())

    async def test_bssid_missing_from_cache_falls_back_to_a_fresh_scan(self, agent, fake_cmds, monkeypatch):
        monkeypatch.setattr(type(agent), "_wpa_ctrl_socket_exists", lambda self, i: True)
        monkeypatch.setattr(type(agent), "_wait_for_wpa_state", conftest.returns(True))
        monkeypatch.setattr(type(agent), "get_interface_ip", conftest.returns("192.168.1.50"))
        fake_cmds.register("wpa_cli -i wlan1 add_network", stdout="0\n")
        # Cache is empty; only a live scan sees this AP.
        fake_cmds.register("iw dev wlan1 scan dump", stdout="")

        result = await agent.connect_wifi(None, "secret", "wlan1", bssid="54:7e:1a:18:30:ea")

        assert result["ssid"] == "Telia-test"
        assert any(c.endswith("iw dev wlan1 scan") for c in fake_cmds.commands())

    async def test_unresolvable_bssid_reports_clearly(self, agent, fake_cmds):
        fake_cmds.register("iw dev wlan1 scan dump", stdout="")
        fake_cmds.register("iw dev wlan1 scan", stdout="")

        result = await agent.connect_wifi(None, "secret", "wlan1", bssid="00:11:22:33:44:55")

        assert result["connected"] is False
        assert "could not resolve" in result["output"]


class TestDisconnect:
    async def test_requires_an_interface(self, agent):
        assert "error" in await agent.disconnect_wifi(None)

    async def test_wpa_path_terminates_releases_and_hands_back_to_nm(self, agent, fake_cmds, monkeypatch):
        states = iter([True, False])  # socket exists, then gone after terminate
        monkeypatch.setattr(type(agent), "_wpa_ctrl_socket_exists", lambda self, i: next(states, False))
        monkeypatch.setattr(type(agent), "get_interface_ip", conftest.returns(None))

        result = await agent.disconnect_wifi("wlan1")

        cmds = fake_cmds.commands()
        assert any("wpa_cli -i wlan1 terminate" in c for c in cmds)
        assert any("dhcpcd -k wlan1" in c for c in cmds)
        assert any("nmcli device set wlan1 managed yes" in c for c in cmds)
        assert any("ip addr flush dev wlan1" in c for c in cmds)
        assert result["disconnected"] is True

    async def test_nmcli_fallback_when_no_supplicant_socket(self, agent, fake_cmds, monkeypatch):
        monkeypatch.setattr(type(agent), "_wpa_ctrl_socket_exists", lambda self, i: False)
        monkeypatch.setattr(type(agent), "get_interface_ip", conftest.returns(None))

        await agent.disconnect_wifi("wlan1")

        cmds = fake_cmds.commands()
        assert any("nmcli device disconnect wlan1" in c for c in cmds)
        assert not any("terminate" in c for c in cmds)

    async def test_reports_not_disconnected_while_an_ip_remains(self, agent, monkeypatch):
        monkeypatch.setattr(type(agent), "_wpa_ctrl_socket_exists", lambda self, i: False)
        monkeypatch.setattr(type(agent), "get_interface_ip", conftest.returns("192.168.1.50"))

        assert (await agent.disconnect_wifi("wlan1"))["disconnected"] is False

    async def test_completes_promptly(self, agent, monkeypatch):
        """Every step is sub-second in the normal case; the timeouts are
        hang budgets, not expected durations."""
        import time
        monkeypatch.setattr(type(agent), "_wpa_ctrl_socket_exists", lambda self, i: False)
        monkeypatch.setattr(type(agent), "get_interface_ip", conftest.returns(None))

        t0 = time.time()
        await agent.disconnect_wifi("wlan1")
        assert time.time() - t0 < 1.0
