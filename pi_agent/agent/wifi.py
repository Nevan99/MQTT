import json
import os
import re
import subprocess
import threading
import time
import zlib
from datetime import datetime, timezone


class WifiMixin:
    """Station-mode wifi: association status, connect/disconnect (via
    nmcli), monitor/managed mode switching, per-interface policy routing,
    and the connect/disconnect/mode-switch dispatch machinery
    (_dispatch_wifi_command) shared with WifiScanMixin's background scan
    loop (both respect the same per-interface lock, see _wifi_lock_for)."""

    def get_link_info(self, interface):
        """Current association info for an interface (Pi acting as a station):
        connected BSSID, SSID, signal strength, bitrates, etc."""
        if not interface:
            return {"error": "interface is required"}

        out = subprocess.run(
            ["iw", "dev", interface, "link"], capture_output=True, text=True,
        ).stdout

        if out.startswith("Not connected"):
            return {"interface": interface, "connected": False}

        m = re.match(r'Connected to ([0-9a-fA-F:]+)', out)
        bssid = m.group(1) if m else None

        ssid_m = re.search(r'SSID:\s*(.+)', out)
        freq_m = re.search(r'freq:\s*(\d+)', out)
        signal_m = re.search(r'signal:\s*(-?\d+)\s*dBm', out)
        rx_bitrate_m = re.search(r'rx bitrate:\s*([\d.]+)\s*MBit/s', out)
        tx_bitrate_m = re.search(r'tx bitrate:\s*([\d.]+)\s*MBit/s', out)

        return {
            "interface": interface,
            "connected": True,
            "bssid": bssid,
            "ssid": ssid_m.group(1).strip() if ssid_m else None,
            "frequency_mhz": int(freq_m.group(1)) if freq_m else None,
            "band": self._band_label(int(freq_m.group(1))) if freq_m else None,
            "signal_dbm": int(signal_m.group(1)) if signal_m else None,
            "rx_bitrate_mbps": float(rx_bitrate_m.group(1)) if rx_bitrate_m else None,
            "tx_bitrate_mbps": float(tx_bitrate_m.group(1)) if tx_bitrate_m else None,
            # The AP's own management IP is almost always its default gateway
            # on this interface - lets the UI offer a direct link to the AP's
            # web UI without the user having to know/guess its address.
            "gateway": self._default_gateway_for(interface),
            "raw_output": out.strip(),
        }

    def _default_gateway_for(self, interface):
        """Every connect_wifi puts this interface's default route into its
        own per-interface policy-routing table (see _apply_policy_routing/
        _routing_table_for) - specifically so several connected wifi
        interfaces don't fight over the one system-wide default route. That
        means only whichever interface Linux picked as the actual
        system default shows up in `ip route show default` (the main
        table); every other connected interface's gateway only exists in
        its own numbered table, and has to be looked up there instead."""
        table = self._routing_table_for(interface)
        for args in (["table", str(table)], ["default"]):
            out = subprocess.run(
                ["ip", "-4", "route", "show", *args],
                capture_output=True, text=True,
            ).stdout
            m = re.search(rf'default via (\d+\.\d+\.\d+\.\d+) dev {re.escape(interface)}\b', out)
            if m:
                return m.group(1)
        return None

    @staticmethod
    def _band_label(freq_mhz):
        if 2400 <= freq_mhz <= 2495:
            return "2.4GHz"
        if 5150 <= freq_mhz <= 5895:
            return "5GHz"
        if 5925 <= freq_mhz <= 7125:
            return "6GHz"
        return "unknown"

    def get_band_channel_info(self, interface):
        """Current channel/frequency plus every band+channel the interface's
        radio (wiphy) supports, so an interface's capability and its live
        setting can both be inspected from the web UI."""
        if not interface:
            return {"error": "interface is required"}

        info_out = subprocess.run(
            ["iw", "dev", interface, "info"], capture_output=True, text=True,
        ).stdout

        current = None
        m = re.search(r'channel (\d+) \(([\d.]+) MHz\), width: ([\w.]+ MHz)', info_out)
        if m:
            freq = int(float(m.group(2)))
            current = {
                "channel": int(m.group(1)),
                "frequency_mhz": freq,
                "width": m.group(3),
                "band": self._band_label(freq),
            }

        wiphy_match = re.search(r'wiphy (\d+)', info_out)
        if not wiphy_match:
            return {
                "interface": interface,
                "current": current,
                "error": "could not determine this interface's wiphy (is it a wireless interface?)",
            }
        phy = f"phy{wiphy_match.group(1)}"

        phy_out = subprocess.run(
            ["iw", "phy", phy, "info"], capture_output=True, text=True,
        ).stdout

        bands = []
        band = None
        for line in phy_out.splitlines():
            band_match = re.match(r'\s*Band (\d+):', line)
            if band_match:
                band = {"band": int(band_match.group(1)), "channels": []}
                bands.append(band)
                continue
            if band is None:
                continue
            chan_match = re.match(r'\s*\*\s+([\d.]+) MHz \[(\d+)\](.*)$', line)
            if chan_match:
                freq = int(float(chan_match.group(1)))
                flags = chan_match.group(3)
                power_match = re.search(r'\(([\d.]+) dBm\)', flags)
                band["channels"].append({
                    "channel": int(chan_match.group(2)),
                    "frequency_mhz": freq,
                    "band": self._band_label(freq),
                    "max_tx_power_dbm": float(power_match.group(1)) if power_match else None,
                    "disabled": "disabled" in flags,
                    "no_ir": "no IR" in flags,
                    "radar_detection": "radar detection" in flags,
                })

        return {"interface": interface, "wiphy": phy, "current": current, "bands": bands}

    @staticmethod
    def _routing_table_for(interface):
        """Deterministic, stable per-interface routing table id (100-1099),
        so repeated connects on the same interface always reuse the same
        table instead of leaking a new rule/table every time."""
        return 100 + (zlib.crc32(interface.encode()) % 1000)

    def _apply_policy_routing(self, con_name, interface, ip_address):
        if not ip_address:
            return {"applied": False, "reason": "no IP address yet"}

        table = self._routing_table_for(interface)
        modify_ret = subprocess.run(
            [
                "nmcli", "connection", "modify", con_name,
                "ipv4.route-table", str(table),
                "ipv4.routing-rules", f"priority {table} from {ip_address} table {table}",
            ],
            capture_output=True, text=True, timeout=15,
        )
        if modify_ret.returncode != 0:
            return {"applied": False, "reason": (modify_ret.stdout or modify_ret.stderr).strip()}

        # routing-rules only takes effect on (re)activation, not just from
        # `connection modify` - this briefly cycles the interface's link.
        up_ret = subprocess.run(
            ["nmcli", "connection", "up", con_name],
            capture_output=True, text=True, timeout=30,
        )
        return {
            "applied": up_ret.returncode == 0,
            "table": table,
            "reason": None if up_ret.returncode == 0 else (up_ret.stdout or up_ret.stderr).strip(),
        }

    # --- wpa_supplicant-based connect/disconnect ---------------------------
    # Previously nmcli did this end-to-end (association + DHCP + device
    # ownership) via a per-interface connection profile. wpa_supplicant only
    # handles L2 association/auth, not DHCP or device ownership, so this
    # split into three pieces:
    #  - NetworkManager has to be told to let go of the interface first
    #    (_ensure_wpa_supplicant_running), or it fights wpa_supplicant for
    #    control - same "managed no" trick set_interface_mode already uses
    #    for monitor mode - and gets it back on disconnect_wifi.
    #  - wpa_supplicant itself, driven via its wpa_cli control interface
    #    (add_network/set_network/select_network), owns the actual
    #    association.
    #  - dhcpcd (Raspberry Pi OS's default DHCP client) gets the interface
    #    its IP once wpa_supplicant reports wpa_state=COMPLETED.
    # This hasn't been run against real hardware - the exact dhcpcd/NM
    # interaction (dhcpcd.service already managing every interface
    # system-wide vs. this ad hoc per-call invocation) should be verified
    # on the fleet before relying on it.

    WPA_CTRL_DIR = "/var/run/wpa_supplicant"

    def _wpa_ctrl_socket_exists(self, interface):
        return os.path.exists(f"{self.WPA_CTRL_DIR}/{interface}")

    def _wpa_cli(self, interface, *args, timeout=15):
        return subprocess.run(["wpa_cli", "-i", interface, *args], capture_output=True, text=True, timeout=timeout)

    def _ensure_wpa_supplicant_running(self, interface):
        """Starts a wpa_supplicant instance for this interface if one isn't
        already running (reusing an existing one - e.g. from a previous
        connect_wifi call on this interface - rather than starting a
        second, conflicting one)."""
        if self._wpa_ctrl_socket_exists(interface):
            return True, ""

        subprocess.run(["nmcli", "device", "set", interface, "managed", "no"],
                        capture_output=True, text=True, timeout=30)
        subprocess.run(["ip", "link", "set", interface, "up"], capture_output=True, text=True, timeout=15)

        conf_path = f"/tmp/wpa_supplicant-{interface}.conf"
        with open(conf_path, "w") as f:
            f.write(f"ctrl_interface=DIR={self.WPA_CTRL_DIR} GROUP=netdev\nupdate_config=1\n")

        ret = subprocess.run(
            ["wpa_supplicant", "-B", "-i", interface, "-c", conf_path, "-D", "nl80211"],
            capture_output=True, text=True, timeout=15,
        )
        if ret.returncode != 0:
            return False, (ret.stdout or ret.stderr).strip()

        for _ in range(20):
            if self._wpa_ctrl_socket_exists(interface):
                return True, ""
            time.sleep(0.25)
        return False, "wpa_supplicant started but its control socket never appeared"

    def _wait_for_wpa_state(self, interface, target_state, timeout=60):
        deadline = time.time() + timeout
        while time.time() < deadline:
            ret = self._wpa_cli(interface, "status")
            if ret.returncode == 0:
                m = re.search(r'^wpa_state=(\S+)', ret.stdout, re.MULTILINE)
                if m and m.group(1) == target_state:
                    return True
            time.sleep(1)
        return False

    @staticmethod
    def _freq_for_channel(channel):
        """Inverse of WifiScanMixin._channel_for_freq - good enough for
        pinning a connect attempt's scan_freq, not a full channel-plan
        validator."""
        channel = int(channel)
        if channel == 14:
            return 2484
        if 1 <= channel <= 13:
            return 2407 + channel * 5
        if channel <= 196:
            return 5000 + channel * 5
        return 5950 + channel * 5

    def connect_wifi(self, ssid, password=None, interface=None, bssid=None, channel=None):
        """Connect to a wifi hotspot via wpa_supplicant + dhcpcd (see the
        module-level comment above for why this needs three pieces instead
        of nmcli's one call).

        If bssid is given without ssid, the SSID is resolved from a live
        scan (get_wifi_scan_detail, WifiScanMixin) matching that BSSID -
        wpa_supplicant's network blocks are keyed by ssid, unlike nmcli's
        `device wifi connect <bssid>`, which resolved it from its own scan
        cache internally. If channel is given, the connection is pinned to
        that channel's frequency (scan_freq) - useful when the same SSID is
        broadcast on multiple bands/channels and a specific one needs to be
        tested.
        """
        if not interface:
            return {"error": "interface is required"}
        if not ssid and not bssid:
            return {"error": "ssid is required"}

        if bssid and not ssid:
            scan = self.get_wifi_scan_detail(interface)
            match = next((n for n in scan.get("networks", []) if n.get("bssid") == bssid.lower()), None)
            if not match or not match.get("ssid"):
                return {
                    "bssid": bssid, "interface": interface, "connected": False,
                    "output": f"could not resolve an SSID for bssid {bssid} from a scan",
                }
            ssid = match["ssid"]

        ok, err = self._ensure_wpa_supplicant_running(interface)
        if not ok:
            return {
                "ssid": ssid, "bssid": bssid, "interface": interface, "connected": False,
                "output": f"failed to start wpa_supplicant: {err}",
            }

        add_ret = self._wpa_cli(interface, "add_network")
        net_id = add_ret.stdout.strip().splitlines()[-1].strip() if add_ret.returncode == 0 else ""
        if not net_id.isdigit():
            return {
                "ssid": ssid, "bssid": bssid, "interface": interface, "connected": False,
                "output": (add_ret.stdout or add_ret.stderr).strip(),
            }

        outputs = []
        outputs.append(self._wpa_cli(interface, "set_network", net_id, "ssid", f'"{ssid}"').stdout.strip())
        if bssid:
            outputs.append(self._wpa_cli(interface, "set_network", net_id, "bssid", bssid).stdout.strip())
        if password:
            outputs.append(self._wpa_cli(interface, "set_network", net_id, "psk", f'"{password}"').stdout.strip())
        else:
            outputs.append(self._wpa_cli(interface, "set_network", net_id, "key_mgmt", "NONE").stdout.strip())
        if channel:
            outputs.append(self._wpa_cli(interface, "set_network", net_id, "scan_freq", str(self._freq_for_channel(channel))).stdout.strip())

        self._wpa_cli(interface, "enable_network", net_id)
        self._wpa_cli(interface, "select_network", net_id)
        self._wpa_cli(interface, "save_config")

        associated = self._wait_for_wpa_state(interface, "COMPLETED", timeout=60)
        ip_address = None
        dhcp_output = ""
        if associated:
            dhcp_ret = subprocess.run(["dhcpcd", "-n", "-t", "30", interface], capture_output=True, text=True, timeout=35)
            dhcp_output = (dhcp_ret.stdout or dhcp_ret.stderr).strip()
            ip_address = self.get_interface_ip(interface)

        return {
            "ssid": ssid,
            "bssid": bssid,
            "interface": interface,
            "channel": channel,
            "connected": associated and bool(ip_address),
            "ip_address": ip_address,
            "output": " | ".join(o for o in (*outputs, dhcp_output) if o),
            "policy_routing": None,
        }

    def disconnect_wifi(self, interface=None):
        """Disconnect via wpa_supplicant: tears down the association
        (wpa_cli terminate), releases the DHCP lease, flushes the interface's
        IP, and hands the interface back to NetworkManager (which
        connect_wifi told to release it - see _ensure_wpa_supplicant_running)."""
        if not interface:
            return {"error": "interface is required"}

        outputs = []
        if self._wpa_ctrl_socket_exists(interface):
            term_ret = self._wpa_cli(interface, "terminate")
            outputs.append((term_ret.stdout or term_ret.stderr).strip())

        dhcp_ret = subprocess.run(["dhcpcd", "-k", interface], capture_output=True, text=True, timeout=15)
        outputs.append((dhcp_ret.stdout or dhcp_ret.stderr).strip())

        subprocess.run(["ip", "addr", "flush", "dev", interface], capture_output=True, text=True, timeout=15)

        nm_ret = subprocess.run(["nmcli", "device", "set", interface, "managed", "yes"],
                                 capture_output=True, text=True, timeout=30)
        outputs.append((nm_ret.stdout or nm_ret.stderr).strip())

        return {
            "interface": interface,
            "disconnected": not self._wpa_ctrl_socket_exists(interface),
            "output": " | ".join(o for o in outputs if o),
        }

    def restart_hostapd(self, channel=None):
        if channel:
            subprocess.run(["sed", "-i", f"s/^channel=.*/channel={channel}/",
                             "/etc/hostapd/hostapd.conf"])
        subprocess.run(["systemctl", "restart", "hostapd"])
        return {"restarted": True, "channel": channel}

    def set_monitor_channel(self, interface, channel):
        """Sets a monitor-mode interface's capture channel via `iw` - unlike
        connect_wifi/disconnect_wifi/scan_wifi/link_info, there's no nmcli
        equivalent here: a monitor-mode interface has no SSID/association to
        manage, NetworkManager doesn't touch it at all, and `iw` is the only
        tool that can set its channel. Band isn't a separate parameter -
        `iw ... set channel` infers it from the channel number, same as
        connect_wifi's own inference."""
        if not interface:
            return {"error": "interface is required"}
        if not channel:
            return {"error": "channel is required"}
        ret = subprocess.run(
            ["iw", "dev", interface, "set", "channel", str(channel)],
            capture_output=True, text=True, timeout=30,
        )
        return {
            "interface": interface,
            "channel": channel,
            "applied": ret.returncode == 0,
            "output": (ret.stdout or ret.stderr).strip(),
        }

    def _current_interface_type(self, interface):
        details = next((d for d in self.get_interface_details() if d["name"] == interface), None)
        return details["type"] if details else None

    def _current_interface_mode(self, interface):
        """'managed'/'monitor', for comparison against set_interface_mode's
        own mode param - get_interface_details' "type" is a richer field
        ("wifi"/"ethernet"/"monitor"/etc, see get_interface_details) that
        never literally reads "managed", so comparing it to mode directly
        would report every successful switch back to managed as a failure.
        Returns None if the interface doesn't exist."""
        type_ = self._current_interface_type(interface)
        if type_ is None:
            return None
        return "monitor" if type_ == "monitor" else "managed"

    @staticmethod
    def _phy_for_interface(interface):
        try:
            with open(f"/sys/class/net/{interface}/phy80211/name") as f:
                return f.read().strip()
        except OSError:
            return None

    def _try_set_interface_mode(self, interface, phy, mode):
        """One attempt at the switch, by deleting and recreating the netdev
        (same name) rather than a live `iw dev <iface> set type` on the
        existing one. Several wifi chipsets/drivers (notably rtl8188/mt76-
        family USB adapters common on Pi rigs) accept a live type change and
        report success, but the firmware doesn't actually start delivering
        monitor-mode frames afterward - only a fresh `iw phy <phy> interface
        add` resets that firmware state reliably, which is exactly what the
        old boot-time script did (just as a second, permanent interface
        instead of an in-place swap of this one).

        NetworkManager also needs a moment to actually let go of the device
        after 'managed no' before the delete/add - proceeding immediately
        can race it, which is why the caller re-verifies and retries rather
        than trusting iw's exit code alone."""
        if mode == "monitor":
            subprocess.run(["nmcli", "device", "disconnect", interface],
                            capture_output=True, text=True, timeout=300)
            subprocess.run(["nmcli", "device", "set", interface, "managed", "no"],
                            capture_output=True, text=True, timeout=30)
            time.sleep(0.5)
        subprocess.run(["ip", "link", "set", interface, "down"], capture_output=True, text=True, timeout=30)
        del_ret = subprocess.run(["iw", "dev", interface, "del"], capture_output=True, text=True, timeout=30)
        add_ret = subprocess.run(
            ["iw", "phy", phy, "interface", "add", interface, "type", mode],
            capture_output=True, text=True, timeout=30,
        )
        if add_ret.returncode != 0:
            # Don't leave the Pi with a missing interface if the target-mode
            # add failed - recreate it managed, the safer default, instead
            # of stranding it deleted until a reboot.
            subprocess.run(["iw", "phy", phy, "interface", "add", interface, "type", "managed"],
                            capture_output=True, text=True, timeout=30)
        if mode == "managed" or add_ret.returncode != 0:
            subprocess.run(["nmcli", "device", "set", interface, "managed", "yes"],
                            capture_output=True, text=True, timeout=30)
        subprocess.run(["ip", "link", "set", interface, "up"], capture_output=True, text=True, timeout=30)
        time.sleep(0.3)
        del_out = (del_ret.stdout or del_ret.stderr).strip()
        add_out = (add_ret.stdout or add_ret.stderr).strip()
        return f"{del_out} | {add_out}".strip(" |")

    def set_interface_mode(self, interface, mode):
        """Switches an interface between 'managed' and 'monitor' (deleting
        and recreating the same-named netdev under the hood - see
        _try_set_interface_mode), replacing the old approach of a permanent,
        separate monitor interface created per phy at boot.

        Verifies the resulting type with get_interface_details rather than
        trusting iw's exit code alone - a return code of 0 doesn't guarantee
        the switch actually stuck, which otherwise shows up downstream as
        monitor mode silently not actually capturing anything."""
        if not interface:
            return {"error": "interface is required"}
        if mode not in ("monitor", "managed"):
            return {"error": "mode must be 'monitor' or 'managed'"}

        current_mode = self._current_interface_mode(interface)
        if current_mode is None:
            return {"error": f"no such interface: {interface}"}
        if current_mode == mode:
            return {"interface": interface, "mode": mode, "applied": True, "already": True}

        phy = self._phy_for_interface(interface)
        if phy is None:
            return {"error": f"could not determine wireless phy for {interface} (not a wifi interface?)"}

        output = self._try_set_interface_mode(interface, phy, mode)
        resulting_mode = self._current_interface_mode(interface)
        if resulting_mode != mode:
            # Didn't stick on the first try - most often NetworkManager
            # reclaiming the device before the delete/add landed. One
            # retry, giving NM more time to settle, covers that race.
            output = self._try_set_interface_mode(interface, phy, mode)
            resulting_mode = self._current_interface_mode(interface)

        return {
            "interface": interface,
            "mode": mode,
            "applied": resulting_mode == mode,
            "resulting_type": self._current_interface_type(interface),
            "output": output,
        }

    def _wifi_lock_for(self, interface):
        with self._wifi_locks_guard:
            lock = self._wifi_locks.get(interface)
            if lock is None:
                lock = threading.Lock()
                self._wifi_locks[interface] = lock
            return lock

    def _dispatch_wifi_command(self, action, command_id, interface, fn, *args):
        """Runs connect_wifi/disconnect_wifi off the MQTT network thread and
        publishes their result itself once done, instead of handle_command
        blocking on it directly. Both can now take up to 5 minutes
        (nmcli timeout=300) - blocking the same thread paho's network loop
        runs on for that long would starve the periodic keepalive PINGREQ
        and get this client disconnected by the broker mid-command. Worse,
        since the client connects with clean_session=True, any command
        sent to this Pi during that disconnected window is dropped, not
        queued - so a caller could see it silently never execute. Two
        commands aimed at the same interface still serialize (via
        _wifi_lock_for), so they don't race on the same NetworkManager
        profile; different interfaces run fully in parallel."""
        def worker():
            lock = self._wifi_lock_for(interface) if interface else None
            if lock:
                lock.acquire()
            try:
                result = fn(*args)
            except Exception as e:
                result = {"error": str(e)}
            finally:
                if lock:
                    lock.release()
            result["command_id"] = command_id
            result["action"] = action
            result["pi_id"] = self.pi_id
            result["timestamp"] = datetime.now(timezone.utc).isoformat()
            try:
                self.client.publish(self.result_topic, json.dumps(result), qos=1)
            except Exception as e:
                print(f"[pi_agent] failed to publish result for {action}: {e}")
        threading.Thread(target=worker, daemon=True).start()
