import json
import os
import socket
import subprocess
import threading
import time
from datetime import datetime, timezone
import paho.mqtt.client as mqtt
import re
from dotenv import load_dotenv

load_dotenv()

BROKER_HOST = os.environ["BROKER_HOST"]
BROKER_PORT = int(os.environ["BROKER_PORT"])
PI_ID = os.environ["PI_ID"]
ROLE = os.environ["ROLE"]


class PiAgent:
    TCPDUMP_LINE_RE = re.compile(r'^(?P<timestamp>\d{2}:\d{2}:\d{2}\.\d+)\s+(?P<message>.*)$')

    def __init__(self, broker_host=BROKER_HOST, broker_port=BROKER_PORT, pi_id=PI_ID, role=ROLE):
        self.broker_host = broker_host
        self.broker_port = broker_port
        self.pi_id = pi_id
        self.role = role

        self.cmd_topic_mine = f'test/{pi_id}/cmd'
        self.cmd_topic_all = 'test/all/cmd'
        self.result_topic = f'test/{pi_id}/result'
        self.status_topic = f'test/{pi_id}/status'
        self.mqtt_log_topic = f'devices/{pi_id}/logs/'
        self.registration_topic = f'devices/{pi_id}/registration'

        self._streaming_started = False
        self._streaming_lock = threading.Lock()
        self._syslog_proc = None
        self._syslog_interface = None

        self._tcpdump_running = set()
        self._tcpdump_procs = {}
        self._tcpdump_lock = threading.Lock()

        self.client = mqtt.Client(client_id=pi_id, protocol=mqtt.MQTTv5)
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

    def stream_syslog(self, interface=None):
        """Follow the journal forever, publishing each new line as it appears.
        If interface is given, journalctl itself filters to lines mentioning it."""
        cmd = ["journalctl", "-u", "NetworkManager", "-n", "50", "-f"]
        if interface:
            cmd += ["-g", interface]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True)
        with self._streaming_lock:
            self._syslog_proc = proc
        try:
            for line in proc.stdout:
                self.client.publish(self.mqtt_log_topic, line.rstrip("\n"), qos=1)
        finally:
            # journalctl -f should never exit on its own, but if it does
            # (crash, killed externally, or superseded by a switch to a
            # different interface), only clear the flag if we're still the
            # current stream - otherwise this old thread's cleanup would
            # clobber the state of whatever stream replaced it.
            with self._streaming_lock:
                if self._syslog_proc is proc:
                    self._streaming_started = False
                    self._syslog_proc = None
                    self._syslog_interface = None

    def start_syslog_stream(self, interface=None):
        """Start the syslog streaming thread for the given interface filter.

        No-op if already streaming that exact interface. If a stream for a
        *different* interface is running, it's stopped and replaced - previously
        this was a blanket no-op whenever any stream was active, so switching
        from wlan1 to wlan0 silently kept the old wlan1-filtered stream running.
        """
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
        threading.Thread(target=self.stream_syslog, args=(interface,), daemon=True).start()
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

    def parse_tcpdump_line(self, line, interface):
        """Parse one tcpdump output line into a structured record."""
        m = self.TCPDUMP_LINE_RE.match(line)
        return {
            "timestamp": m.group("timestamp") if m else None,
            "loglevel": "packet" if m else "error",
            "message": m.group("message") if m else line,
            "device_id": self.pi_id,
            "interface": interface,
        }

    def stream_tcpdump(self, interface):
        """Follow tcpdump on one interface forever, publishing each captured line."""
        topic = f'devices/{self.pi_id}/tcpdump/{interface}'
        proc = subprocess.Popen(
            ["tcpdump", "-i", interface, "-l", "-n", "-q"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        with self._tcpdump_lock:
            self._tcpdump_procs[interface] = proc
        try:
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                record = self.parse_tcpdump_line(line, interface)
                self.client.publish(topic, json.dumps(record), qos=1)
        finally:
            # If tcpdump dies unexpectedly, clear the flag so a future
            # start_tcpdump_stream() call for this interface isn't a
            # permanent no-op.
            with self._tcpdump_lock:
                self._tcpdump_running.discard(interface)
                self._tcpdump_procs.pop(interface, None)

    def start_tcpdump_stream(self, interface):
        """Start the tcpdump streaming thread for one interface once, no-op if already running."""
        with self._tcpdump_lock:
            if interface in self._tcpdump_running:
                return False
            self._tcpdump_running.add(interface)
        threading.Thread(target=self.stream_tcpdump, args=(interface,), daemon=True).start()
        return True

    def stop_tcpdump_stream(self, interface):
        """Stop the tcpdump streaming thread for one interface, if running."""
        with self._tcpdump_lock:
            if interface not in self._tcpdump_running:
                return False
            self._tcpdump_running.discard(interface)
            proc = self._tcpdump_procs.pop(interface, None)
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

    def ping_internet(self, interface=None):
        cmd = ["ping", "8.8.8.8", "-c", "5"]
        if interface:
            cmd += ["-I", f"{interface}"]
        ret = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        match = re.search(r'(\d+)% packet loss', ret.stdout)
        return {
            "packet_lost": int(match.group(1)) if match else None,
            "interface": interface,
        }

    def connect_wifi(self, ssid, password=None, interface=None):
        """Connect to a wifi hotspot via NetworkManager, using a connection
        profile scoped to this interface (con-name "<ssid>-<interface>").

        Plain `nmcli device wifi connect <ssid>` keys its profile off the SSID
        name alone, so a second NIC joining the same SSID collides with the
        first NIC's profile and gets auto-renamed (e.g. "SSID 1") without a
        complete security section, failing with
        "802-11-wireless-security.key-mgmt: property is missing". Giving each
        interface its own profile name sidesteps that collision entirely.
        """
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
        return {
            "ssid": ssid,
            "interface": interface,
            "connected": connected,
            "ip_address": self.get_interface_ip(interface) if connected else None,
            "output": (up_ret.stdout or up_ret.stderr).strip(),
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
            elif action == "set_channel":
                result = self.restart_hostapd(channel=payload.get("channel"))
            elif action == "connect_wifi":
                result = self.connect_wifi(
                    payload.get("ssid"),
                    payload.get("password"),
                    payload.get("interface"),
                )
            elif action == "disconnect_wifi":
                result = self.disconnect_wifi(payload.get("interface"))
            elif action == "list_interfaces":
                self.publish_registration()
                result = {"interfaces": self.get_network_interfaces()}
            elif action == "list_interface_ips":
                result = {"interfaces": self.get_interface_ips()}
            elif action == "ping":
                result = self.ping_internet(payload.get("interface"))
            elif action == "syslog":
                result = {"logs": self.get_syslog(payload.get("lines", 100))}
            elif action == "stream_logs":
                interface = payload.get("interface")
                if not interface:
                    result = {"error": "interface is required"}
                else:
                    started = self.start_syslog_stream(interface)
                    result = {
                        "streaming": True,
                        "already_running": not started,
                        "topic": self.mqtt_log_topic,
                        "interface": interface,
                    }
            elif action == "tcpdump":
                interface = payload.get("interface")
                if not interface:
                    result = {"error": "interface is required"}
                else:
                    started = self.start_tcpdump_stream(interface)
                    result = {
                        "streaming": True,
                        "already_running": not started,
                        "interface": interface,
                        "topic": f'devices/{self.pi_id}/tcpdump/{interface}',
                    }
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
            else:
                result = {"error": f"unknown action: {action}"}
        except Exception as e:
            result = {"error": str(e)}

        result["command_id"] = payload.get("command_id")
        result["action"] = action
        result["pi_id"] = self.pi_id
        result["timestamp"] = datetime.now(timezone.utc).isoformat()

        self.client.publish(self.result_topic, json.dumps(result), qos=1)

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

    def get_interface_ips(self):
        """Map of interface name -> IPv4 address for every non-loopback interface."""
        return {
            interface: self.get_interface_ip(interface)
            for interface in self.get_network_interfaces()
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
        self.handle_command(payload)

    def run(self):
        self.client.will_set(self.status_topic, payload="offline", qos=1, retain=True)
        self.client.connect(self.broker_host, self.broker_port, keepalive=30)
        self.client.loop_forever()


if __name__ == "__main__":
    PiAgent().run()
