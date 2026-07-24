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

CMD_TOPIC_MINE = f'test/{PI_ID}/cmd'
CMD_TOPIC_ALL = f'test/all/cmd'
RESULT_TOPIC = f'test/{PI_ID}/result'
STATUS_TOPIC = f'test/{PI_ID}/status'
MQTT_LOG_TOPIC = f'devices/{PI_ID}/logs/'
DEVICES_REGISTRATION = f'devices/{PI_ID}/registration'
ROLE = "client"
_streaming_started = False
_streaming_lock = threading.Lock()
_syslog_proc = None
SYSLOG_RE = re.compile(
    r'^(?P<timestamp>[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+'
    r'(?P<host>\S+)\s+'
    r'(?P<process>[\w.\-]+)(?:\[(?P<pid>\d+)\])?:\s*'
    r'(?:<(?P<loglevel>\w+)>\s*)?'
    r'(?P<message>.*)$'
)
INTERFACE_RE = re.compile(r'\((?P<interface>wlan\d+|eth\d+|br-\w+|lo)\)')
def run_iperf_server_test(duration=10):
    result = subprocess.run(["iperf3","-c","192.168.150.20","-t",str(duration),"-J"], capture_output=True, text=True, timeout=duration + 15)
    data = json.loads(result.stdout)
    return {
        "throughput_mbps": data["end"]["sum_received"]["bits_per_second"] /1e6,
        "retransmits": data["end"]["sum_sent"].get("retransmits"),
    }

# def parse_syslog_line(line):
#     """Parse one syslog line into a structured record, or None if unparseable."""
#     m = SYSLOG_RE.match(line)
#     if not m:
#         return None
#     iface_match = INTERFACE_RE.search(m.group("message"))
#     return {
#         "timestamp": m.group("timestamp"),
#         "loglevel": m.group("loglevel") or "unknown",
#         "message": m.group("message").strip(),
#         "device_id": PI_ID,
#         "interface": iface_match.group("interface") if iface_match else None,
#     }

def get_syslog(lines=100):
    """Pull recent journal lines and parse them into structured records."""
    out = subprocess.run(
        ["journalctl", "-n", str(lines), "--no-pager"],
        capture_output=True, text=True,
    ).stdout

    records = [line for line in out.splitlines()]
    return [r for r in records if r is not None]

def stream_syslog(client, interface=None):
    """Follow the journal forever, publishing each new parsed line as it appears.
    If interface is given, journalctl itself filters to lines mentioning it."""
    global _syslog_proc
    cmd = ["journalctl", "-u", "NetworkManager","-n","50"]
    if interface:
        cmd += ["-g", interface]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True)
    _syslog_proc = proc
    for line in proc.stdout:
        record = line.rstrip("\n")
        if record is None:
            continue
        client.publish(MQTT_LOG_TOPIC, record, qos=1)

def start_syslog_stream(client, interface=None):
    """Start the syslog streaming thread once, no-op if already running."""
    global _streaming_started
    with _streaming_lock:
        if _streaming_started:
            return False
        _streaming_started = True
    threading.Thread(target=stream_syslog, args=(client, interface), daemon=True).start()
    return True

def stop_syslog_stream():
    """Stop the syslog streaming thread, if running."""
    global _streaming_started, _syslog_proc
    with _streaming_lock:
        if not _streaming_started:
            return False
        _streaming_started = False
        proc = _syslog_proc
        _syslog_proc = None
    if proc:
        proc.terminate()
    return True

_tcpdump_running = set()
_tcpdump_procs = {}
_tcpdump_lock = threading.Lock()

TCPDUMP_LINE_RE = re.compile(r'^(?P<timestamp>\d{2}:\d{2}:\d{2}\.\d+)\s+(?P<message>.*)$')

def parse_tcpdump_line(line, interface):
    """Parse one tcpdump output line into the same record shape as parse_syslog_line."""
    m = TCPDUMP_LINE_RE.match(line)
    return {
        "timestamp": m.group("timestamp") if m else None,
        "loglevel": "packet" if m else "error",
        "message": m.group("message") if m else line,
        "device_id": PI_ID,
        "interface": interface,
    }

def stream_tcpdump(client, interface):
    """Follow tcpdump on one interface forever, publishing each captured line."""
    topic = f'devices/{PI_ID}/tcpdump/{interface}'
    proc = subprocess.Popen(
        ["tcpdump", "-i", interface, "-l"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    with _tcpdump_lock:
        _tcpdump_procs[interface] = proc
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        record = parse_tcpdump_line(line, interface)
        client.publish(topic, json.dumps(record), qos=1)

def start_tcpdump_stream(client, interface):
    """Start the tcpdump streaming thread for one interface once, no-op if already running."""
    with _tcpdump_lock:
        if interface in _tcpdump_running:
            return False
        _tcpdump_running.add(interface)
    threading.Thread(target=stream_tcpdump, args=(client, interface), daemon=True).start()
    return True

def stop_tcpdump_stream(interface):
    """Stop the tcpdump streaming thread for one interface, if running."""
    with _tcpdump_lock:
        if interface not in _tcpdump_running:
            return False
        _tcpdump_running.discard(interface)
        proc = _tcpdump_procs.pop(interface, None)
    if proc:
        proc.terminate()
    return True

def get_signal_stats():
    """Pull RSSI / link stats for connected stations (Pi acting as AP)."""
    out = subprocess.run(
        ["iw", "dev", "wlan0", "station", "dump"],
        capture_output=True, text=True,
    ).stdout
    return out.strip()
def ping_internet(interface=None):
    cmd = ["ping", "8.8.8.8", "-c", "5"]
    if interface:
        cmd += ["-I", interface]
    ret = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    match = re.search(r'(\d+)% packet loss', ret.stdout)
    return {"packet_lost": int(match.group(1)) if match else None, "interface": interface}


def restart_hostapd(channel=None):
    if channel:
        subprocess.run(["sed", "-i", f"s/^channel=.*/channel={channel}/",
                         "/etc/hostapd/hostapd.conf"])
    subprocess.run(["systemctl", "restart", "hostapd"])
    return {"restarted": True, "channel": channel}

def wait_until(iso_timestamp):
    target = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00"))
    delay = (target - datetime.now(timezone.utc)).total_seconds()
    if delay > 0:
        time.sleep(delay)

def handle_command(client, payload):
    action = payload.get("action")
    at = payload.get("at")
 
    if at:
        wait_until(at)
 
    try:
        if action == "throughput_test":
            result = run_iperf_server_test(payload.get("duration", 10))
        elif action == "signal_stats":
            result = {"stations": get_signal_stats()}
        elif action == "set_channel":
            result = restart_hostapd(channel=payload.get("channel"))
        elif action == "ping":
            result = ping_internet(payload.get("interface"))
        elif action == "syslog":
            result = {"logs": get_syslog(payload.get("lines", 100))}
        elif action == "stream_logs":
            interface = payload.get("interface")
            started = start_syslog_stream(client, interface)
            result = {
                "streaming": True,
                "already_running": not started,
                "topic": MQTT_LOG_TOPIC,
                "interface": interface,
            }
        elif action == "tcpdump":
            interface = payload.get("interface")
            if not interface:
                result = {"error": "interface is required"}
            else:
                started = start_tcpdump_stream(client, interface)
                result = {
                    "streaming": True,
                    "already_running": not started,
                    "interface": interface,
                    "topic": f'devices/{PI_ID}/tcpdump/{interface}',
                }
        elif action == "stop_logs":
            stopped = stop_syslog_stream()
            result = {"streaming": False, "stopped": stopped}
        elif action == "stop_tcpdump":
            interface = payload.get("interface")
            if not interface:
                result = {"error": "interface is required"}
            else:
                stopped = stop_tcpdump_stream(interface)
                result = {"streaming": False, "interface": interface, "stopped": stopped}
        else:
            result = {"error": f"unknown action: {action}"}
    except Exception as e:
        result = {"error": str(e)}
 
    result["command_id"] = payload.get("command_id")
    result["action"] = action
    result["pi_id"] = PI_ID
    result["timestamp"] = datetime.now(timezone.utc).isoformat()

    client.publish(RESULT_TOPIC, json.dumps(result), qos=1)
 
def wait_until(iso_timestamp):
    """Block until the synchronized start time given by the controller."""
    target = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00"))
    delay = (target - datetime.now(timezone.utc)).total_seconds()
    if delay > 0:
        time.sleep(delay)
def get_ip_address():
    """Best-effort local IP: the address used to reach the broker."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((BROKER_HOST, BROKER_PORT))
        return s.getsockname()[0]
    except OSError:
        return ""
    finally:
        s.close()

def publish_registration(client):
    payload = {
        "ip_address": get_ip_address(),
        "role": ROLE,
        "topics": [CMD_TOPIC_MINE, CMD_TOPIC_ALL],
        "metadata": {},
    }
    client.publish(DEVICES_REGISTRATION, json.dumps(payload), qos=1, retain=True)

def on_connect(client, userdata, flags, reason_code, properties= None ):
    client.subscribe(CMD_TOPIC_MINE,qos=1)
    client.subscribe(CMD_TOPIC_ALL,qos=1)
    client.publish(STATUS_TOPIC,"online",qos=1,retain=True)
    publish_registration(client)

def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode())
    except json.JSONDecodeError:
        return
    handle_command(client,payload)

def main():
    client = mqtt.Client(client_id=PI_ID, protocol=mqtt.MQTTv5)
    client.on_connect = on_connect
    client.on_message = on_message
    client.will_set(STATUS_TOPIC, payload="offline", qos=1, retain=True)
    client.connect(BROKER_HOST, BROKER_PORT, keepalive=30)
    client.loop_forever()

if __name__ ==  "__main__":
    main()