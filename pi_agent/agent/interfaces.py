import asyncio
import json
import re
import socket
import uuid
from datetime import datetime, timezone

from . import proc


class InterfacesMixin:
    """Interface introspection (names/details/IPs), the AP-side signal-stats
    dump, the ping diagnostic, and the background loop that keeps the
    backend's InterfaceStatus buffer fresh. Relies on WifiMixin's
    get_link_info and _wifi_lock_for for the wifi-specific fields."""

    async def get_signal_stats(self):
        """Pull RSSI / link stats for connected stations (Pi acting as AP)."""
        out = (await proc.run(
            ["iw", "dev", "wlan0", "station", "dump"],
        )).stdout
        return out.strip()

    async def ping_internet(self, interface=None, target=None, count=5):
        target = target or "8.8.8.8"
        count = int(count) if count else 5

        if interface:
            await proc.run(["ip", "neigh", "flush", "dev", interface], timeout=10)

        cmd = ["ping", target]
        if interface:
            cmd += ["-I", interface]
        cmd += ["-c", str(count)]
        ret = await proc.run(cmd, timeout=count * 2 + 5)

        stats_match = re.search(
            r'(\d+) packets transmitted, (\d+) (?:packets )?received, '
            r'(?:\+\d+ errors, )?(\d+)% packet loss(?:, time (\d+)ms)?',
            ret.stdout,
        )
        rtt_match = re.search(
            r'(?:rtt|round-trip) min/avg/max/mdev = '
            r'([\d.]+)/([\d.]+)/([\d.]+)/([\d.]+) ms',
            ret.stdout,
        )

        result = {
            "interface": interface,
            "target": target,
            "count": count,
            "packet_lost": int(stats_match.group(3)) if stats_match else None,
            "packets_transmitted": int(stats_match.group(1)) if stats_match else None,
            "packets_received": int(stats_match.group(2)) if stats_match else None,
            "time_ms": int(stats_match.group(4)) if stats_match and stats_match.group(4) else None,
            "rtt_min_ms": float(rtt_match.group(1)) if rtt_match else None,
            "rtt_avg_ms": float(rtt_match.group(2)) if rtt_match else None,
            "rtt_max_ms": float(rtt_match.group(3)) if rtt_match else None,
            "rtt_mdev_ms": float(rtt_match.group(4)) if rtt_match else None,
        }
        if not stats_match:
            result["raw_output"] = ret.stdout.strip() or ret.stderr.strip()
        return result

    async def get_network_interfaces(self):
        """List local network interface names (excluding loopback)."""
        out = (await proc.run(
            ["ip", "-o", "link", "show"],
        )).stdout
        interfaces = []
        for line in out.splitlines():
            m = re.match(r'^\d+:\s+([^:@]+)', line)
            if m and m.group(1) != "lo":
                interfaces.append(m.group(1))
        return interfaces

    async def _bulk_interface_addrs(self):
        """Every interface's addresses in one `ip -o addr show` call, bucketed
        by name into (ipv4, ipv6) - what get_interface_details used to get by
        calling get_interface_ip/get_interface_ipv6 per interface, which for
        N interfaces was 2N separate subprocess spawns (plus the `ip link
        show` itself) on every single call. That N+1 pattern, hit every 5-6s
        by two independent background loops, was burning enough of the
        agent's own CPU under real load to help starve the asyncio event
        loop - see the MQTT operation-timeout bump in run() for the other
        half of that story. One unfiltered listing costs the same as one
        single-interface one and answers for every interface at once.

        ipv6 keeps get_interface_ipv6's preference for a global address over
        a link-local fe80::/10 one (present on every up interface regardless
        of real IPv6 connectivity), falling back to link-local only if
        that's all there is.
        """
        out = (await proc.run(["ip", "-o", "addr", "show"])).stdout
        ipv4, ipv6_candidates = {}, {}
        for line in out.splitlines():
            m = re.match(r'^\d+:\s+([^:@\s]+)(?:@\S+)?\s+inet(6)?\s+([0-9a-fA-F.:]+)/\d+', line)
            if not m:
                continue
            name, is_v6, addr = m.group(1), m.group(2), m.group(3)
            if is_v6:
                ipv6_candidates.setdefault(name, []).append(addr)
            else:
                ipv4.setdefault(name, addr)
        ipv6 = {}
        for name, addrs in ipv6_candidates.items():
            global_addrs = [a for a in addrs if not a.startswith("fe80:")]
            ipv6[name] = global_addrs[0] if global_addrs else addrs[0]
        return ipv4, ipv6

    async def get_interface_details(self):
        """Per-interface details (excluding loopback): MAC, link state, MTU,
        and type (wifi/ethernet/other) - richer than get_network_interfaces's
        plain name list, for the list_interfaces UI table."""
        link_out, (ipv4_by_name, ipv6_by_name) = await asyncio.gather(
            proc.run(["ip", "-o", "link", "show"]),
            self._bulk_interface_addrs(),
        )
        details = []
        for line in link_out.stdout.splitlines():
            head = re.match(r'^\d+:\s+([^:@]+)(?:@\S+)?:\s+<(\S*)>', line)
            if not head:
                continue
            name = head.group(1)
            if name == "lo":
                continue
            flags = head.group(2).split(",") if head.group(2) else []

            state_m = re.search(r'\bstate (\S+)', line)
            link_m = re.search(r'link/(\S+)\s+([0-9a-fA-F:]{17})?', line)
            link_type = link_m.group(1) if link_m else None

            details.append({
                "name": name,
                "mac_address": link_m.group(2) if link_m else None,
                "state": state_m.group(1) if state_m else ("UP" if "UP" in flags else "DOWN"),
                "flags": flags,
                # A monitor-mode interface reports link/ieee802.11/radiotap
                # (confirmed from an actual `ip -o link show` on the fleet -
                # it's "ieee802.11/radiotap" with a slash, not the commonly
                # assumed "ieee802.11_radiotap" with an underscore) regardless
                # of its name (mon0, wlan0mon, whatever it was created as) -
                # a reliable signal, unlike station/AP mode wifi, which
                # reports link/ether just like plain ethernet does and so
                # still has to be told apart by name prefix.
                "type": "monitor" if link_type and "radiotap" in link_type else
                        ("wifi" if name.startswith(("wl", "wlan")) else
                         ("ethernet" if link_type == "ether" else link_type)),
                "ip_address": ipv4_by_name.get(name),
                "ipv6_address": ipv6_by_name.get(name),
            })
        return details

    # Shared by _wifi_background_scan_loop (wifi_scan.py) and
    # _interface_status_loop below - their timers are close enough (6s and
    # 5s) that, left to call get_interface_details independently, they'd
    # regularly pay for two full `ip link`/`ip addr` round trips within a
    # second of each other for the exact same answer. Deliberately NOT used
    # by command-triggered paths (list_interfaces, connect_wifi's own
    # lookups, nearby_hotspots/_resolve_scan_interfaces) - those are one-shot
    # user actions that want this instant's real state, not up to
    # INTERFACE_DETAILS_CACHE_TTL_SECONDS stale.
    INTERFACE_DETAILS_CACHE_TTL_SECONDS = 2

    async def get_cached_interface_details(self):
        loop = asyncio.get_running_loop()
        if self._interface_details_cache is not None and \
                loop.time() - self._interface_details_cache_at < self.INTERFACE_DETAILS_CACHE_TTL_SECONDS:
            return self._interface_details_cache
        async with self._interface_details_cache_lock:
            # Re-check after acquiring: a racing caller may have just
            # refreshed it while this one waited for the lock.
            if self._interface_details_cache is not None and \
                    loop.time() - self._interface_details_cache_at < self.INTERFACE_DETAILS_CACHE_TTL_SECONDS:
                return self._interface_details_cache
            details = await self.get_interface_details()
            self._interface_details_cache = details
            self._interface_details_cache_at = loop.time()
            return details

    async def _wired_source_ip(self):
        """IP address of a connected wired interface, if any - used to bind
        the MQTT connection's local socket to it (see run()), so the
        agent's control-plane traffic prefers wired over wifi whenever both
        are up, without touching system-wide routing."""
        for iface in await self.get_interface_details():
            if iface["type"] == "ethernet" and iface["state"] == "UP" and iface["ip_address"]:
                return iface["ip_address"]
        return None

    async def get_interface_ip(self, interface, family="4"):
        """Best-effort address currently assigned to a given interface.
        family="4" (default) returns the IPv4 address, unchanged from
        before. family="6" returns an IPv6 address, preferring a global
        (routable) one over a link-local fe80::/10 address - every
        interface has a link-local address just from being up, so it's
        rarely what's actually useful to show; global is only reported
        once real IPv6 connectivity/autoconf has happened."""
        if not interface:
            return None
        out = (await proc.run(
            ["ip", f"-{family}", "-o", "addr", "show", interface],
        )).stdout
        if family == "6":
            addrs = re.findall(r'inet6 ([0-9a-fA-F:]+)/\d+', out)
            global_addrs = [a for a in addrs if not a.startswith("fe80:")]
            return global_addrs[0] if global_addrs else (addrs[0] if addrs else None)
        m = re.search(r'inet (\d+\.\d+\.\d+\.\d+)', out)
        return m.group(1) if m else None

    async def get_interface_ipv6(self, interface):
        return await self.get_interface_ip(interface, family="6")

    async def get_interface_ips(self):
        """Map of interface name -> IPv4 address for every non-loopback interface."""
        return {
            interface: await self.get_interface_ip(interface)
            for interface in await self.get_network_interfaces()
        }

    def get_ip_address(self):
        """Best-effort local IP: the address used to reach the broker."""
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect((self.broker_host, self.broker_port))
            return s.getsockname()[0]
        except OSError:
            return ""
        finally:
            s.close()

    # Keeps the backend's InterfaceStatus buffer (see
    # mqtt_service._update_interface_status) continuously fresh, so the
    # fleet table/Pi detail page's interface cards always have a result to
    # show instead of triggering their own list_interfaces/link_info
    # round-trip on every render - at the cost of being up to this interval
    # stale. A user-triggered action (connect/disconnect/mode switch) still
    # fetches its own immediate live result for instant feedback; this loop
    # only feeds the passive/periodic display.
    INTERFACE_STATUS_INTERVAL_SECONDS = 5

    async def _interface_status_loop(self):
        while True:
            await asyncio.sleep(self.INTERFACE_STATUS_INTERVAL_SECONDS)
            try:
                details_list = await self.get_cached_interface_details()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[pi_agent] interface status: failed to list interfaces: {e}")
                continue
            outcomes = await asyncio.gather(
                *(self._publish_interface_status(d) for d in details_list),
                return_exceptions=True,
            )
            for details, outcome in zip(details_list, outcomes):
                if isinstance(outcome, asyncio.CancelledError):
                    raise outcome
                if isinstance(outcome, Exception):
                    print(f"[pi_agent] interface status failed for {details.get('name')}: {outcome}")

    async def _publish_interface_status(self, details):
        interface = details["name"]
        link = None
        # Name-based, not details["type"] == "wifi" - matches the frontend's
        # own isWifiInterface() check (which is what actually decides
        # whether an interface gets a wifi icon at all). get_interface_details'
        # "type" is a richer, driver-dependent classification that can
        # legitimately disagree (e.g. tag a normal managed-mode radio
        # "monitor" on a driver that reports radiotap-ish link info) - gating
        # on it here left connected/ssid permanently unpopulated for any
        # interface where that happened, even though it's really connected.
        if interface.startswith("wl"):
            # Non-blocking, same reasoning as _wifi_background_scan_one - an
            # interface a user-triggered wifi command currently holds the
            # lock for is skipped this cycle rather than waited on.
            if self._wifi_command_pending(interface):
                return
            lock = self._wifi_lock_for(interface)
            if lock.locked():
                return
            async with lock:
                try:
                    link = await self.get_link_info(interface)
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    link = {"error": str(e)}

        result = {
            "interface": interface,
            "mac_address": details.get("mac_address"),
            "state": details.get("state"),
            "type": details.get("type"),
            "ip_address": details.get("ip_address"),
            "ipv6_address": details.get("ipv6_address"),
        }
        if link and not link.get("error"):
            result.update({
                "connected": link.get("connected"),
                "ssid": link.get("ssid"),
                "bssid": link.get("bssid"),
                "frequency_mhz": link.get("frequency_mhz"),
                "band": link.get("band"),
                "signal_dbm": link.get("signal_dbm"),
                "rx_bitrate_mbps": link.get("rx_bitrate_mbps"),
                "tx_bitrate_mbps": link.get("tx_bitrate_mbps"),
                "gateway": link.get("gateway"),
                "key_mgmt": link.get("key_mgmt"),
                "pairwise_cipher": link.get("pairwise_cipher"),
                "group_cipher": link.get("group_cipher"),
                "wpa_state": link.get("wpa_state"),
                "address": link.get("address"),
                "wifi_generation": link.get("wifi_generation"),
                "noise_dbm": link.get("noise_dbm"),
                "avg_signal_dbm": link.get("avg_signal_dbm"),
                "link_speed_mbps": link.get("link_speed_mbps"),
                "channel_width": link.get("channel_width"),
                "radio_type": link.get("radio_type"),
            })
        result["command_id"] = str(uuid.uuid4())
        result["action"] = "interface_status"
        result["pi_id"] = self.pi_id
        result["timestamp"] = datetime.now(timezone.utc).isoformat()
        try:
            await self.publish(self.result_topic, json.dumps(result), qos=1)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[pi_agent] failed to publish interface status for {interface}: {e}")
