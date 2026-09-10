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
    wpa_supplicant + dhcpcd, never NetworkManager - see the comment above
    _ensure_wpa_supplicant_running), monitor/managed mode switching, and
    the connect/disconnect/mode-switch dispatch machinery
    (_dispatch_wifi_command) shared with WifiScanMixin's background scan
    loop (both respect the same per-interface lock, see _wifi_lock_for)."""

    # get_link_info's result is cached by interface as a side effect of
    # every call, regardless of caller - see _cached_link_info. This is how
    # long get_wifi_scan_detail's connected_bssid lookup (wifi_scan.py) is
    # willing to trust a status-loop-populated entry before falling back to
    # its own `iw dev link` call: comfortably above the 5s
    # _interface_status_loop cadence (interfaces.py) that's the usual
    # producer, so one full cycle's worth of scheduling jitter doesn't
    # already force the fallback, but short enough that a real roam shows up
    # in scan results within a cycle or two.
    LINK_INFO_CACHE_MAX_AGE_SECONDS = 8

    async def get_link_info(self, interface):
        """Current association info for an interface (Pi acting as a station):
        connected BSSID, SSID, signal strength, bitrates, etc."""
        if not interface:
            return {"error": "interface is required"}

        out = (await proc.run(
            ["iw", "dev", interface, "link"],
        )).stdout

        if out.startswith("Not connected"):
            result = {"interface": interface, "connected": False}
            self._cache_link_info(interface, result)
            return result

        m = re.match(r'Connected to ([0-9a-fA-F:]+)', out)
        bssid = m.group(1) if m else None

        ssid_m = re.search(r'SSID:\s*(.+)', out)
        freq_m = re.search(r'freq:\s*(\d+)', out)
        signal_m = re.search(r'signal:\s*(-?\d+)\s*dBm', out)
        rx_bitrate_m = re.search(r'rx bitrate:\s*([\d.]+)\s*MBit/s', out)
        tx_bitrate_m = re.search(r'tx bitrate:\s*([\d.]+)\s*MBit/s', out)

        result = {
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
        result.update(await self._wpa_link_extras(interface))
        result["radio_type"] = self._radio_type(result.get("wifi_generation"), out, result.get("band"))
        self._cache_link_info(interface, result)
        return result

    # wpa_supplicant's `wifi_generation` status field (recent wpa_supplicant
    # + driver support only) is the most direct source: it names the PHY
    # generation actually negotiated, not just what the radio is capable of.
    # 7/8 aren't standardized yet as of this writing but are mapped for
    # forward compat rather than falling through to the raw-output guess.
    WIFI_GENERATION_STANDARD = {
        "4": "802.11n", "5": "802.11ac", "6": "802.11ax", "7": "802.11be", "8": "802.11bn",
    }

    @staticmethod
    def _radio_type(wifi_generation, link_out, band):
        """Best-effort label for the 802.11 standard actually in use on this
        association - not the radio's own maximum capability. Prefers
        wpa_supplicant's own `wifi_generation` status field when the driver
        reports it; otherwise falls back to the HE-MCS/VHT-MCS/MCS tag that
        `iw dev <if> link` prints on its rx/tx bitrate lines (present only
        when that generation's rate is actually the one in use), and as a
        last resort assumes a legacy (non-HT) rate means 802.11a on 5/6GHz
        or 802.11g on 2.4GHz - correct for effectively every AP still seen
        in the wild, though a genuine 802.11b-only association would be
        mislabeled since bitrate alone can't tell the two apart."""
        standard = WifiMixin.WIFI_GENERATION_STANDARD.get(wifi_generation)
        if standard:
            return standard
        if re.search(r'\bEHT-MCS\b', link_out):
            return "802.11be"
        if re.search(r'\bHE-MCS\b', link_out):
            return "802.11ax"
        if re.search(r'\bVHT-MCS\b', link_out):
            return "802.11ac"
        if re.search(r'\bMCS\b', link_out):
            return "802.11n"
        if band in ("5GHz", "6GHz"):
            return "802.11a"
        if band == "2.4GHz":
            return "802.11g"
        return None

    async def _wpa_link_extras(self, interface):
        """Fields `iw dev link` doesn't carry, pulled from wpa_supplicant
        instead: security/auth details from `wpa_cli status`, and
        noise/link-speed/average-RSSI from `wpa_cli signal_poll` (driver-
        dependent - fields wpa_supplicant couldn't get from the kernel come
        back as "9999"/absent rather than as an error). Best-effort only:
        if wpa_supplicant isn't the one managing this interface (or its
        control socket isn't up), both calls just fail and callers still
        get whatever `iw` found."""
        extras = {}

        status = await self._current_wpa_status(interface)
        if status:
            extras["key_mgmt"] = status.get("key_mgmt")
            extras["pairwise_cipher"] = status.get("pairwise_cipher")
            extras["group_cipher"] = status.get("group_cipher")
            extras["wpa_state"] = status.get("wpa_state")
            extras["ip_address"] = status.get("ip_address")
            extras["address"] = status.get("address")
            extras["wifi_generation"] = status.get("wifi_generation")

        signal_ret = await self._wpa_cli(interface, "signal_poll")
        if signal_ret.returncode == 0:
            signal = {}
            for line in signal_ret.stdout.splitlines():
                key, sep, value = line.partition("=")
                if sep:
                    signal[key] = value

            def _int_field(key):
                value = signal.get(key)
                if value is None or value == "9999":
                    return None
                try:
                    return int(value)
                except ValueError:
                    return None

            extras["noise_dbm"] = _int_field("NOISE")
            extras["avg_signal_dbm"] = _int_field("AVG_RSSI")
            extras["link_speed_mbps"] = _int_field("LINKSPEED")
            extras["channel_width"] = signal.get("WIDTH")

        return extras

    def _cache_link_info(self, interface, result):
        self._link_info_cache[interface] = (asyncio.get_running_loop().time(), result)

    def _cached_link_info(self, interface, max_age=LINK_INFO_CACHE_MAX_AGE_SECONDS):
        """A recent get_link_info() result for `interface`, if one is fresh
        enough - None on a cold or stale cache, leaving the fallback to the
        caller (see get_wifi_scan_detail)."""
        cached = self._link_info_cache.get(interface)
        if cached is None:
            return None
        cached_at, result = cached
        if asyncio.get_running_loop().time() - cached_at > max_age:
            return None
        return result

    async def _default_gateway_for(self, interface):
        """This interface's gateway, checked in its own per-interface
        routing table first (see _routing_table_for), falling back to the
        main table's default route.

        Nothing currently populates that per-interface table - the nmcli-
        based step that used to (ipv4.route-table/ipv4.routing-rules) was
        removed along with every other NetworkManager dependency in
        connect/disconnect. The table lookup is left in as a harmless no-op
        fallback rather than deleted outright: if per-interface policy
        routing is set up some other way in the future (a static `ip rule`
        at boot, say), this starts finding gateways there for free. Until
        then, this only ever resolves for whichever interface the kernel
        picked as the actual system default - every other connected wifi
        interface's gateway comes back None."""
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

    # --- wpa_supplicant-based connect/disconnect ---------------------------
    # Association is wpa_supplicant's job, driven via its wpa_cli control
    # interface (add_network/set_network/select_network); dhcpcd
    # (Raspberry Pi OS's default DHCP client) gets the interface its IP once
    # wpa_supplicant reports wpa_state=COMPLETED. Neither of those steps
    # touches NetworkManager, and nothing here does either any more -
    # connect/disconnect/scan used to each reach for `nmcli` at some point
    # (device wifi connect, device set managed no/yes, device disconnect),
    # but every one of those calls was removed:
    #  - wl* interfaces are already marked unmanaged fleet-wide
    #    (99-pi-agent-unmanaged-wifi.conf), so there was never anything for
    #    a runtime "managed no" to actually change.
    #  - the "managed yes" handback on disconnect was pure bookend symmetry,
    #    not something the disconnect itself depended on - and it was the
    #    confirmed cause of a real incident: several interfaces disconnecting
    #    at once each handed control back to NetworkManager simultaneously,
    #    NM's own per-device reconnect/scan activity piled up across all of
    #    them, and the resulting contention was enough to drop the agent's
    #    own MQTT connection to the broker for a few seconds.
    #  - the no-control-socket disconnect fallback used `nmcli device
    #    disconnect`; it now sends the kernel a direct `iw ... disconnect`
    #    instead, which does the same job without going through NM at all.
    # This hasn't been run against real hardware - the exact dhcpcd/NM
    # interaction (dhcpcd.service already managing every interface
    # system-wide vs. this ad hoc per-call invocation) should be verified
    # on the fleet before relying on it. A second, separate incident -
    # several radios connecting concurrently and taking the whole Pi offline
    # - pointed at the sheer subprocess/thread volume of a multi-interface
    # connect_wifi burst (roughly a dozen subprocess spawns per interface),
    # not at NetworkManager; _wifi_connect_semaphore below caps how many
    # interfaces can be mid-connect at once as a mitigation for that, pending
    # confirmation on hardware (dmesg for OOM kills, TasksMax vs
    # TasksCurrent on the systemd unit). disconnect_wifi has its own,
    # separate _wifi_disconnect_semaphore - the two used to share one
    # semaphore, which meant a disconnect could sit queued behind a slow
    # connect (up to ~95s: 60s association wait + 35s DHCP wait) on any Pi
    # busy enough to have both semaphore slots occupied by connects -
    # confirmed as the reason disconnects measured slower on busier Pis even
    # though disconnect_wifi's own code path never changed.

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
        second, conflicting one).

        No NetworkManager involvement: wl* interfaces are already marked
        unmanaged fleet-wide (99-pi-agent-unmanaged-wifi.conf), so there is
        nothing for a runtime "managed no" to change here - just bring the
        link up directly."""
        if self._wpa_ctrl_socket_exists(interface):
            return True, ""

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

    async def _current_wpa_status(self, interface):
        """Parsed `wpa_cli status` output as a dict (wpa_state, id, ssid,
        etc.). _current_wpa_state used to parse only wpa_state directly -
        factored out because _wait_for_wpa_state also needs `id`, to tell
        "reached the target state" apart from "still reading a state that
        actually belongs to the network we were on before this call"."""
        ret = await self._wpa_cli(interface, "status")
        if ret.returncode != 0:
            return None
        status = {}
        for line in ret.stdout.splitlines():
            key, sep, value = line.partition("=")
            if sep:
                status[key] = value
        return status

    async def _current_wpa_state(self, interface):
        status = await self._current_wpa_status(interface)
        return status.get("wpa_state") if status else None

    async def _wait_for_wpa_state(self, interface, target_state, timeout=60, expected_net_id=None, expected_bssid=None):
        """Wait for wpa_supplicant to reach `target_state`.

        Listens on the control socket rather than polling `status` once a
        second, which buys two things. Latency: an association that
        completes 100ms in is seen at 100ms. And failure detail: the async
        events carry reason/status codes that a state poll never shows, so
        a rejected association can stop waiting immediately instead of
        sitting out the full timeout - and self.last_wpa_failure records
        *why* for the connect result to report.

        expected_net_id guards against a false positive when switching
        networks on an interface that was already connected: right after
        select_network, a `status` query can still momentarily report the
        *previous* network's wpa_state=COMPLETED before wpa_supplicant has
        actually processed the switch - matching on state alone let that
        stale read pass as "already there", so connect_wifi went on to run
        DHCP against an interface that was, in reality, still mid-teardown
        of the old association. That reliably failed the first attempt (no
        working association to get an IP from) even though the switch
        itself then completed correctly moments later - which is what a
        following retry (or the user just trying again) succeeding looked
        like. When given, a state match only counts once `status["id"]`
        (the network id wpa_supplicant is currently active on) also
        matches the one just selected - the previous association had a
        different id, so its lingering COMPLETED can't be mistaken for
        this one any more.

        expected_bssid guards the failure side the same way expected_net_id
        guards the success side. connect_wifi's own network block pins a
        specific bssid when one was given (set_network ... bssid), but
        wpa_supplicant's config accumulates a network block per past
        connect_wifi call (every call ends in save_config, none of them
        clean up an older one) - so a FAILURE_EVENTS line arriving on this
        same control socket can belong to wpa_supplicant's own background
        scanning/roaming against an *older* saved network for the same SSID,
        not to this call's attempt. A rejection naming a different bssid
        than the one this call pinned gets skipped rather than reported as
        this attempt's own failure_reason - confirmed as a real case, not a
        hypothetical: a "Kaon-Guest" connect pinned to one BSSID came back
        with a CTRL-EVENT-ASSOC-REJECT for a completely different one. Only
        applies when this call actually pinned a bssid and the event itself
        names one; an SSID-only connect (bssid=None) has no such signal to
        filter on and keeps the old trust-the-event behavior.

        Falls back to polling when the socket isn't attachable (no
        AF_UNIX, wpa_supplicant not running with a control interface, or
        permissions), so behavior degrades rather than breaks.
        """
        self.last_wpa_failure = None

        async def matches():
            status = await self._current_wpa_status(interface)
            if not status or status.get("wpa_state") != target_state:
                return False
            if expected_net_id is not None and status.get("id") != str(expected_net_id):
                return False
            return True

        async def poll_fallback():
            # Same "never leave a failure unexplained" rule as the event
            # path below - see _wpa_timeout_reason.
            if await self._poll_for_wpa_state(matches, timeout):
                return True
            self.last_wpa_failure = self._wpa_timeout_reason(target_state, timeout)
            return False

        listener = wpa_events.WpaEventListener(interface)
        if not listener.available:
            return await poll_fallback()

        try:
            await listener.attach()
        except (OSError, RuntimeError, asyncio.TimeoutError) as e:
            print(f"[pi_agent] {interface}: wpa control socket unavailable ({e}), polling instead")
            return await poll_fallback()

        try:
            # Check once up front: the target state may already have been
            # reached between select_network and the ATTACH above, and no
            # further event would ever announce it.
            if await matches():
                return True

            async for line in listener.events(timeout=timeout):
                name, fields = wpa_events.parse_event(line)
                if name == "CTRL-EVENT-CONNECTED" and target_state == "COMPLETED":
                    # The event alone doesn't carry the network id - it
                    # fires on any completed association, old or new - so
                    # still confirm via matches() rather than trusting the
                    # event name by itself.
                    if await matches():
                        return True
                    continue
                if name in wpa_events.FAILURE_EVENTS:
                    event_bssid = fields.get("bssid")
                    if expected_bssid and event_bssid and event_bssid.lower() != expected_bssid.lower():
                        # Someone else's rejection (an older saved network
                        # for this SSID, still enabled) - not a verdict on
                        # the bssid this call actually pinned. Keep waiting.
                        continue
                    self.last_wpa_failure = f"{name} {' '.join(f'{k}={v}' for k, v in fields.items())}".strip()
                    return False
                if name.startswith("CTRL-EVENT-"):
                    # Any state-ish transition: confirm against the real
                    # state rather than trying to map every event name.
                    if await matches():
                        return True
            self.last_wpa_failure = self._wpa_timeout_reason(target_state, timeout)
            return False
        finally:
            await listener.detach()

    @staticmethod
    def _wpa_timeout_reason(target_state, timeout):
        """Why a wait ended with nothing to report.

        A rejected association names itself (CTRL-EVENT-ASSOC-REJECT and
        friends), but running out the clock does not - and without this the
        result went back to the UI as `connected: false` with an entirely
        empty failure_reason, indistinguishable from a command that never
        ran or a crashed agent. Silence here is itself informative: it means
        wpa_supplicant kept scanning and neither reached the state nor was
        turned away, which in practice means the requested BSSID/SSID was
        never seen on air (an AP that moved channel, a hotspot that rotated
        its MAC or went to sleep, or one simply out of range)."""
        return (
            f"timed out after {timeout}s waiting for wpa_state={target_state} - "
            "wpa_supplicant reported no rejection, so the requested BSSID/SSID "
            "was most likely never found on air"
        )

    async def _poll_for_wpa_state(self, matches, timeout):
        """Pre-control-socket fallback: ask `status` once a second."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            if await matches():
                return True
            await asyncio.sleep(1)
        return False

    # How long connect_wifi waits for an address to actually land on the
    # interface after handing off to dhcpcd. Sized against the lease
    # negotiations seen on real hardware (solicit to lease is typically
    # 5-8s, occasionally longer when several radios negotiate at once), not
    # against dhcpcd's own -t, which bounds a different thing entirely.
    DHCP_IP_WAIT_SECONDS = 30

    async def _wait_for_interface_ip(self, interface, timeout=None):
        """Poll until `interface` has an IPv4 address, or `timeout` elapses.

        connect_wifi used to read the address exactly once, immediately
        after the dhcpcd call returned - which quietly assumed dhcpcd only
        returns once a lease is in place. It does not. When a dhcpcd daemon
        is already running on this Pi, `dhcpcd -n` is a control client: it
        hands the rebind to the running daemon ("sending commands to dhcpcd
        process"), exits in milliseconds, and the negotiation carries on in
        the background for several seconds afterwards. The single read then
        found no address yet, so `connected` came back false with an empty
        failure_reason - on a connect that had in fact associated fine and
        picked up its lease moments later. That empty failure_reason is the
        tell: nothing failed, we just looked too early.

        Polling covers both dhcpcd modes rather than special-casing either,
        and costs one extra `ip addr show` in the common case where the
        address is already there.
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + (self.DHCP_IP_WAIT_SECONDS if timeout is None else timeout)
        while True:
            ip_address = await self.get_interface_ip(interface)
            if ip_address:
                return ip_address
            if loop.time() >= deadline:
                return None
            await asyncio.sleep(0.5)

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

    # max_standard -> wpa_supplicant network-block flags that cap which
    # 802.11 PHY the association is allowed to negotiate at. wpa_supplicant
    # has no single "use at most 802.11n" knob - each newer amendment is
    # disabled independently (disable_eht blocks 802.11be, disable_he also
    # blocks 802.11ax, disable_vht also blocks 802.11ax since HE needs VHT
    # capabilities advertised, disable_ht additionally blocks 802.11n,
    # leaving 802.11a/g). So each tier disables everything above it. "be" is
    # the current ceiling (no flags disabled - whatever the radio/driver
    # itself supports); "legacy" is the floor below 802.11n (a/g only, no
    # 11n/ac/ax/be) - there is no separate a-vs-g knob here since that's a
    # band choice (see channel/scan_freq), not a PHY standard one.
    # disable_eht requires a wpa_supplicant build new enough to know the
    # flag (2.11+) - on an older build it's just an unrecognized network
    # param wpa_supplicant ignores, so "be"/"ax" behave the same there.
    MAX_STANDARD_NETWORK_FLAGS = {
        "be": {},
        "ax": {"disable_eht": "1"},
        "ac": {"disable_eht": "1", "disable_he": "1"},
        "n": {"disable_eht": "1", "disable_he": "1", "disable_vht": "1"},
        "legacy": {"disable_eht": "1", "disable_he": "1", "disable_vht": "1", "disable_ht": "1"},
    }

    async def connect_wifi(self, ssid, password=None, interface=None, bssid=None, channel=None,
                            max_standard=None):
        """Connect to a wifi hotspot via wpa_supplicant + dhcpcd - see the
        module-level comment above for why NetworkManager is never involved.

        If bssid is given without ssid, the SSID is resolved by looking that
        BSSID up in a scan (get_wifi_scan_detail, WifiScanMixin) -
        wpa_supplicant's network blocks are keyed by ssid. If channel is
        given, the connection is pinned to that channel's frequency
        (scan_freq) - useful when the same SSID is broadcast on multiple
        bands/channels and a specific one needs to be tested.

        max_standard optionally caps the 802.11 PHY standard the association
        is allowed to negotiate at - one of "ax", "ac", "n", "legacy" (a/g
        only) - via wpa_supplicant's disable_he/disable_vht/disable_ht
        network flags (see MAX_STANDARD_NETWORK_FLAGS). Useful for testing
        an AP/CPE's behavior with a client artificially limited to an older
        standard (e.g. confirming it still serves 802.11n-only stations
        correctly). None/omitted keeps wpa_supplicant's own default (highest
        the radio+driver support).

        The actual work (from _ensure_wpa_supplicant_running onward) runs
        under _wifi_connect_semaphore, capping how many interfaces can be
        mid-connect at once - a multi-interface connect burst (connect_hotspot,
        or several interfaces connected together from the UI) spawns roughly
        a dozen subprocesses per interface; uncapped, four at once was enough
        to take a Pi offline. bssid resolution runs outside the semaphore -
        it's a scan-cache read, not part of the subprocess burst this exists
        to bound. disconnect_wifi deliberately does not share this semaphore
        - see _wifi_disconnect_semaphore for why.
        """
        if not interface:
            return {"error": "interface is required"}
        if not ssid and not bssid:
            return {"error": "ssid is required"}
        if max_standard is not None and max_standard not in self.MAX_STANDARD_NETWORK_FLAGS:
            return {"error": f"max_standard must be one of {sorted(self.MAX_STANDARD_NETWORK_FLAGS)}"}

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
        elif bssid and channel:
            # A channel passed in alongside an already-known ssid can still
            # be stale - e.g. from nearby_hotspots' backend-cached scan
            # result (routers/Pis.get_nearby_hotspots), which is only as
            # fresh as this radio's last completed background scan, not
            # this exact instant. Pinning scan_freq to a channel the AP has
            # since moved off of doesn't fail cleanly: wpa_supplicant just
            # scans forever looking for that exact (bssid, frequency) pair
            # and never finds it (wpa_state stays SCANNING) instead of
            # reporting a clean failure. A cache-first lookup (milliseconds,
            # no fresh radio scan) is enough to catch a channel that moved
            # since it was cached; the earlier bssid-without-ssid branch
            # above already does the same kind of check for its own case.
            match = await self._find_bssid_in_scan(interface, bssid, use_cache=True)
            if match and match.get("channel") and match["channel"] != channel:
                print(f"[pi_agent] {interface}: {bssid} is now on channel "
                      f"{match['channel']}, not the requested {channel} - using the current one")
                channel = match["channel"]

        async with self._wifi_connect_semaphore:
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
            # wpa_cli rejects (FAIL, not an exception) a network param its
            # build of wpa_supplicant doesn't know - disable_he/disable_eht
            # are only understood by builds new enough to have HE/EHT
            # support at all, so an older wpa_supplicant silently keeps
            # negotiating whatever the driver/AP support instead of capping
            # anything. Tracked separately from `outputs` (which still
            # carries every raw response for debugging) so the caller can
            # tell "capped as requested" apart from "connected anyway,
            # cap never took" instead of both looking like a plain success.
            max_standard_unsupported_flags = []
            for flag, value in self.MAX_STANDARD_NETWORK_FLAGS.get(max_standard, {}).items():
                flag_ret = await self._wpa_cli(interface, "set_network", net_id, flag, value)
                outputs.append(flag_ret.stdout.strip())
                if flag_ret.stdout.strip() != "OK":
                    max_standard_unsupported_flags.append(flag)

            await self._wpa_cli(interface, "enable_network", net_id)
            await self._wpa_cli(interface, "select_network", net_id)
            await self._wpa_cli(interface, "save_config")

            associated = await self._wait_for_wpa_state(interface, "COMPLETED", timeout=60, expected_bssid=bssid)
            ip_address = None
            dhcp_output = ""
            if associated:
                # detach_output: dhcpcd daemonizes, and a daemon holding our
                # stdout/stderr pipes open kept communicate() waiting out the
                # full timeout below on calls that had already done their job
                # - see proc.run_hard.
                dhcp_ret = await proc.run_hard(
                    ["dhcpcd", "-n", "-t", "30", interface], timeout=35, detach_output=True,
                )
                dhcp_output = (dhcp_ret.stdout or dhcp_ret.stderr).strip()
                # Not a single read: dhcpcd returning does not mean a lease
                # is in place - see _wait_for_interface_ip.
                ip_address = await self._wait_for_interface_ip(interface)
                if not ip_address:
                    # Association worked, DHCP did not. Worth naming
                    # explicitly: it is the one failure here that says the
                    # radio and the PSK were both fine, so the next place to
                    # look is the AP's DHCP server (or a client cap it
                    # enforces by handing out no lease), not the wifi config.
                    self.last_wpa_failure = (
                        f"associated but no IPv4 address after "
                        f"{self.DHCP_IP_WAIT_SECONDS}s - DHCP did not complete"
                    )

        connected = associated and bool(ip_address)

        return {
            "ssid": ssid,
            "bssid": bssid,
            "interface": interface,
            "channel": channel,
            "max_standard": max_standard,
            # False (not None) specifically when max_standard was requested
            # but at least one of its wpa_supplicant network flags came back
            # FAIL - i.e. connected, but not actually capped as asked. None
            # when max_standard wasn't requested at all, True when every
            # flag for the requested tier was accepted.
            "max_standard_applied": (
                None if max_standard is None else not max_standard_unsupported_flags
            ),
            "connected": connected,
            "ip_address": ip_address,
            # Populated from the control socket when association was
            # rejected - the reason/status code a status poll never showed.
            "failure_reason": getattr(self, "last_wpa_failure", None),
            "output": " | ".join(o for o in (*outputs, dhcp_output) if o),
        }

    async def disconnect_wifi(self, interface=None):
        """Tear down this interface's association, without touching
        NetworkManager anywhere in the process (see the module-level
        comment above for why - the "hand it back to NM" step this used to
        end with was the confirmed cause of a real MQTT-drop incident when
        several interfaces disconnected together).

        These run strictly one after another, so every timeout here is
        additive on the caller's round-trip. They are hang budgets, not
        expected durations - each of these is normally sub-second."""
        if not interface:
            return {"error": "interface is required"}

        async with self._wifi_disconnect_semaphore:
            outputs = []
            if self._wpa_ctrl_socket_exists(interface):
                term_ret = await self._wpa_cli(interface, "terminate", timeout=5)
                outputs.append((term_ret.stdout or term_ret.stderr).strip())
            else:
                # No control socket - not a state this agent put the
                # interface in (maybe it never got here, maybe wpa_supplicant
                # died). `iw ... disconnect` tells the kernel directly to
                # drop any association regardless of what set it up, the
                # same job `nmcli device disconnect` used to do but without
                # depending on NM being involved at all.
                iw_ret = await proc.run(["iw", "dev", interface, "disconnect"], timeout=10)
                outputs.append((iw_ret.stdout or iw_ret.stderr).strip())

            # Unconditional now, unlike before: this branch used to rely on
            # nmcli's own disconnect to also release any DHCP lease, which
            # only worked because NM was involved. Nothing does that for us
            # any more, so the lease has to be released explicitly here
            # regardless of which branch tore down the association.
            dhcp_ret = await proc.run_hard(["dhcpcd", "-k", interface], timeout=8)
            outputs.append((dhcp_ret.stdout or dhcp_ret.stderr).strip())

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
        """Sets a monitor-mode interface's capture channel via `iw`. A
        monitor-mode interface has no SSID/association to manage - NM
        doesn't touch it, same as connect_wifi/disconnect_wifi/scan don't
        touch NM any more either - and `iw` is the only tool that can set
        its channel. Band isn't a separate parameter -
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

        NetworkManager never owns any wl* interface here any more (see
        99-pi-agent-unmanaged-wifi.conf) - a live association, if any, is
        owned by our own standalone wpa_supplicant (connect_wifi), not by
        NM. The nmcli disconnect/managed-no this used to run before the
        delete were no-ops against a device NM doesn't manage, which left
        wpa_supplicant still attached when the switch deleted its netdev
        out from under it - `iw dev del` then either failed outright or
        left wpa_supplicant orphaned, which is why a switch to monitor mode
        while connected used to fail. Tearing wpa_supplicant/dhcpcd down
        properly first (the same steps disconnect_wifi takes) avoids that
        instead of racing it."""
        if mode == "monitor":
            if self._wpa_ctrl_socket_exists(interface):
                await self._wpa_cli(interface, "terminate", timeout=5)
                await proc.run_hard(["dhcpcd", "-k", interface], timeout=8)
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

    # Staggers each radio's association attempt within one connect_hotspot
    # call - see the docstring below for why. Kept small: the point is to
    # spread out the burst of auth/assoc/EAPOL frames each radio's attempt
    # opens with, not to seriously slow the whole batch down (8 radios at
    # this stagger adds under 3s of spread against connects that each
    # individually take several seconds anyway).
    CONNECT_HOTSPOT_STAGGER_SECONDS = 0.4

    async def connect_hotspot(self, ssid=None, password=None, bssid=None,
                              channel=None, interfaces=None, max_standard=None):
        """Join one hotspot on several of this Pi's radios at once.

        The fleet use case this exists for is "put these four radios on that
        AP and watch what it does with them" - previously four separate
        connect_wifi commands, which had to be issued and correlated one at
        a time. Each radio takes only its own interface lock, so they never
        serialise behind one another or race on shared state - but their
        association attempts are staggered by CONNECT_HOTSPOT_STAGGER_SECONDS
        rather than launched in the same instant. A real fleet test hitting
        one AP with 8+ radios at once (several Pis' connect_hotspot/fan-out
        connects landing together) reliably failed some of them - a burst of
        that many simultaneous auth/assoc/4-way-handshake attempts can trip
        an AP's client cap, overload its handshake handling, or just cause
        genuine airtime contention - none of which shows up when connecting
        one radio at a time by hand, since nothing else is competing for the
        AP's attention at that instant. Spreading the starts out removes the
        burst without meaningfully slowing the batch down.

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

        # A caller can hand this an interface name that no longer exists - a
        # stale cached list (e.g. a Nearby Hotspot card's seen_by, built from
        # an old scan snapshot) surviving a USB radio being unplugged is the
        # case this was written for. Reject those up front rather than
        # letting connect_wifi discover it deep inside `ip link set <gone>
        # up`/wpa_supplicant, where the failure is easy to lose track of
        # amid the interfaces that *did* connect - see the same live check
        # _resolve_scan_interfaces (wifi_scan.py) already does for scans.
        known = {d["name"] for d in await self.get_interface_details()}
        present = [i for i in ordered if i in known]
        missing = [i for i in ordered if i not in known]

        async def one(interface, delay):
            if delay:
                await asyncio.sleep(delay)
            async with self._wifi_pending_command(interface):
                async with self._wifi_lock_for(interface):
                    return await self.connect_wifi(ssid, password, interface, bssid, channel, max_standard)

        outcomes = await asyncio.gather(
            *(one(i, idx * self.CONNECT_HOTSPOT_STAGGER_SECONDS) for idx, i in enumerate(present)),
            return_exceptions=True,
        )

        by_interface = {}
        for interface in missing:
            by_interface[interface] = {"interface": interface, "connected": False, "error": "no such interface"}
        for interface, outcome in zip(present, outcomes):
            if isinstance(outcome, asyncio.CancelledError):
                raise outcome
            if isinstance(outcome, Exception):
                by_interface[interface] = {"interface": interface, "connected": False, "error": str(outcome)}
            else:
                by_interface[interface] = outcome
        results = [by_interface[i] for i in ordered]

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
