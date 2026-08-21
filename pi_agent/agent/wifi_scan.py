import asyncio
import json
import re
import uuid
from datetime import datetime, timezone

from . import proc


class WifiScanMixin:
    """Nearby-network scanning: the flat table (get_wifi_scan) the "Nearby
    networks" list uses, the fuller `iw scan` decode (get_wifi_scan_detail)
    behind the "Nearby Hotspot" popup, and the background loop that keeps
    the backend's WifiScanHistory buffer fresh without the popup having to
    trigger a scan itself. Relies on WifiMixin's _band_label/_wifi_lock_for
    and InterfacesMixin's get_interface_details.

    Both scan paths go through `iw` and cfg80211's scan cache. Nothing here
    uses NetworkManager: install.sh marks every wl* interface unmanaged, so
    NM will not scan them or report their BSSes."""

    async def get_wifi_scan(self, interface):
        """Nearby APs for the "Nearby networks" list, via `iw`.

        This used to run `nmcli dev wifi list ... --rescan yes`, which
        returned an empty list on every Pi in the fleet. install.sh ships
        99-pi-agent-unmanaged-wifi.conf setting
        `unmanaged-devices=interface-name:wl*`, and NetworkManager neither
        scans nor reports BSSes for a device it does not manage - so the
        command succeeded, printed nothing, and the action reported "no
        networks" rather than an error. `iw` talks to cfg80211 directly and
        is indifferent to NM's management state, which is why
        get_wifi_scan_detail never had the problem.

        Same source as that detail scan, then, just flattened to the
        smaller shape this list renders. Cache-first for the same reason
        wifi_detail_scan is: this runs inline on the MQTT message loop, so
        it must not sit on a multi-second radio scan there. Falls back to a
        real scan when the cache has nothing - a freshly booted Pi, or an
        interface the background loop hasn't reached yet, would otherwise
        show the same empty list this change exists to fix.
        """
        if not interface:
            return {"error": "interface is required"}

        detail = await self.get_wifi_scan_detail(interface, use_cache=True)
        if not detail.get("networks"):
            detail = await self.get_wifi_scan_detail(interface, use_cache=False)
        if "error" in detail:
            return {"interface": interface, "error": detail["error"]}

        return {
            "interface": interface,
            "networks": [self._flatten_scan_entry(n) for n in detail.get("networks", [])],
        }

    def _flatten_scan_entry(self, net):
        """One _parse_scan_bss_block entry reduced to the fields the
        "Nearby networks" list renders.

        Field names are the frontend's contract (wifi-scan.js,
        command-builder.js read these keys directly), so they keep the
        names nmcli's output was mapped onto rather than the detail scan's.
        `rate` keeps its "<n> Mbit/s" string form for the same reason: it's
        rendered as-is, not formatted at the far end.
        """
        freq_mhz = net.get("frequency_mhz")
        max_speed = net.get("max_speed_mbps")
        return {
            "ssid": net.get("ssid"),
            "bssid": net.get("bssid"),
            "mode": net.get("bss_type"),
            "channel": net.get("channel"),
            "frequency_mhz": freq_mhz,
            "band": self._band_label(freq_mhz) if freq_mhz else None,
            "rate": f"{max_speed:g} Mbit/s" if max_speed else None,
            "signal_percent": net.get("signal_quality_percent"),
            "security": net.get("security"),
        }

    # --- detailed wifi scan (Wifi Info popup) -------------------------------
    # The full decode: information elements (RSN/WPA, HT/VHT operation, WPS,
    # BSS Load, Country) for the detail popup - fields an AP doesn't
    # broadcast, or that this build of `iw` doesn't decode, are left None
    # rather than guessed. get_wifi_scan (above) is the same scan flattened
    # to the handful of fields the "Nearby networks" list shows.

    @staticmethod
    def _dbm_to_quality_percent(dbm):
        return max(0, min(100, round(2 * (dbm + 100))))

    @staticmethod
    def _channel_for_freq(freq_mhz):
        if freq_mhz is None:
            return None
        if freq_mhz == 2484:
            return 14
        if 2412 <= freq_mhz <= 2472:
            return (freq_mhz - 2407) // 5
        if 5000 <= freq_mhz <= 5895:
            return (freq_mhz - 5000) // 5
        if 5955 <= freq_mhz <= 7115:
            return (freq_mhz - 5950) // 5
        return None

    _OUI_FILE_CANDIDATES = ("/usr/share/ieee-data/oui.txt", "/var/lib/ieee-data/oui.txt")

    @classmethod
    def _oui_vendor(cls, bssid):
        """Best-effort manufacturer lookup from the BSSID's OUI, using the
        `ieee-data` package's oui.txt if it happens to be installed. Not
        every Pi will have it - callers should treat a None company as
        "unknown", not "open" (e.g. a hidden/locally-administered MAC)."""
        prefix = bssid.upper().replace(":", "")[:6]
        for path in cls._OUI_FILE_CANDIDATES:
            try:
                with open(path, encoding="utf-8", errors="ignore") as f:
                    for line in f:
                        if line.startswith(prefix) and "(hex)" in line:
                            return line.split("(hex)", 1)[1].strip()
            except OSError:
                continue
        return None

    def _parse_scan_bss_block(self, block, connected_bssid):
        lines = block.splitlines()
        header_m = re.match(r'([0-9a-fA-F:]{17})', lines[0]) if lines else None
        if not header_m:
            return None
        bssid = header_m.group(1).lower()

        ssid = capability = country_code = None
        frequency_mhz = channel = None
        rssi_dbm = None
        rsn_present = wpa_present = wps_present = False
        rsn_auth = rsn_pairwise = rsn_group = None
        wps_manufacturer = wps_model = wps_device_name = None
        ht_present = vht_present = he_present = eht_present = False
        ht_channel_width = vht_channel_width = None
        station_count = channel_utilization_percent = None
        max_rate_mbps = 0.0
        elements_count = 0
        section = None

        for raw in lines[1:]:
            if not raw.strip():
                continue
            stripped = raw.strip()
            if raw.startswith('\t') and not raw.startswith('\t\t'):
                section = None  # a new top-level IE line ends any sub-block we were in

            if stripped.startswith('freq:'):
                m = re.match(r'freq:\s*(\d+)', stripped)
                if m:
                    frequency_mhz = int(m.group(1))
            elif stripped.startswith('signal:'):
                m = re.match(r'signal:\s*(-?\d+(?:\.\d+)?)', stripped)
                if m:
                    rssi_dbm = float(m.group(1))
            elif stripped.startswith('capability:'):
                capability = stripped.split(':', 1)[1].strip()
            elif stripped.startswith('SSID:'):
                ssid = stripped.split(':', 1)[1].strip()
                elements_count += 1
            elif stripped.startswith('Supported rates:') or stripped.startswith('Extended supported rates:'):
                elements_count += 1
                for tok in re.findall(r'([\d.]+)\*?', stripped.split(':', 1)[1]):
                    try:
                        max_rate_mbps = max(max_rate_mbps, float(tok))
                    except ValueError:
                        pass
            elif stripped.startswith('DS Parameter set:'):
                elements_count += 1
                m = re.search(r'channel (\d+)', stripped)
                if m:
                    channel = int(m.group(1))
            elif stripped.startswith('Country:'):
                elements_count += 1
                m = re.match(r'Country:\s*(\S+)', stripped)
                if m:
                    country_code = m.group(1)
            elif stripped.startswith('RSN:'):
                elements_count += 1
                rsn_present = True
                section = 'RSN'
            elif stripped.startswith('WPA:'):
                elements_count += 1
                wpa_present = True
                section = 'WPA'
            elif stripped.startswith('WPS:'):
                elements_count += 1
                wps_present = True
                section = 'WPS'
            elif stripped.startswith('BSS Load:'):
                elements_count += 1
                section = 'BSSLOAD'
            elif stripped.startswith('HT capabilities:'):
                elements_count += 1
                ht_present = True
            elif stripped.startswith('HT operation:'):
                elements_count += 1
                section = 'HTOP'
            elif stripped.startswith('VHT capabilities:'):
                elements_count += 1
                vht_present = True
            elif stripped.startswith('VHT operation:'):
                elements_count += 1
                section = 'VHTOP'
            elif stripped.lower().startswith('he capabilities:'):
                elements_count += 1
                he_present = True
            elif stripped.lower().startswith('eht capabilities:'):
                elements_count += 1
                eht_present = True
            elif section in ('RSN', 'WPA'):
                if 'Group cipher' in stripped:
                    rsn_group = stripped.split(':', 1)[1].strip()
                elif 'Pairwise ciphers' in stripped:
                    rsn_pairwise = stripped.split(':', 1)[1].strip()
                elif 'Authentication suites' in stripped:
                    rsn_auth = stripped.split(':', 1)[1].strip()
            elif section == 'WPS':
                if stripped.startswith('* Manufacturer:'):
                    wps_manufacturer = stripped.split(':', 1)[1].strip()
                elif stripped.startswith('* Model:'):
                    wps_model = stripped.split(':', 1)[1].strip()
                elif stripped.startswith('* Device name:'):
                    wps_device_name = stripped.split(':', 1)[1].strip()
            elif section == 'BSSLOAD':
                if 'station count' in stripped:
                    m = re.search(r'(\d+)', stripped)
                    if m:
                        station_count = int(m.group(1))
                elif 'channel utilisation' in stripped or 'channel utilization' in stripped:
                    m = re.search(r'(\d+)\s*/\s*255', stripped)
                    if m:
                        channel_utilization_percent = round(int(m.group(1)) / 255 * 100, 1)
            elif section == 'HTOP':
                if 'primary channel' in stripped:
                    m = re.search(r'(\d+)', stripped)
                    if m and channel is None:
                        channel = int(m.group(1))
                elif 'STA channel width' in stripped:
                    ht_channel_width = stripped.split(':', 1)[1].strip()
            elif section == 'VHTOP':
                if 'channel width' in stripped:
                    vht_channel_width = stripped.split(':', 1)[1].strip()

        if channel is None:
            channel = self._channel_for_freq(frequency_mhz)

        bss_type = None
        if capability:
            if 'IBSS' in capability:
                bss_type = 'Ad-hoc'
            elif 'ESS' in capability:
                bss_type = 'Infrastructure'

        if rsn_present:
            security = 'WPA3' if rsn_auth and 'SAE' in rsn_auth else 'WPA2'
        elif wpa_present:
            security = 'WPA'
        elif capability and 'Privacy' in capability:
            security = 'WEP'
        else:
            security = 'Open'
        cipher = rsn_pairwise or rsn_group

        channel_width = vht_channel_width or ht_channel_width
        channels_range = None
        width_m = re.search(r'(\d+)\s*MHz', channel_width) if channel_width else None
        if width_m and frequency_mhz is not None:
            half = int(width_m.group(1)) // 2
            channels_range = f"{frequency_mhz - half}-{frequency_mhz + half} MHz"

        # An ax/be radio is backward-compatible with every standard below
        # it, not a replacement for them - a real AP's beacon typically
        # carries HT *and* VHT *and* HE *and* EHT capability elements
        # together, not just the newest one. Reporting only the highest (the
        # old behavior) silently dropped n/ac/ax whenever a newer one was
        # present. Legacy a/g has no capability element of its own to
        # detect (it's implied by every AP, not just older ones) so it's
        # always inferred from band and prepended, rather than only shown
        # when nothing newer is present.
        phy_standards = []
        if frequency_mhz and frequency_mhz < 2500:
            phy_standards.append('g')
        elif frequency_mhz:
            phy_standards.append('a')
        if ht_present:
            phy_standards.append('n')
        if vht_present:
            phy_standards.append('ac')
        if he_present:
            phy_standards.append('ax')
        if eht_present:
            phy_standards.append('be')
        phy_type = '802.11' + '/'.join(phy_standards) if phy_standards else None

        return {
            "ssid": ssid or None,
            "bssid": bssid,
            "phy_type": phy_type,
            "rssi_dbm": rssi_dbm,
            "signal_quality_percent": self._dbm_to_quality_percent(rssi_dbm) if rssi_dbm is not None else None,
            "frequency_mhz": frequency_mhz,
            "channel": channel,
            "information_size": None,
            "elements_count": elements_count or None,
            "company": wps_manufacturer or self._oui_vendor(bssid),
            "router_model": wps_model,
            "router_name": wps_device_name,
            "security": security,
            "cipher": cipher,
            "max_speed_mbps": max_rate_mbps or None,
            "channel_width": channel_width,
            "channels_range": channels_range,
            "bss_type": bss_type,
            "wps_support": wps_present,
            "connected": bool(connected_bssid) and bssid == connected_bssid,
            "stations_count": station_count,
            "channel_utilization_percent": channel_utilization_percent,
            "country_code": country_code,
            "description": None,
            "mac_group": None,
        }

    # Right after boot (or a pi-agent restart), NetworkManager is often still
    # mid-reconnect on this interface (scanning/associating/DHCP against a
    # saved profile) and holds the radio busy for anywhere up to a couple
    # minutes - a concurrent `iw scan` fails with EBUSY ("Device or resource
    # busy") for the whole time. A single failed attempt used to just get
    # silently dropped for the cycle (next attempt 3s later, same story) -
    # retrying a few times with backoff inside one call gives NM's own
    # in-progress scan a real chance to finish and free the radio before
    # this gives up, instead of always waiting for the next external
    # WIFI_BACKGROUND_SCAN_INTERVAL_SECONDS tick to try again.
    SCAN_BUSY_RETRY_DELAYS_SECONDS = (1, 2, 4)

    async def get_wifi_scan_detail(self, interface, use_cache=False):
        """Detailed per-AP scan for the "Wifi Info" popup - see
        _parse_scan_bss_block for what's decoded from `iw`'s output. History
        fields (first/last detection, detection count, min/max/avg signal)
        aren't included here - they're accumulated backend-side across
        repeated calls to this action (see mqtt_service._update_wifi_scan_history)
        and merged in by the front end.

        use_cache picks which of `iw`'s two scan modes to use:

          False - `iw dev <if> scan`: drive the radio through a fresh scan
                  and block until it finishes (seconds). Only for callers
                  that genuinely need this instant's air, and that already
                  hold this interface's wifi lock.
          True  - `iw dev <if> scan dump`: read cfg80211's cached BSS list.
                  No radio access at all, returns in milliseconds, safe to
                  call concurrently with anything - including while another
                  thread is associating or disconnecting on this interface.
                  Results are as fresh as the last completed scan, which
                  _wifi_background_scan_one keeps topped up.

        Both modes emit identical `BSS ...` blocks, so _parse_scan_bss_block
        handles them the same way."""
        if not interface:
            return {"error": "interface is required"}

        ret = await self._scan_dump(interface) if use_cache else await self._run_scan_with_busy_retry(interface)
        if ret.returncode != 0:
            return {"interface": interface, "error": (ret.stderr or ret.stdout).strip()}

        link_out = (await proc.run(
            ["iw", "dev", interface, "link"], timeout=10,
        )).stdout
        link_m = re.match(r'Connected to ([0-9a-fA-F:]+)', link_out)
        connected_bssid = link_m.group(1).lower() if link_m else None

        blocks = re.split(r'^BSS ', ret.stdout, flags=re.MULTILINE)[1:]
        networks = [n for n in (self._parse_scan_bss_block(b, connected_bssid) for b in blocks) if n]
        return {"interface": interface, "networks": networks, "from_cache": use_cache}

    async def _scan_trigger(self, interface):
        """Start a scan and return without waiting for it (`iw scan trigger`).

        This is the half of a scan that actually needs the radio, and it
        costs milliseconds instead of the 2-5s a full `iw scan` blocks for -
        which is the whole point: the caller only has to hold this
        interface's wifi lock for the trigger, not for the scan itself.
        Results land in cfg80211's cache a few seconds later and are read
        back lock-free via _scan_dump.

        EBUSY here is not worth retrying the way _run_scan_with_busy_retry
        does. That function sleeps up to 7s *while holding the lock* to win
        a race against NetworkManager's own scan; for a periodic background
        trigger the next cycle is along shortly anyway, and NM's in-progress
        scan populates the same cache this reads from, so nothing is lost by
        just skipping."""
        return await proc.run(
            ["iw", "dev", interface, "scan", "trigger"], timeout=10,
        )

    async def _scan_dump(self, interface):
        """Read cfg80211's cached BSS list (`iw scan dump`) - a pure read of
        kernel state that never touches the radio, so it needs no wifi lock
        and cannot delay, or be delayed by, a connect/disconnect."""
        return await proc.run(
            ["iw", "dev", interface, "scan", "dump"], timeout=15,
        )

    async def _run_scan_with_busy_retry(self, interface):
        delays = (0,) + self.SCAN_BUSY_RETRY_DELAYS_SECONDS
        ret = None
        for i, delay in enumerate(delays):
            if delay:
                await asyncio.sleep(delay)
            ret = await proc.run(
                ["iw", "dev", interface, "scan"], timeout=30,
            )
            if ret.returncode == 0:
                return ret
            busy = "busy" in (ret.stderr or ret.stdout).lower()
            if not busy or i == len(delays) - 1:
                if busy:
                    print(f"[pi_agent] {interface}: scan still busy after {sum(delays)}s of retries, giving up this cycle")
                return ret
        return ret

    # Keeps the backend's WifiScanHistory buffer (see
    # mqtt_service._update_wifi_scan_history) continuously fresh, so the
    # "Wifi Info" popup always has a result to show immediately instead of
    # waiting on a live iw scan - at the cost of the popup being up to this
    # interval stale rather than truly real-time. Note: an `iw scan` itself
    # can take longer than this on some chipsets when covering both bands -
    # if one interface's scan is still running when the next cycle fires,
    # _wifi_background_scan_one's non-blocking lock acquire just skips that
    # interface for this cycle rather than piling up, so the real cadence
    # for a slow-scanning radio is bounded by its own scan duration, not
    # this number.
    #
    # What bounds this number is now RF airtime, not lock contention. Since
    # _wifi_background_scan_one only holds the interface lock for a scan
    # *trigger* (milliseconds) and reads results from the cache lock-free,
    # a fast cadence no longer starves connect/disconnect the way it did
    # when each cycle blocked on a full 2-5s `iw scan`. What a shorter
    # interval does still cost is the radio going off-channel to probe,
    # which eats into throughput on an associated link - so this is set for
    # the freshness the "Wifi Info" popup wants, not pushed to the floor.
    WIFI_BACKGROUND_SCAN_INTERVAL_SECONDS = 6

    async def _wifi_background_scan_loop(self):
        while True:
            await asyncio.sleep(self.WIFI_BACKGROUND_SCAN_INTERVAL_SECONDS)
            try:
                # Name-based, not d["type"] == "wifi" - see the matching
                # comment in _publish_interface_status for why: type is a
                # driver-dependent classification that can disagree with the
                # frontend's own name-based isWifiInterface() check, which
                # decides whether the "Nearby Hotspot" button even exists.
                wifi_interfaces = [d["name"] for d in await self.get_interface_details() if d["name"].startswith("wl")]
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[pi_agent] background wifi scan: failed to list interfaces: {e}")
                continue
            # One task per interface, run concurrently and awaited together:
            # four radios' cycles overlap in the time one used to take, and
            # unlike the old detached threads a failure here is visible
            # rather than dying silently in a thread nobody joins.
            results = await asyncio.gather(
                *(self._wifi_background_scan_one(i) for i in wifi_interfaces),
                return_exceptions=True,
            )
            for interface, outcome in zip(wifi_interfaces, results):
                if isinstance(outcome, asyncio.CancelledError):
                    raise outcome
                if isinstance(outcome, Exception):
                    print(f"[pi_agent] background wifi scan failed for {interface}: {outcome}")

    async def _wifi_background_scan_one(self, interface):
        # Split into a locked trigger and a lock-free read, so this loop
        # occupies the interface's wifi lock for milliseconds per cycle
        # rather than the 2-5s a full blocking `iw scan` used to hold it
        # for. That hold time was the direct cause of connect/disconnect
        # commands stalling: they take the same lock, and at any realistic
        # scan cadence a blocking scan meant the lock was almost never free
        # when a command arrived.
        #
        # Only the trigger is serialised against connect/disconnect. The
        # dump that follows is a read of kernel state and runs outside the
        # lock, so it can overlap a command freely.
        if self._wifi_command_pending(interface):
            return
        lock = self._wifi_lock_for(interface)
        # Never wait for the lock: a command holds it, and this cycle's scan
        # matters less than that command finishing. Lock.locked() is the
        # asyncio equivalent of the old acquire(blocking=False) - and since
        # nothing awaits between the check and the acquire, no other task
        # can slip in and take it in between.
        if lock.locked():
            return
        async with lock:
            try:
                # Triggered unconditionally, connected or not - a scan on an
                # already-associated interface is an off-channel scan (cfg80211
                # tracks the current BSS independently of which channel the
                # radio is briefly sitting on for a probe), so it doesn't drop
                # the association. Keeping this always-on gives the WifiScanHistory
                # buffer the freshest possible results instead of freezing at
                # whatever was last scanned before the interface connected.
                trigger = await self._scan_trigger(interface)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[pi_agent] {interface}: scan trigger failed: {e}")
                trigger = None

        if trigger is not None and trigger.returncode != 0:
            # Not fatal, and deliberately not retried under the lock - see
            # _scan_trigger. The dump below still returns whatever the last
            # completed scan (this loop's or NetworkManager's) left behind.
            busy = "busy" in (trigger.stderr or trigger.stdout).lower()
            if not busy:
                print(f"[pi_agent] {interface}: scan trigger: {(trigger.stderr or trigger.stdout).strip()}")

        # Outside the lock: this reads the cache, so it neither needs the
        # radio nor blocks a command that wants it. The results are from
        # the previous cycle's trigger (a scan takes a few seconds to
        # complete), which is what makes the cadence below affordable.
        try:
            result = await self.get_wifi_scan_detail(interface, use_cache=True)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            result = {"interface": interface, "error": str(e)}
        result["command_id"] = str(uuid.uuid4())
        result["action"] = "wifi_detail_scan"
        result["pi_id"] = self.pi_id
        result["timestamp"] = datetime.now(timezone.utc).isoformat()
        try:
            await self.publish(self.result_topic, json.dumps(result), qos=1)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[pi_agent] failed to publish background wifi scan for {interface}: {e}")
