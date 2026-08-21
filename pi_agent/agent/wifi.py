import asyncio
import json
import os
import re
import zlib
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from . import proc, wpa_events


class WifiMixin:
    """Station-mode wifi: association status, connect/disconnect (via
    nmcli), monitor/managed mode switching, per-interface policy routing,
    and the connect/disconnect/mode-switch dispatch machinery
    (_dispatch_wifi_command) shared with WifiScanMixin's background scan
    loop (both respect the same per-interface lock, see _wifi_lock_for)."""

    async def get_link_info(self, interface):
        """Current association info for an interface (Pi acting as a station):
        connected BSSID, SSID, signal strength, bitrates, etc."""
        if not interface:
            return {"error": "interface is required"}

        out = (await proc.run(
            ["iw", "dev", interface, "link"],
        )).stdout

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
            "gateway": await self._default_gateway_for(interface),
            "raw_output": out.strip(),
        }

    async def _default_gateway_for(self, interface):
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
            out = (await proc.run(
                ["ip", "-4", "route", "show", *args],
            )).stdout
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

    async def get_band_channel_info(self, interface):
        """Current channel/frequency plus every band+channel the interface's
        radio (wiphy) supports, so an interface's capability and its live
        setting can both be inspected from the web UI."""
        if not interface:
            return {"error": "interface is required"}

        info_out = (await proc.run(
            ["iw", "dev", interface, "info"],
        )).stdout

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

        phy_out = (await proc.run(
            ["iw", "phy", phy, "info"],
        )).stdout

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

    async def _apply_policy_routing(self, con_name, interface, ip_address):
        if not ip_address:
            return {"applied": False, "reason": "no IP address yet"}

        table = self._routing_table_for(interface)
        modify_ret = await proc.run(
            [
                "nmcli", "connection", "modify", con_name,
                "ipv4.route-table", str(table),
                "ipv4.routing-rules", f"priority {table} from {ip_address} table {table}",
            ], timeout=15,
        )
        if modify_ret.returncode != 0:
            return {"applied": False, "reason": (modify_ret.stdout or modify_ret.stderr).strip()}

        # routing-rules only takes effect on (re)activation, not just from
        # `connection modify` - this briefly cycles the interface's link.
        up_ret = await proc.run(
            ["nmcli", "connection", "up", con_name], timeout=30,
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

    async def _wpa_cli(self, interface, *args, timeout=15):
        return await proc.run(["wpa_cli", "-i", interface, *args], timeout=timeout)

    # _run_hard_timeout used to live here, wrapping subprocess.Popen with a
    # process-group kill. proc.run_hard is its async replacement and carries
    # the explanation of why killing the direct child isn't enough.

    async def _ensure_wpa_supplicant_running(self, interface):
        """Starts a wpa_supplicant instance for this interface if one isn't
        already running (reusing an existing one - e.g. from a previous
        connect_wifi call on this interface - rather than starting a
        second, conflicting one)."""
        if self._wpa_ctrl_socket_exists(interface):
            return True, ""

        await proc.run_hard(["nmcli", "device", "set", interface, "managed", "no"], timeout=30)
        await proc.run(["ip", "link", "set", interface, "up"], timeout=15)

        conf_path = f"/tmp/wpa_supplicant-{interface}.conf"
        with open(conf_path, "w") as f:
            f.write(f"ctrl_interface=DIR={self.WPA_CTRL_DIR} GROUP=netdev\nupdate_config=1\n")

        ret = await proc.run(
            ["wpa_supplicant", "-B", "-i", interface, "-c", conf_path, "-D", "nl80211"], timeout=15,
        )
        if ret.returncode != 0:
            return False, (ret.stdout or ret.stderr).strip()

        for _ in range(20):
            if self._wpa_ctrl_socket_exists(interface):
                return True, ""
            await asyncio.sleep(0.25)
        return False, "wpa_supplicant started but its control socket never appeared"

    async def _current_wpa_state(self, interface):
        ret = await self._wpa_cli(interface, "status")
        if ret.returncode != 0:
            return None
        m = re.search(r'^wpa_state=(\S+)', ret.stdout, re.MULTILINE)
        return m.group(1) if m else None

    async def _wait_for_wpa_state(self, interface, target_state, timeout=60):
        """Wait for wpa_supplicant to reach `target_state`.

        Listens on the control socket rather than polling `status` once a
        second, which buys two things. Latency: an association that
        completes 100ms in is seen at 100ms. And failure detail: the async
        events carry reason/status codes that a state poll never shows, so
        a rejected association can stop waiting immediately instead of
        sitting out the full timeout - and self.last_wpa_failure records
        *why* for the connect result to report.

        Falls back to polling when the socket isn't attachable (no
        AF_UNIX, wpa_supplicant not running with a control interface, or
        permissions), so behavior degrades rather than breaks.
        """
        self.last_wpa_failure = None
        listener = wpa_events.WpaEventListener(interface)
        if not listener.available:
            return await self._poll_for_wpa_state(interface, target_state, timeout)

        try:
            await listener.attach()
        except (OSError, RuntimeError, asyncio.TimeoutError) as e:
            print(f"[pi_agent] {interface}: wpa control socket unavailable ({e}), polling instead")
            return await self._poll_for_wpa_state(interface, target_state, timeout)

        try:
            # Check once up front: the target state may already have been
            # reached between select_network and the ATTACH above, and no
            # further event would ever announce it.
            if await self._current_wpa_state(interface) == target_state:
                return True

            async for line in listener.events(timeout=timeout):
                name, fields = wpa_events.parse_event(line)
                if name == "CTRL-EVENT-CONNECTED" and target_state == "COMPLETED":
                    return True
                if name in wpa_events.FAILURE_EVENTS:
                    self.last_wpa_failure = f"{name} {' '.join(f'{k}={v}' for k, v in fields.items())}".strip()
                    return False
                if name.startswith("CTRL-EVENT-"):
                    # Any state-ish transition: confirm against the real
                    # state rather than trying to map every event name.
                    if await self._current_wpa_state(interface) == target_state:
                        return True
            return False
        finally:
            await listener.detach()

    async def _poll_for_wpa_state(self, interface, target_state, timeout):
        """Pre-control-socket fallback: ask `status` once a second."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            if await self._current_wpa_state(interface) == target_state:
                return True
            await asyncio.sleep(1)
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

    async def _find_bssid_in_scan(self, interface, bssid, use_cache):
        """One BSSID's entry from a scan, or None. See get_wifi_scan_detail
        for what use_cache costs: True reads cfg80211's cache in
        milliseconds, False drives a fresh multi-second scan."""
        scan = await self.get_wifi_scan_detail(interface, use_cache=use_cache)
        return next(
            (n for n in scan.get("networks", []) if n.get("bssid") == bssid.lower()),
            None,
        )

    async def connect_wifi(self, ssid, password=None, interface=None, bssid=None, channel=None):
        """Connect to a wifi hotspot via wpa_supplicant + dhcpcd (see the
        module-level comment above for why this needs three pieces instead
        of nmcli's one call).

        If bssid is given without ssid, the SSID is resolved by looking that
        BSSID up in a scan (get_wifi_scan_detail, WifiScanMixin) -
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
            # Cache first (milliseconds, no radio), falling back to a real
            # scan only if this BSSID isn't in it. The background scan loop
            # keeps the cache warm, so the fallback is for a BSSID that has
            # appeared since the last completed scan - or an interface that
            # hasn't been scanned yet at all, e.g. right after a mode switch.
            match = await self._find_bssid_in_scan(interface, bssid, use_cache=True)
            if not match:
                match = await self._find_bssid_in_scan(interface, bssid, use_cache=False)
            if not match or not match.get("ssid"):
                return {
                    "bssid": bssid, "interface": interface, "connected": False,
                    "output": f"could not resolve an SSID for bssid {bssid} from a scan",
                }
            ssid = match["ssid"]

        ok, err = await self._ensure_wpa_supplicant_running(interface)
        if not ok:
            return {
                "ssid": ssid, "bssid": bssid, "interface": interface, "connected": False,
                "output": f"failed to start wpa_supplicant: {err}",
            }

        add_ret = await self._wpa_cli(interface, "add_network")
        net_id = add_ret.stdout.strip().splitlines()[-1].strip() if add_ret.returncode == 0 else ""
        if not net_id.isdigit():
            return {
                "ssid": ssid, "bssid": bssid, "interface": interface, "connected": False,
                "output": (add_ret.stdout or add_ret.stderr).strip(),
            }

        outputs = []
        outputs.append((await self._wpa_cli(interface, "set_network", net_id, "ssid", f'"{ssid}"')).stdout.strip())
        if bssid:
            outputs.append((await self._wpa_cli(interface, "set_network", net_id, "bssid", bssid)).stdout.strip())
        if password:
            outputs.append((await self._wpa_cli(interface, "set_network", net_id, "psk", f'"{password}"')).stdout.strip())
        else:
            outputs.append((await self._wpa_cli(interface, "set_network", net_id, "key_mgmt", "NONE")).stdout.strip())
        if channel:
            outputs.append((await self._wpa_cli(
                interface, "set_network", net_id, "scan_freq",
                str(self._freq_for_channel(channel)),
            )).stdout.strip())

        await self._wpa_cli(interface, "enable_network", net_id)
        await self._wpa_cli(interface, "select_network", net_id)
        await self._wpa_cli(interface, "save_config")

        associated = await self._wait_for_wpa_state(interface, "COMPLETED", timeout=60)
        ip_address = None
        dhcp_output = ""
        if associated:
            dhcp_ret = await proc.run_hard(["dhcpcd", "-n", "-t", "30", interface], timeout=35)
            dhcp_output = (dhcp_ret.stdout or dhcp_ret.stderr).strip()
            ip_address = await self.get_interface_ip(interface)

        return {
            "ssid": ssid,
            "bssid": bssid,
            "interface": interface,
            "channel": channel,
            "connected": associated and bool(ip_address),
            "ip_address": ip_address,
            # Populated from the control socket when association was
            # rejected - the reason/status code a status poll never showed.
            "failure_reason": getattr(self, "last_wpa_failure", None),
            "output": " | ".join(o for o in (*outputs, dhcp_output) if o),
            "policy_routing": None,
        }

    async def disconnect_wifi(self, interface=None):
        if not interface:
            return {"error": "interface is required"}

        # These run strictly one after another, so every timeout here is
        # additive on the caller's round-trip. They are hang budgets, not
        # expected durations - each of these is normally sub-second, so
        # they're kept tight; the one genuinely slow call is nmcli's
        # synchronous device disconnect on the fallback path below.
        outputs = []
        if self._wpa_ctrl_socket_exists(interface):
            term_ret = await self._wpa_cli(interface, "terminate", timeout=5)
            outputs.append((term_ret.stdout or term_ret.stderr).strip())

            dhcp_ret = await proc.run_hard(["dhcpcd", "-k", interface], timeout=8)
            outputs.append((dhcp_ret.stdout or dhcp_ret.stderr).strip())

            nm_managed_ret = await proc.run_hard(["nmcli", "device", "set", interface, "managed", "yes"], timeout=8)
            outputs.append((nm_managed_ret.stdout or nm_managed_ret.stderr).strip())
        else:
            nm_disconnect_ret = await proc.run_hard(["nmcli", "device", "disconnect", interface], timeout=30)
            outputs.append((nm_disconnect_ret.stdout or nm_disconnect_ret.stderr).strip())

        await proc.run_hard(["ip", "addr", "flush", "dev", interface], timeout=5)

        return {
            "interface": interface,
            "disconnected": not self._wpa_ctrl_socket_exists(interface) and not await self.get_interface_ip(interface),
            "output": " | ".join(o for o in outputs if o),
        }

    async def restart_hostapd(self, channel=None):
        if channel:
            await proc.run(["sed", "-i", f"s/^channel=.*/channel={channel}/",
                             "/etc/hostapd/hostapd.conf"])
        await proc.run(["systemctl", "restart", "hostapd"])
        return {"restarted": True, "channel": channel}

    async def set_monitor_channel(self, interface, channel):
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
        ret = await proc.run(
            ["iw", "dev", interface, "set", "channel", str(channel)], timeout=30,
        )
        return {
            "interface": interface,
            "channel": channel,
            "applied": ret.returncode == 0,
            "output": (ret.stdout or ret.stderr).strip(),
        }

    async def _current_interface_type(self, interface):
        details = next((d for d in await self.get_interface_details() if d["name"] == interface), None)
        return details["type"] if details else None

    async def _current_interface_mode(self, interface):
        """'managed'/'monitor', for comparison against set_interface_mode's
        own mode param - get_interface_details' "type" is a richer field
        ("wifi"/"ethernet"/"monitor"/etc, see get_interface_details) that
        never literally reads "managed", so comparing it to mode directly
        would report every successful switch back to managed as a failure.
        Returns None if the interface doesn't exist."""
        type_ = await self._current_interface_type(interface)
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

    async def _try_set_interface_mode(self, interface, phy, mode):
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
            # 30s, not the 300s this used to allow: this runs while holding
            # the interface's wifi lock, so a stuck nmcli here blocks every
            # later connect/disconnect on the same interface for as long as
            # the timeout lets it run.
            await proc.run(["nmcli", "device", "disconnect", interface], timeout=30)
            await proc.run(["nmcli", "device", "set", interface, "managed", "no"], timeout=30)
            await asyncio.sleep(0.5)
        await proc.run(["ip", "link", "set", interface, "down"], timeout=30)
        del_ret = await proc.run(["iw", "dev", interface, "del"], timeout=30)
        add_ret = await proc.run(
            ["iw", "phy", phy, "interface", "add", interface, "type", mode], timeout=30,
        )
        if add_ret.returncode != 0:
            # Don't leave the Pi with a missing interface if the target-mode
            # add failed - recreate it managed, the safer default, instead
            # of stranding it deleted until a reboot.
            await proc.run(["iw", "phy", phy, "interface", "add", interface, "type", "managed"], timeout=30)
        if mode == "managed" or add_ret.returncode != 0:
            await proc.run(["nmcli", "device", "set", interface, "managed", "yes"], timeout=30)
        await proc.run(["ip", "link", "set", interface, "up"], timeout=30)
        await asyncio.sleep(0.3)
        del_out = (del_ret.stdout or del_ret.stderr).strip()
        add_out = (add_ret.stdout or add_ret.stderr).strip()
        return f"{del_out} | {add_out}".strip(" |")

    async def set_interface_mode(self, interface, mode):
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

        current_mode = await self._current_interface_mode(interface)
        if current_mode is None:
            return {"error": f"no such interface: {interface}"}
        if current_mode == mode:
            return {"interface": interface, "mode": mode, "applied": True, "already": True}

        phy = self._phy_for_interface(interface)
        if phy is None:
            return {"error": f"could not determine wireless phy for {interface} (not a wifi interface?)"}

        output = await self._try_set_interface_mode(interface, phy, mode)
        resulting_mode = await self._current_interface_mode(interface)
        if resulting_mode != mode:
            # Didn't stick on the first try - most often NetworkManager
            # reclaiming the device before the delete/add landed. One
            # retry, giving NM more time to settle, covers that race.
            output = await self._try_set_interface_mode(interface, phy, mode)
            resulting_mode = await self._current_interface_mode(interface)

        return {
            "interface": interface,
            "mode": mode,
            "applied": resulting_mode == mode,
            "resulting_type": await self._current_interface_type(interface),
            "output": output,
        }

    def _wifi_lock_for(self, interface):
        """This interface's lock, created on demand.

        No guard lock around the dict any more: every caller runs on the
        one event loop, and there is no await between the get and the set,
        so this whole function is atomic with respect to other tasks. That
        is also why _wifi_pending below can drop its guard.
        """
        lock = self._wifi_locks.get(interface)
        if lock is None:
            lock = asyncio.Lock()
            self._wifi_locks[interface] = lock
        return lock

    @asynccontextmanager
    async def _wifi_pending_command(self, interface):
        """Marks `interface` as having a user command queued for its lock,
        for as long as the command is waiting *and* running.

        The background scan loop already skips an interface whose lock is
        held (Lock.locked()), but that only helps a command that got there
        first: a scan that started moments earlier still owns the radio, and
        the command's own `async with lock` then waits it out. Setting this
        before waiting on the lock lets the *next* scan cycle skip this
        interface entirely, so the command waits for at most the one scan
        already in flight.

        Still needed under asyncio for the same reason it was under threads:
        a task waiting on the lock does not hold it, so a scan checking only
        `locked()` would cut ahead of a command that had been queued longer.
        """
        self._wifi_pending[interface] = self._wifi_pending.get(interface, 0) + 1
        try:
            yield
        finally:
            remaining = self._wifi_pending.get(interface, 1) - 1
            if remaining > 0:
                self._wifi_pending[interface] = remaining
            else:
                self._wifi_pending.pop(interface, None)

    def _wifi_command_pending(self, interface):
        return self._wifi_pending.get(interface, 0) > 0

    @staticmethod
    async def _run_wifi_command(fn, args):
        try:
            return await fn(*args)
        except Exception as e:
            return {"error": str(e)}

    async def connect_hotspot(self, ssid=None, password=None, bssid=None,
                              channel=None, interfaces=None):
        """Join one hotspot on several of this Pi's radios at once.

        The fleet use case this exists for is "put these four radios on that
        AP and watch what it does with them" - previously four separate
        connect_wifi commands, which had to be issued and correlated one at
        a time. Here they run concurrently: each radio takes only its own
        interface lock, so they neither serialise behind one another nor
        race on shared state.

        Note what is deliberately *not* shared: each radio associates
        independently, so a partial outcome is normal and is reported as
        such rather than collapsed into one pass/fail. `connected` is true
        only when every requested radio made it.
        """
        if isinstance(interfaces, str):
            interfaces = [interfaces]
        if not interfaces:
            return {"error": "interfaces is required"}
        if not ssid and not bssid:
            return {"error": "ssid or bssid is required"}

        # Deduplicated, order preserved: the same interface twice would
        # otherwise deadlock on its own lock.
        ordered = list(dict.fromkeys(interfaces))

        async def one(interface):
            async with self._wifi_pending_command(interface):
                async with self._wifi_lock_for(interface):
                    return await self.connect_wifi(ssid, password, interface, bssid, channel)

        outcomes = await asyncio.gather(*(one(i) for i in ordered), return_exceptions=True)

        results = []
        for interface, outcome in zip(ordered, outcomes):
            if isinstance(outcome, asyncio.CancelledError):
                raise outcome
            if isinstance(outcome, Exception):
                results.append({"interface": interface, "connected": False, "error": str(outcome)})
            else:
                results.append(outcome)

        connected = [r["interface"] for r in results if r.get("connected")]
        return {
            "ssid": ssid,
            "bssid": bssid,
            "channel": channel,
            "interfaces": ordered,
            "connected_interfaces": connected,
            "connected": len(connected) == len(ordered),
            "results": results,
        }

    def _dispatch_wifi_command(self, action, command_id, interface, fn, *args):
        """Runs connect_wifi/disconnect_wifi as its own task and publishes
        the result itself once done, instead of handle_command awaiting it
        inline.

        Under paho this had to leave the network thread or a slow command
        would starve the keepalive PINGREQ and get the client dropped
        mid-command (and with clean_session=True, anything sent during that
        window is discarded rather than queued). Under aiomqtt the same
        hazard exists in a different shape: the message loop can only pull
        the next command once the current one returns, so awaiting a 90s
        connect here would stall every other command on this Pi behind it.

        Fire-and-forget by design - the caller does not await this. Two
        commands aimed at the same interface still serialise on
        _wifi_lock_for; different interfaces run fully in parallel.
        """
        task = asyncio.create_task(
            self._run_dispatched_command(action, command_id, interface, fn, args)
        )
        # Keep a reference: asyncio only holds a weak one, so a task nobody
        # references can be garbage-collected mid-flight.
        self._wifi_tasks.add(task)
        task.add_done_callback(self._wifi_tasks.discard)
        return task

    async def _run_dispatched_command(self, action, command_id, interface, fn, args):
        if interface:
            # The pending mark covers the wait for the lock as well as the
            # run - the point is to stop *new* scans starting while we queue.
            async with self._wifi_pending_command(interface):
                async with self._wifi_lock_for(interface):
                    result = await self._run_wifi_command(fn, args)
        else:
            result = await self._run_wifi_command(fn, args)

        result["command_id"] = command_id
        result["action"] = action
        result["pi_id"] = self.pi_id
        result["timestamp"] = datetime.now(timezone.utc).isoformat()
        try:
            await self.publish(self.result_topic, json.dumps(result), qos=1)
        except Exception as e:
            print(f"[pi_agent] failed to publish result for {action}: {e}")
