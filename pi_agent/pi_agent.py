import json
import os
import socket
import subprocess
import threading
import time
import zlib
from datetime import datetime, timezone
import paho.mqtt.client as mqtt
import re
from dotenv import load_dotenv

load_dotenv()

BROKER_HOST = os.environ["BROKER_HOST"]
BROKER_PORT = int(os.environ["BROKER_PORT"])
PI_ID = os.environ["PI_ID"]
ROLE = os.environ["ROLE"]
# Where the backend's pcap capture socket server listens - a pcap capture is
# piped there live as tcpdump produces it (see start_pcap_capture), instead
# of being written to a local file first and uploaded as a whole after stop.
CAPTURE_SOCKET_HOST = os.environ["CAPTURE_SOCKET_HOST"]
CAPTURE_SOCKET_PORT = int(os.environ["CAPTURE_SOCKET_PORT"])


class PiAgent:
    def __init__(self, broker_host=BROKER_HOST, broker_port=BROKER_PORT, pi_id=PI_ID, role=ROLE,
                 capture_socket_host=CAPTURE_SOCKET_HOST, capture_socket_port=CAPTURE_SOCKET_PORT):
        self.broker_host = broker_host
        self.broker_port = broker_port
        self.pi_id = pi_id
        self.role = role
        self.capture_socket_host = capture_socket_host
        self.capture_socket_port = capture_socket_port

        self.cmd_topic_mine = f'test/{pi_id}/cmd'
        self.cmd_topic_all = 'test/all/cmd'
        self.result_topic = f'test/{pi_id}/result'
        self.status_topic = f'test/{pi_id}/status'
        self.registration_topic = f'devices/{pi_id}/registration'

        self._pcap_procs = {}
        self._pcap_state = {}
        self._pcap_lock = threading.Lock()

        # Live view only (see start_tcpdump_stream/start_syslog_stream) -
        # separate processes/sockets from the pcap recording above, so a
        # view and a recording can run concurrently on the same interface.
        self._streaming_started = False
        self._streaming_lock = threading.Lock()
        self._syslog_proc = None
        self._syslog_interface = None

        self._tcpdump_running = set()
        self._tcpdump_procs = {}
        self._tcpdump_lock = threading.Lock()

        # The broker (mosquitto 1.6.9) only speaks MQTT 3.1.1 - v5 broker
        # support wasn't added until mosquitto 2.0. Connecting as v5 anyway
        # is undefined behavior against this broker; clean_session=True here
        # is the unambiguous v3.1.1 way to guarantee every (re)connect starts
        # a fresh session, so no stale/queued command (like an old tcpdump
        # start) ever gets replayed on reconnect or agent restart.
        self.client = mqtt.Client(client_id=pi_id, protocol=mqtt.MQTTv311, clean_session=True)
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message

    def run_iperf_server_test(self, duration=10):
        result = subprocess.run(
            ["iperf3", "-c", self.broker_host, "-t", str(duration), "-J"],
            capture_output=True, text=True, timeout=duration + 15,
        )
        data = json.loads(result.stdout)
        return {
            "throughput_mbps": data["end"]["sum_received"]["bits_per_second"] / 1e6,
            "retransmits": data["end"]["sum_sent"].get("retransmits"),
        }

    def get_syslog(self, lines=100):
        """Pull recent journal lines."""
        out = subprocess.run(
            ["journalctl", "-n", str(lines), "--no-pager"],
            capture_output=True, text=True,
        ).stdout
        return out.splitlines()

    def start_pcap_capture(self, interface, name=None):
        """Start a pcap capture for one interface, piped live to the backend's
        capture socket server as tcpdump produces it - independent of the
        parsed-line tcpdump stream (both can run on the same interface at
        once). Streaming continuously instead of writing to a local file
        means stop only has to close a socket, not upload a whole finished
        file - that upload-at-the-end approach was why stopping a capture
        used to take so long."""
        with self._pcap_lock:
            if interface in self._pcap_procs:
                return False
            proc = subprocess.Popen(
                ["tcpdump", "-i", interface, "-w", "-", "-U"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            # tcpdump fails fast on a bad interface or missing capture
            # permissions (needs root or cap_net_raw+cap_net_admin). Without
            # this check, start would report success even though tcpdump
            # already died.
            time.sleep(0.3)
            if proc.poll() is not None:
                output = proc.stderr.read().decode(errors="replace").strip() if proc.stderr else ""
                raise RuntimeError(output or f"tcpdump exited immediately (code {proc.returncode})")

            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.connect((self.capture_socket_host, self.capture_socket_port))
            capture_name = name or f"{self.pi_id}-pcap-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}"
            sock.sendall((json.dumps({
                "kind": "record", "pi_id": self.pi_id, "name": capture_name, "interface": interface,
            }) + "\n").encode())

            state = {"error": None, "capture_id": None, "byte_count": 0, "done": threading.Event()}
            thread = threading.Thread(target=self._relay_pcap, args=(proc, sock, state), daemon=True)
            thread.start()

            self._pcap_procs[interface] = proc
            self._pcap_state[interface] = state
        return True

    def _relay_pcap(self, proc, sock, state):
        """Pump tcpdump's stdout into the capture socket until tcpdump exits
        (stdout hits EOF), then half-close the socket and read the backend's
        ack off the same connection."""
        try:
            while True:
                chunk = proc.stdout.read(65536)
                if not chunk:
                    break
                sock.sendall(chunk)
        except Exception as e:
            state["error"] = str(e)
        finally:
            try:
                sock.shutdown(socket.SHUT_WR)
            except OSError:
                pass
            try:
                ack_line = sock.makefile("r").readline()
                ack = json.loads(ack_line) if ack_line else {}
                state["capture_id"] = ack.get("capture_id")
                state["byte_count"] = ack.get("byte_count", 0)
                if ack.get("error"):
                    state["error"] = state["error"] or ack["error"]
            except Exception as e:
                state["error"] = state["error"] or str(e)
            finally:
                sock.close()
                state["done"].set()

    def stop_pcap_capture(self, interface):
        """Stop the pcap capture for an interface and return the saved
        capture's metadata once the relay thread's socket stream finishes."""
        with self._pcap_lock:
            proc = self._pcap_procs.pop(interface, None)
            state = self._pcap_state.pop(interface, None)
        if proc is None:
            return {"error": f"no pcap capture running on {interface}"}

        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)

        if not state["done"].wait(timeout=15):
            return {"error": "timed out waiting for the capture upload to finish", "interface": interface}

        if state["error"]:
            return {"error": state["error"], "interface": interface}

        return {
            "interface": interface,
            "byte_count": state["byte_count"],
            "capture_id": state["capture_id"],
            "saved": True,
        }

    def _stream_tcpdump_socket(self, interface, proc, state):
        """Pump this view-only tcpdump process's stdout to the backend over
        a socket connection tagged kind=stream_tcpdump - decoded to text and
        relayed live by the backend, never written to a capture file (that's
        start_pcap_capture's job, a wholly separate tcpdump process)."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.connect((self.capture_socket_host, self.capture_socket_port))
            sock.sendall((json.dumps({
                "kind": "stream_tcpdump", "pi_id": self.pi_id, "interface": interface,
            }) + "\n").encode())
            while True:
                chunk = proc.stdout.read(65536)
                if not chunk:
                    break
                sock.sendall(chunk)
        except Exception as e:
            state["error"] = str(e)
        finally:
            try:
                sock.close()
            except OSError:
                pass
            with self._tcpdump_lock:
                self._tcpdump_running.discard(interface)
                self._tcpdump_procs.pop(interface, None)

    def start_tcpdump_stream(self, interface):
        """Start a live decoded-tcpdump view for one interface, no-op if
        already running. Independent of start_pcap_capture - both can run
        on the same interface at once, one for viewing, one for saving."""
        with self._tcpdump_lock:
            if interface in self._tcpdump_running:
                return False
            proc = subprocess.Popen(
                ["tcpdump", "-i", interface, "-w", "-", "-U"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            time.sleep(0.3)
            if proc.poll() is not None:
                output = proc.stderr.read().decode(errors="replace").strip() if proc.stderr else ""
                raise RuntimeError(output or f"tcpdump exited immediately (code {proc.returncode})")
            state = {"error": None}
            self._tcpdump_running.add(interface)
            self._tcpdump_procs[interface] = proc
        threading.Thread(target=self._stream_tcpdump_socket, args=(interface, proc, state), daemon=True).start()
        return True

    def stop_tcpdump_stream(self, interface):
        """Stop the tcpdump view for one interface, if running."""
        with self._tcpdump_lock:
            if interface not in self._tcpdump_running:
                return False
            self._tcpdump_running.discard(interface)
            proc = self._tcpdump_procs.pop(interface, None)
        if proc:
            proc.terminate()
        return True

    def _stream_syslog_socket(self, interface, proc):
        """Pump journalctl -f's output to the backend over a socket
        connection tagged kind=stream_syslog - relayed live as text lines,
        never persisted (same "view only" contract as stream_tcpdump)."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.connect((self.capture_socket_host, self.capture_socket_port))
            sock.sendall((json.dumps({
                "kind": "stream_syslog", "pi_id": self.pi_id, "interface": interface,
            }) + "\n").encode())
            for line in proc.stdout:
                sock.sendall((line.rstrip("\n") + "\n").encode())
        except Exception:
            pass
        finally:
            try:
                sock.close()
            except OSError:
                pass
            with self._streaming_lock:
                if self._syslog_proc is proc:
                    self._streaming_started = False
                    self._syslog_proc = None
                    self._syslog_interface = None

    def start_syslog_stream(self, interface=None):
        """Start the syslog streaming thread for the given interface filter.

        No-op if already streaming that exact interface. If a stream for a
        *different* interface is running, it's stopped and replaced - only
        one syslog stream runs per Pi at a time.
        """
        cmd = ["journalctl", "-u", "NetworkManager", "-n", "50", "-f"]
        if interface:
            cmd += ["-g", interface]

        old_proc = None
        with self._streaming_lock:
            if self._streaming_started and self._syslog_interface == interface:
                return False
            if self._streaming_started:
                old_proc = self._syslog_proc
            self._streaming_started = True
            self._syslog_interface = interface
        if old_proc:
            old_proc.terminate()

        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True)
        with self._streaming_lock:
            self._syslog_proc = proc
        threading.Thread(target=self._stream_syslog_socket, args=(interface, proc), daemon=True).start()
        return True

    def stop_syslog_stream(self):
        """Stop the syslog streaming thread, if running."""
        with self._streaming_lock:
            if not self._streaming_started:
                return False
            self._streaming_started = False
            self._syslog_interface = None
            proc = self._syslog_proc
            self._syslog_proc = None
        if proc:
            proc.terminate()
        return True

    def get_signal_stats(self):
        """Pull RSSI / link stats for connected stations (Pi acting as AP)."""
        out = subprocess.run(
            ["iw", "dev", "wlan0", "station", "dump"],
            capture_output=True, text=True,
        ).stdout
        return out.strip()

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
            "raw_output": out.strip(),
        }

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

    def ping_internet(self, interface=None, target=None, count=5):
        target = target or "8.8.8.8"
        count = int(count) if count else 5

        if interface:
            subprocess.run(["ip", "neigh", "flush", "dev", interface],
                            capture_output=True, text=True, timeout=10)

        cmd = ["ping", target]
        if interface:
            cmd += ["-I", interface]
        cmd += ["-c", str(count)]
        ret = subprocess.run(cmd, capture_output=True, text=True, timeout=count * 2 + 5)

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

    @staticmethod
    def _routing_table_for(interface):
        """Deterministic, stable per-interface routing table id (100-1099),
        so repeated connects on the same interface always reuse the same
        table instead of leaking a new rule/table every time."""
        return 100 + (zlib.crc32(interface.encode()) % 1000)

    def _apply_policy_routing(self, con_name, interface, ip_address):
        """Give this interface its own routing table plus a source-based ip
        rule, so traffic sourced from (or explicitly bound to, e.g.
        `ping -I <interface>`) this interface always routes via its own
        gateway. Without this, multiple wifi interfaces associated to APs on
        the same subnet can end up sharing one default route, so a packet
        forced out one NIC gets addressed to a *different* interface's
        gateway MAC - the AP silently drops it, and `ping -I <iface>` fails
        intermittently with 100% loss even though the interface is fine.
        Confirmed as the fix by manually reproducing and resolving this on
        pi01. Best-effort: failure here doesn't fail the connect itself."""
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

    def connect_wifi(self, ssid, password=None, interface=None, bssid=None, channel=None):
        """Connect to a wifi hotspot via NetworkManager, using a connection
        profile scoped to this interface (con-name "<ssid-or-bssid>-<interface>").

        Plain `nmcli device wifi connect <ssid>` keys its profile off the SSID
        name alone, so a second NIC joining the same SSID collides with the
        first NIC's profile and gets auto-renamed (e.g. "SSID 1") without a
        complete security section, failing with
        "802-11-wireless-security.key-mgmt: property is missing". Giving each
        interface its own profile name sidesteps that collision entirely.

        If bssid is given, it takes over as the connection target instead of
        ssid - useful when multiple APs share the same SSID and a specific
        one needs to be targeted. If channel is given, the profile is pinned
        to that exact channel (and its band, inferred from the channel
        number) - useful when the same SSID is broadcast on multiple
        bands/channels and a specific one needs to be tested.
        """
        if bssid:
            return self._connect_wifi_by_bssid(bssid, password, interface)

        if not ssid:
            return {"error": "ssid is required"}
        if not interface:
            return {"error": "interface is required"}

        con_name = f"{ssid}-{interface}"

        # Drop any stale profile under this name so nmcli builds a fresh,
        # fully-specified one instead of patching a possibly incomplete one.
        subprocess.run(["nmcli", "connection", "delete", con_name],
                        capture_output=True, text=True)

        add_cmd = [
            "nmcli", "connection", "add",
            "type", "wifi",
            "con-name", con_name,
            "ifname", interface,
            "ssid", ssid,
        ]
        if password:
            add_cmd += ["wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", password]
        if channel:
            band = "bg" if int(channel) <= 14 else "a"
            add_cmd += ["802-11-wireless.band", band, "802-11-wireless.channel", str(channel)]
        add_ret = subprocess.run(add_cmd, capture_output=True, text=True, timeout=30)
        if add_ret.returncode != 0:
            return {
                "ssid": ssid,
                "interface": interface,
                "connected": False,
                "output": (add_ret.stdout or add_ret.stderr).strip(),
            }

        up_ret = subprocess.run(
            ["nmcli", "connection", "up", con_name],
            capture_output=True, text=True, timeout=30,
        )
        connected = up_ret.returncode == 0
        ip_address = self.get_interface_ip(interface) if connected else None
        return {
            "ssid": ssid,
            "interface": interface,
            "channel": channel,
            "connected": connected,
            "ip_address": ip_address,
            "output": (up_ret.stdout or up_ret.stderr).strip(),
            "policy_routing": None,
        }

    def _connect_wifi_by_bssid(self, bssid, password=None, interface=None):
        """Connect to a specific access point by BSSID (MAC address) instead
        of SSID. `nmcli device wifi connect` resolves the SSID itself from
        scan results matching that BSSID, so the caller never has to supply
        it. Mirrors connect_wifi's per-interface profile naming to avoid the
        same NetworkManager collision a second NIC on the same target would
        otherwise hit."""
        if not interface:
            return {"error": "interface is required"}

        con_name = f"{bssid}-{interface}"

        # Drop any stale profile under this name so nmcli builds a fresh one.
        subprocess.run(["nmcli", "connection", "delete", con_name],
                        capture_output=True, text=True)

        subprocess.run(["nmcli", "device", "wifi", "rescan", "ifname", interface],
                        capture_output=True, text=True, timeout=15)
        time.sleep(2)

        connect_cmd = [
            "nmcli", "device", "wifi", "connect", bssid,
            "ifname", interface, "name", con_name,
        ]
        if password:
            connect_cmd += ["password", password]
        ret = subprocess.run(connect_cmd, capture_output=True, text=True, timeout=30)
        connected = ret.returncode == 0
        ip_address = self.get_interface_ip(interface) if connected else None
        return {
            "bssid": bssid,
            "interface": interface,
            "connected": connected,
            "ip_address": ip_address,
            "output": (ret.stdout or ret.stderr).strip(),
            "policy_routing": None,
        }

    def disconnect_wifi(self, interface=None):
        """Disconnect from the current wifi hotspot via NetworkManager."""
        if not interface:
            return {"error": "interface is required"}
        ret = subprocess.run(
            ["nmcli", "device", "disconnect", interface],
            capture_output=True, text=True, timeout=30,
        )
        return {
            "interface": interface,
            "disconnected": ret.returncode == 0,
            "output": (ret.stdout or ret.stderr).strip(),
        }

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

    def restart_hostapd(self, channel=None):
        if channel:
            subprocess.run(["sed", "-i", f"s/^channel=.*/channel={channel}/",
                             "/etc/hostapd/hostapd.conf"])
        subprocess.run(["systemctl", "restart", "hostapd"])
        return {"restarted": True, "channel": channel}

    @staticmethod
    def wait_until(iso_timestamp):
        """Block until the synchronized start time given by the controller."""
        target = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00"))
        delay = (target - datetime.now(timezone.utc)).total_seconds()
        if delay > 0:
            time.sleep(delay)

    def handle_command(self, payload):
        action = payload.get("action")
        at = payload.get("at")

        if at:
            self.wait_until(at)

        try:
            if action == "throughput_test":
                result = self.run_iperf_server_test(payload.get("duration", 10))
            elif action == "signal_stats":
                result = {"stations": self.get_signal_stats()}
            elif action == "band_channel_info":
                result = self.get_band_channel_info(payload.get("interface"))
            elif action == "link_info":
                result = self.get_link_info(payload.get("interface"))
            elif action == "set_channel":
                result = self.restart_hostapd(channel=payload.get("channel"))
            elif action == "connect_wifi":
                result = self.connect_wifi(
                    payload.get("ssid"),
                    payload.get("password"),
                    payload.get("interface"),
                    payload.get("bssid"),
                    payload.get("channel"),
                )
            elif action == "disconnect_wifi":
                result = self.disconnect_wifi(payload.get("interface"))
            elif action == "scan_wifi":
                result = self.get_wifi_scan(payload.get("interface"))
            elif action == "list_interfaces":
                self.publish_registration()
                result = {"interfaces": self.get_interface_details()}
            elif action == "ping":
                result = self.ping_internet(
                    payload.get("interface"), payload.get("target"), payload.get("count"),
                )
            elif action == "syslog":
                result = {"logs": self.get_syslog(payload.get("lines", 100))}
            elif action == "stream_logs":
                interface = payload.get("interface")
                if not interface:
                    result = {"error": "interface is required"}
                else:
                    started = self.start_syslog_stream(interface)
                    result = {"streaming": True, "already_running": not started, "interface": interface}
            elif action == "tcpdump":
                interface = payload.get("interface")
                if not interface:
                    result = {"error": "interface is required"}
                else:
                    started = self.start_tcpdump_stream(interface)
                    result = {"streaming": True, "already_running": not started, "interface": interface}
            elif action == "stop_logs":
                stopped = self.stop_syslog_stream()
                result = {"streaming": False, "stopped": stopped}
            elif action == "stop_tcpdump":
                interface = payload.get("interface")
                if not interface:
                    result = {"error": "interface is required"}
                else:
                    stopped = self.stop_tcpdump_stream(interface)
                    result = {"streaming": False, "interface": interface, "stopped": stopped}
            elif action == "start_pcap_capture":
                interface = payload.get("interface")
                if not interface:
                    result = {"error": "interface is required"}
                else:
                    started = self.start_pcap_capture(interface, payload.get("name"))
                    result = {
                        "capturing": True,
                        "already_running": not started,
                        "interface": interface,
                    }
            elif action == "stop_pcap_capture":
                interface = payload.get("interface")
                if not interface:
                    result = {"error": "interface is required"}
                else:
                    result = self.stop_pcap_capture(interface)
                    result["capturing"] = False
            else:
                result = {"error": f"unknown action: {action}"}
        except Exception as e:
            result = {"error": str(e)}

        result["command_id"] = payload.get("command_id")
        result["action"] = action
        result["pi_id"] = self.pi_id
        result["timestamp"] = datetime.now(timezone.utc).isoformat()

        try:
            self.client.publish(self.result_topic, json.dumps(result), qos=1)
        except Exception as e:
            # A pcap result in particular can be tens of MB of base64 - if
            # serializing/publishing that blows up, don't let it escape into
            # paho's network thread. Better to drop this one result than take
            # down the whole agent and leave every future command "pending"
            # forever until someone notices and restarts the process.
            print(f"[pi_agent] failed to publish result for {action}: {e}")

    def get_network_interfaces(self):
        """List local network interface names (excluding loopback)."""
        out = subprocess.run(
            ["ip", "-o", "link", "show"],
            capture_output=True, text=True,
        ).stdout
        interfaces = []
        for line in out.splitlines():
            m = re.match(r'^\d+:\s+([^:@]+)', line)
            if m and m.group(1) != "lo":
                interfaces.append(m.group(1))
        return interfaces

    def get_interface_details(self):
        """Per-interface details (excluding loopback): MAC, link state, MTU,
        and type (wifi/ethernet/other) - richer than get_network_interfaces's
        plain name list, for the list_interfaces UI table."""
        out = subprocess.run(
            ["ip", "-o", "link", "show"],
            capture_output=True, text=True,
        ).stdout
        details = []
        for line in out.splitlines():
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
                "type": "wifi" if name.startswith(("wl", "wlan")) else
                        ("ethernet" if link_type == "ether" else link_type),
                "ip_address": self.get_interface_ip(name),
            })
        return details

    def get_interface_ip(self, interface):
        """Best-effort IPv4 address currently assigned to a given interface."""
        if not interface:
            return None
        out = subprocess.run(
            ["ip", "-4", "-o", "addr", "show", interface],
            capture_output=True, text=True,
        ).stdout
        m = re.search(r'inet (\d+\.\d+\.\d+\.\d+)', out)
        return m.group(1) if m else None

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

    def publish_registration(self):
        payload = {
            "ip_address": self.get_ip_address(),
            "role": self.role,
            "topics": [self.cmd_topic_mine, self.cmd_topic_all],
            "metadata": {"interfaces": self.get_network_interfaces()},
        }
        self.client.publish(self.registration_topic, json.dumps(payload), qos=1, retain=True)

    def on_connect(self, client, userdata, flags, reason_code, properties=None):
        client.subscribe(self.cmd_topic_mine, qos=1)
        client.subscribe(self.cmd_topic_all, qos=1)
        client.publish(self.status_topic, "online", qos=1, retain=True)
        self.publish_registration()

    def on_message(self, client, userdata, msg):
        try:
            payload = json.loads(msg.payload.decode())
        except json.JSONDecodeError:
            return
        try:
            self.handle_command(payload)
        except Exception as e:
            # Whatever this command was, a bug in handling it shouldn't be
            # able to kill the paho network thread and leave every command
            # after it stuck "pending" until the process is restarted by hand.
            print(f"[pi_agent] unhandled error processing {payload.get('action')}: {e}")

    def run(self):
        self.client.will_set(self.status_topic, payload="offline", qos=1, retain=True)
        while True:
            try:
                self.client.connect(self.broker_host, self.broker_port, keepalive=30)
                self.client.loop_forever()
            except Exception as e:
                print(f"[pi_agent] connection loop crashed, reconnecting in 5s: {e}")
                time.sleep(5)


if __name__ == "__main__":
    PiAgent().run()
