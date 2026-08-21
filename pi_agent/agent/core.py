import json
import os
import threading
import time
from datetime import datetime, timezone

import paho.mqtt.client as mqtt
from dotenv import load_dotenv

from .interfaces import InterfacesMixin
from .streaming import StreamingMixin
from .webui_proxy import WebUiProxyMixin
from .wifi import WifiMixin
from .wifi_scan import WifiScanMixin

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


class PiAgent(WifiMixin, WifiScanMixin, InterfacesMixin, StreamingMixin, WebUiProxyMixin):
    """MQTT command loop + registration/status lifecycle. Everything else
    (wifi, wifi scanning, interfaces, streaming/capture, AP web UI proxy) is
    a mixin in its own module - see agent/wifi.py, wifi_scan.py,
    interfaces.py, streaming.py, webui_proxy.py. All of them share this
    class's instance state (locks, caches, the MQTT client), so which file a
    method lives in has no effect on behavior - purely an organizational
    split of what was previously one ~1700-line file."""

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

        # One lock per interface, created on demand - connect_wifi/
        # disconnect_wifi can now take minutes (nmcli timeout=300), so two
        # commands aimed at the *same* interface must run strictly one
        # after another instead of racing on the same NetworkManager
        # profile; different interfaces still run fully concurrently.
        self._wifi_locks = {}
        self._wifi_locks_guard = threading.Lock()
        # Guards against on_connect (which can fire again on every
        # reconnect) starting a second/third background wifi scan loop.
        self._wifi_scan_loop_started = False
        self._interface_status_loop_started = False

        # interface -> {"port", "gateway", "timer"} for start_ap_webui_proxy's
        # DNAT/MASQUERADE rules - see that method for the full explanation.
        self._webui_proxies = {}
        self._webui_proxies_lock = threading.Lock()
        # Best-effort - iptables/iptables-save missing (not every Pi image
        # has them installed), no root, or any other environment quirk here
        # must never prevent the agent from starting and connecting to the
        # broker. A failed cleanup just means a stale rule might survive
        # until start_ap_webui_proxy is next called for that interface,
        # which replaces it anyway - not something worth an offline agent.
        try:
            self._cleanup_stale_webui_proxy_rules()
        except Exception as e:
            print(f"[pi_agent] webui proxy rule cleanup failed, continuing without it: {e}")

        # The broker (mosquitto 1.6.9) only speaks MQTT 3.1.1 - v5 broker
        # support wasn't added until mosquitto 2.0. Connecting as v5 anyway
        # is undefined behavior against this broker; clean_session=True here
        # is the unambiguous v3.1.1 way to guarantee every (re)connect starts
        # a fresh session, so no stale/queued command (like an old tcpdump
        # start) ever gets replayed on reconnect or agent restart.
        self.client = mqtt.Client(client_id=pi_id, protocol=mqtt.MQTTv311, clean_session=True)
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message

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
                result = self.run_iperf_server_test(payload.get("duration", 10), payload.get("interface"))
            elif action == "signal_stats":
                result = {"stations": self.get_signal_stats()}
            elif action == "band_channel_info":
                result = self.get_band_channel_info(payload.get("interface"))
            elif action == "link_info":
                result = self.get_link_info(payload.get("interface"))
            elif action == "set_channel":
                result = self.restart_hostapd(channel=payload.get("channel"))
            elif action == "connect_wifi":
                interface = payload.get("interface")
                self._dispatch_wifi_command(
                    action, payload.get("command_id"), interface, self.connect_wifi,
                    payload.get("ssid"), payload.get("password"), interface,
                    payload.get("bssid"), payload.get("channel"),
                )
                return
            elif action == "disconnect_wifi":
                interface = payload.get("interface")
                self._dispatch_wifi_command(
                    action, payload.get("command_id"), interface, self.disconnect_wifi, interface,
                )
                return
            elif action == "scan_wifi":
                result = self.get_wifi_scan(payload.get("interface"))
            elif action == "wifi_detail_scan":
                result = self.get_wifi_scan_detail(payload.get("interface"))
            elif action == "set_monitor_channel":
                result = self.set_monitor_channel(payload.get("interface"), payload.get("channel"))
            elif action == "set_interface_mode":
                # Dispatched off the MQTT network thread like connect_wifi/
                # disconnect_wifi (see _dispatch_wifi_command) - deleting and
                # recreating the netdev plus handing it to/back from
                # NetworkManager can take a while (NM re-associating,
                # renewing DHCP, etc.), and blocking this thread that long
                # risks missing the broker's keepalive and losing the
                # result-publish entirely, even though the switch itself
                # (pure subprocess calls) completes fine on the Pi regardless.
                interface = payload.get("interface")
                self._dispatch_wifi_command(
                    action, payload.get("command_id"), interface, self.set_interface_mode,
                    interface, payload.get("mode"),
                )
                return
            elif action == "start_ap_webui_proxy":
                result = self.start_ap_webui_proxy(payload.get("interface"))
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
        if not self._wifi_scan_loop_started:
            self._wifi_scan_loop_started = True
            threading.Thread(target=self._wifi_background_scan_loop, daemon=True).start()
        if not self._interface_status_loop_started:
            self._interface_status_loop_started = True
            threading.Thread(target=self._interface_status_loop, daemon=True).start()

    def on_message(self, client, userdata, msg):
        try:
            payload = json.loads(msg.payload.decode())
        except json.JSONDecodeError:
            return
        try:
            self.handle_command(payload)
        except Exception as e:
            print(f"[pi_agent] unhandled error processing {payload.get('action')}: {e}")

    def run(self):
        self.client.will_set(self.status_topic, payload="offline", qos=1, retain=True)
        while True:
            try:
                # Temporarily disabled: was binding to a wired interface's
                # IP (via _wired_source_ip) to prefer wired over wifi for
                # control-plane traffic. Restore by uncommenting below.
                # bind_address = self._wired_source_ip() or ""
                self.client.connect(self.broker_host, self.broker_port, keepalive=30)
                self.client.loop_forever()
            except Exception as e:
                print(f"[pi_agent] connection loop crashed, reconnecting in 5s: {e}")
                time.sleep(5)
