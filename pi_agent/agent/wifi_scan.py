import json
import re
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone


class WifiScanMixin:
    """Nearby-network scanning: the fast nmcli table (get_wifi_scan) the
    "Nearby networks" list uses, the slower `iw scan`-based detailed scan
    (get_wifi_scan_detail) the "Nearby Hotspot" popup uses, and the
    background loop that keeps the backend's WifiScanHistory buffer fresh
    without the popup having to trigger a scan itself. Relies on
    WifiMixin's _band_label/_wifi_lock_for and InterfacesMixin's
    get_interface_details."""

    def get_wifi_scan(self, interface):
        """Scan for nearby wifi APs via nmcli (Pi acting as a station).

        Uses nmcli's terse (-t) mode, which escapes literal colons inside a
        field (e.g. the BSSID) as "\\:" - split on unescaped colons only,
        then unescape, to avoid splitting a BSSID's own colons apart.
        """
        if not interface:
            return {"error": "interface is required"}

        fields = "SSID,BSSID,MODE,CHAN,FREQ,RATE,SIGNAL,SECURITY"
        ret = subprocess.run(
            ["nmcli", "-t", "-f", fields, "dev", "wifi", "list", "ifname", interface, "--rescan", "yes"],
            capture_output=True, text=True, timeout=30,
        )
        if ret.returncode != 0:
            return {"interface": interface, "error": (ret.stderr or ret.stdout).strip()}

        networks = []
        for line in ret.stdout.splitlines():
            if not line.strip():
                continue
            parts = [p.replace("\\:", ":") for p in re.split(r'(?<!\\):', line)]
            if len(parts) < 8:
                continue
            ssid, bssid, mode, chan, freq, rate, signal, security = parts[:8]
            freq_m = re.match(r'(\d+)', freq)
            freq_mhz = int(freq_m.group(1)) if freq_m else None
            networks.append({
                "ssid": ssid or None,
                "bssid": bssid or None,
                "mode": mode or None,
                "channel": int(chan) if chan.isdigit() else None,
                "frequency_mhz": freq_mhz,
                "band": self._band_label(freq_mhz) if freq_mhz else None,
                "rate": rate or None,
                "signal_percent": int(signal) if signal.isdigit() else None,
                "security": security or None,
            })
        return {"interface": interface, "networks": networks}

    # --- detailed wifi scan (Wifi Info popup) -------------------------------
    # get_wifi_scan (above) is the fast nmcli table the "Nearby networks"
    # list uses. This is a separate, much slower `iw scan` that decodes
    # information elements (RSN/WPA, HT/VHT operation, WPS, BSS Load,
    # Country) for the detail popup - fields an AP doesn't broadcast, or
    # that this build of `iw` doesn't decode, are left None rather than
    # guessed.

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

    def get_wifi_scan_detail(self, interface):
        """Detailed per-AP scan for the "Wifi Info" popup - see
        _parse_scan_bss_block for what's decoded from `iw`'s output. History
        fields (first/last detection, detection count, min/max/avg signal)
        aren't included here - they're accumulated backend-side across
        repeated calls to this action (see mqtt_service._update_wifi_scan_history)
        and merged in by the front end."""
        if not interface:
            return {"error": "interface is required"}

        ret = subprocess.run(
            ["iw", "dev", interface, "scan"],
            capture_output=True, text=True, timeout=30,
        )
        if ret.returncode != 0:
            return {"interface": interface, "error": (ret.stderr or ret.stdout).strip()}

        link_out = subprocess.run(["iw", "dev", interface, "link"], capture_output=True, text=True).stdout
        link_m = re.match(r'Connected to ([0-9a-fA-F:]+)', link_out)
        connected_bssid = link_m.group(1).lower() if link_m else None

        blocks = re.split(r'^BSS ', ret.stdout, flags=re.MULTILINE)[1:]
        networks = [n for n in (self._parse_scan_bss_block(b, connected_bssid) for b in blocks) if n]
        return {"interface": interface, "networks": networks}

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
    WIFI_BACKGROUND_SCAN_INTERVAL_SECONDS = 3

    def _wifi_background_scan_loop(self):
        while True:
            time.sleep(self.WIFI_BACKGROUND_SCAN_INTERVAL_SECONDS)
            try:
                # Name-based, not d["type"] == "wifi" - see the matching
                # comment in _publish_interface_status for why: type is a
                # driver-dependent classification that can disagree with the
                # frontend's own name-based isWifiInterface() check, which
                # decides whether the "Nearby Hotspot" button even exists.
                wifi_interfaces = [d["name"] for d in self.get_interface_details() if d["name"].startswith("wl")]
            except Exception as e:
                print(f"[pi_agent] background wifi scan: failed to list interfaces: {e}")
                continue
            for interface in wifi_interfaces:
                threading.Thread(target=self._wifi_background_scan_one, args=(interface,), daemon=True).start()

    def _wifi_background_scan_one(self, interface):
        # Non-blocking: an interface a user-triggered connect_wifi/
        # disconnect_wifi/set_interface_mode is currently holding the lock
        # for is skipped this cycle rather than waiting - that command's own
        # result matters more than this cycle's scan, and _wifi_lock_for
        # locks can be held for minutes.
        lock = self._wifi_lock_for(interface)
        if not lock.acquire(blocking=False):
            return
        try:
            # Scanned unconditionally, connected or not - `iw scan` on an
            # already-associated interface is an off-channel scan (cfg80211
            # tracks the current BSS independently of which channel the
            # radio is briefly sitting on for a probe), so it doesn't drop
            # the association. Keeping this always-on gives the WifiScanHistory
            # buffer the freshest possible results instead of freezing at
            # whatever was last scanned before the interface connected.
            result = self.get_wifi_scan_detail(interface)
        except Exception as e:
            result = {"interface": interface, "error": str(e)}
        finally:
            lock.release()
        result["command_id"] = str(uuid.uuid4())
        result["action"] = "wifi_detail_scan"
        result["pi_id"] = self.pi_id
        result["timestamp"] = datetime.now(timezone.utc).isoformat()
        try:
            self.client.publish(self.result_topic, json.dumps(result), qos=1)
        except Exception as e:
            print(f"[pi_agent] failed to publish background wifi scan for {interface}: {e}")
