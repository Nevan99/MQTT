import json
import socket
import subprocess
import threading
import time
from datetime import datetime, timezone
import paho.mqtt.client as mqtt
import re


BROKER_HOST = "192.168.150.20"
BROKER_PORT = 1883
PI_ID = "pi02"
ROLE = "client"


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
        cmd = ["journalctl", "-u", "NetworkManager", "-n", "50"]
        if interface:
            cmd += ["-g", interface]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True)
        self._syslog_proc = proc
        for line in proc.stdout:
            self.client.publish(self.mqtt_log_topic, line.rstrip("\n"), qos=1)

    def start_syslog_stream(self, interface=None):
        """Start the syslog streaming thread once, no-op if already running."""
        with self._streaming_lock:
            if self._streaming_started:
                return False
            self._streaming_started = True
        threading.Thread(target=self.stream_syslog, args=(interface,), daemon=True).start()
        return True

    def stop_syslog_stream(self):
        """Stop the syslog streaming thread, if running."""
        with self._streaming_lock:
            if not self._streaming_started:
                return False
            self._streaming_started = False
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
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            record = self.parse_tcpdump_line(line, interface)
            self.client.publish(topic, json.dumps(record), qos=1)

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
            elif action == "ping":
                result = self.ping_internet(payload.get("interface"))
            elif action == "syslog":
                result = {"logs": self.get_syslog(payload.get("lines", 100))}
            elif action == "stream_logs":
                interface = payload.get("interface")
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
            "metadata": {},
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
