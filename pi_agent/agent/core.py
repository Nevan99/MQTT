import asyncio
import json
import os
from datetime import datetime, timezone

import aiomqtt
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
# When set, the MQTT connection to the broker is bound to this interface's
# current IP address (see run()) - forcing the agent's communication with
# the backend over wired Ethernet even on a Pi with several wifi radios
# that might otherwise win the system's default route. Empty/unset keeps
# the previous behavior: whatever the OS routing table picks.
WIRED_INTERFACE = os.environ.get("WIRED_INTERFACE", "eth0")

RECONNECT_DELAY_SECONDS = 5


class PiAgent(WifiMixin, WifiScanMixin, InterfacesMixin, StreamingMixin, WebUiProxyMixin):
    """MQTT command loop + registration/status lifecycle. Everything else
    (wifi, wifi scanning, interfaces, streaming/capture, AP web UI proxy) is
    a mixin in its own module - see agent/wifi.py, wifi_scan.py,
    interfaces.py, streaming.py, webui_proxy.py. All of them share this
    class's instance state (locks, caches, the MQTT client), so which file a
    method lives in has no effect on behavior - purely an organizational
    split of what was previously one ~1700-line file.

    Everything runs on one asyncio event loop. The agent is almost entirely
    an orchestrator of CLI tools, so what used to be a thread per
    command/loop is now a task per command/loop, with the actual waiting
    done by asyncio.create_subprocess_exec (see agent/proc.py) rather than
    by a blocked thread. That matters most on the 4-radios-per-Pi rigs: a
    slow `iw scan` on one interface no longer occupies anything while the
    other three are worked on.
    """

    def __init__(self, broker_host=BROKER_HOST, broker_port=BROKER_PORT, pi_id=PI_ID, role=ROLE,
                 capture_socket_host=CAPTURE_SOCKET_HOST, capture_socket_port=CAPTURE_SOCKET_PORT,
                 wired_interface=WIRED_INTERFACE):
        self.broker_host = broker_host
        self.broker_port = broker_port
        self.pi_id = pi_id
        self.role = role
        self.capture_socket_host = capture_socket_host
        self.capture_socket_port = capture_socket_port
        self.wired_interface = wired_interface

        self.cmd_topic_mine = f'test/{pi_id}/cmd'
        self.cmd_topic_all = 'test/all/cmd'
        self.result_topic = f'test/{pi_id}/result'
        self.status_topic = f'test/{pi_id}/status'
        self.registration_topic = f'devices/{pi_id}/registration'

        self._pcap_procs = {}
        self._pcap_state = {}
        self._pcap_lock = asyncio.Lock()

        # Live view only (see start_tcpdump_stream/start_syslog_stream) -
        # separate processes/sockets from the pcap recording above, so a
        # view and a recording can run concurrently on the same interface.
        self._streaming_started = False
        self._streaming_lock = asyncio.Lock()
        self._syslog_proc = None
        self._syslog_interface = None

        self._tcpdump_running = set()
        self._tcpdump_procs = {}
        self._tcpdump_lock = asyncio.Lock()

        # One lock per interface, created on demand - connect_wifi/
        # disconnect_wifi can take tens of seconds, so two commands aimed
        # at the *same* interface must run strictly one after another
        # instead of racing on the same interface state; different
        # interfaces still run fully concurrently.
        #
        # No guard lock around the dict: creation happens inside
        # _wifi_lock_for with no await in between, so it is atomic against
        # other tasks on the same loop.
        self._wifi_locks = {}
        # interface -> count of user commands queued on that interface's
        # lock. The background scan loop skips an interface with a pending
        # count, so a user-triggered connect/disconnect doesn't have to
        # wait out a scan that started moments before it arrived - see
        # _wifi_pending_command / _wifi_background_scan_one.
        self._wifi_pending = {}
        # Strong references to in-flight dispatched command tasks. asyncio
        # only holds weak ones, so without this a task nobody references
        # can be garbage-collected mid-command.
        self._wifi_tasks = set()
        self._background_tasks = set()

        # interface -> {"port", "gateway", "timer"} for start_ap_webui_proxy's
        # DNAT/MASQUERADE rules - see that method for the full explanation.
        self._webui_proxies = {}
        self._webui_proxies_lock = asyncio.Lock()

        # The aiomqtt client for the current connection. Rebuilt on each
        # reconnect by run(); None while disconnected, which `publish`
        # tolerates rather than raising into a background loop.
        self.client = None
        self._client_lock = asyncio.Lock()

    # --- MQTT plumbing ---------------------------------------------------

    async def publish(self, topic, payload, qos=1, retain=False):
        """Publish, tolerating a disconnected client.

        Background loops publish constantly; a reconnect in progress must
        drop those rather than raise into the loop and kill it. Command
        results take the same path, which is acceptable for the same reason
        it was under paho's clean_session=True: a result that can't be sent
        during a disconnect window is gone either way.
        """
        client = self.client
        if client is None:
            return False
        try:
            # aiomqtt is not safe for concurrent publishes on one client.
            async with self._client_lock:
                await client.publish(topic, payload=payload, qos=qos, retain=retain)
            return True
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[pi_agent] publish to {topic} failed: {e}")
            return False

    def _spawn(self, coro, name):
        task = asyncio.create_task(coro, name=name)
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)
        return task

    # --- lifecycle -------------------------------------------------------

    @staticmethod
    async def wait_until(iso_timestamp):
        """Wait until the synchronized start time given by the controller."""
        target = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00"))
        delay = (target - datetime.now(timezone.utc)).total_seconds()
        if delay > 0:
            await asyncio.sleep(delay)

    async def handle_command(self, payload):
        action = payload.get("action")
        at = payload.get("at")

        if at:
            await self.wait_until(at)

        try:
            if action == "throughput_test":
                result = await self.run_iperf_server_test(payload.get("duration", 10), payload.get("interface"))
            elif action == "signal_stats":
                result = {"stations": await self.get_signal_stats()}
            elif action == "band_channel_info":
                result = await self.get_band_channel_info(payload.get("interface"))
            elif action == "link_info":
                result = await self.get_link_info(payload.get("interface"))
            elif action == "set_channel":
                result = await self.restart_hostapd(channel=payload.get("channel"))
            elif action == "connect_wifi":
                interface = payload.get("interface")
                self._dispatch_wifi_command(
                    action, payload.get("command_id"), interface, self.connect_wifi,
                    payload.get("ssid"), payload.get("password"), interface,
                    payload.get("bssid"), payload.get("channel"),
                    payload.get("auto_reconnect", False),
                )
                return
            elif action == "disconnect_wifi":
                interface = payload.get("interface")
                self._dispatch_wifi_command(
                    action, payload.get("command_id"), interface, self.disconnect_wifi, interface,
                )
                return
            elif action == "nearby_hotspots":
                # Replaced scan_wifi. Takes `interfaces` (a list, or one
                # name, or omitted for every scannable radio) and merges
                # what they each saw by BSSID - see get_nearby_hotspots.
                result = await self.get_nearby_hotspots(
                    payload.get("interfaces") or payload.get("interface"),
                )
            elif action == "connect_hotspot":
                # Fan-out connect: several of this Pi's radios onto one AP,
                # concurrently. Dispatched off the message loop like the
                # other connect paths, since it takes as long as the
                # slowest radio's association plus DHCP. interface=None so
                # dispatch takes no single lock - connect_hotspot takes one
                # per radio itself.
                self._dispatch_wifi_command(
                    action, payload.get("command_id"), None, self.connect_hotspot,
                    payload.get("ssid"), payload.get("password"),
                    payload.get("bssid"), payload.get("channel"),
                    payload.get("interfaces") or payload.get("interface"),
                    payload.get("auto_reconnect", False),
                )
                return
            elif action == "wifi_detail_scan":
                # Served from cfg80211's scan cache, kept warm by
                # _wifi_background_scan_one. This used to drive a fresh
                # blocking `iw scan` right here on the MQTT network thread,
                # which both starved paho's keepalive for seconds and had to
                # queue behind any connect/disconnect holding the radio. A
                # cache read needs no lock and returns in milliseconds, at
                # the cost of results up to one background cycle stale.
                result = await self.get_wifi_scan_detail(payload.get("interface"), use_cache=True)
            elif action == "set_monitor_channel":
                result = await self.set_monitor_channel(payload.get("interface"), payload.get("channel"))
            elif action == "set_interface_mode":
                # Dispatched as its own task like connect_wifi/
                # disconnect_wifi (see _dispatch_wifi_command) - deleting and
                # recreating the netdev plus handing it to/back from
                # NetworkManager can take a while (NM re-associating,
                # renewing DHCP, etc.), and awaiting that inline would stall
                # every other command queued behind it on this Pi.
                interface = payload.get("interface")
                self._dispatch_wifi_command(
                    action, payload.get("command_id"), interface, self.set_interface_mode,
                    interface, payload.get("mode"),
                )
                return
            elif action == "start_ap_webui_proxy":
                result = await self.start_ap_webui_proxy(payload.get("interface"))
            elif action == "list_interfaces":
                await self.publish_registration()
                result = {"interfaces": await self.get_interface_details()}
            elif action == "ping":
                result = await self.ping_internet(
                    payload.get("interface"), payload.get("target"), payload.get("count"),
                )
            elif action == "syslog":
                result = {"logs": await self.get_syslog(payload.get("lines", 100))}
            elif action == "stream_logs":
                interface = payload.get("interface")
                if not interface:
                    result = {"error": "interface is required"}
                else:
                    started = await self.start_syslog_stream(interface)
                    result = {"streaming": True, "already_running": not started, "interface": interface}
            elif action == "tcpdump":
                interface = payload.get("interface")
                if not interface:
                    result = {"error": "interface is required"}
                else:
                    started = await self.start_tcpdump_stream(interface)
                    result = {"streaming": True, "already_running": not started, "interface": interface}
            elif action == "stop_logs":
                stopped = await self.stop_syslog_stream()
                result = {"streaming": False, "stopped": stopped}
            elif action == "stop_tcpdump":
                interface = payload.get("interface")
                if not interface:
                    result = {"error": "interface is required"}
                else:
                    stopped = await self.stop_tcpdump_stream(interface)
                    result = {"streaming": False, "interface": interface, "stopped": stopped}
            elif action == "start_pcap_capture":
                interface = payload.get("interface")
                if not interface:
                    result = {"error": "interface is required"}
                else:
                    started = await self.start_pcap_capture(interface, payload.get("name"))
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
                    result = await self.stop_pcap_capture(interface)
                    result["capturing"] = False
            else:
                result = {"error": f"unknown action: {action}"}
        except asyncio.CancelledError:
            raise
        except Exception as e:
            result = {"error": str(e)}

        result["command_id"] = payload.get("command_id")
        result["action"] = action
        result["pi_id"] = self.pi_id
        result["timestamp"] = datetime.now(timezone.utc).isoformat()

        # A pcap result in particular can be tens of MB of base64 - if
        # serializing/publishing that blows up, don't let it escape into
        # the message loop. Better to drop this one result than take down
        # the whole agent and leave every future command "pending" forever
        # until someone notices and restarts the process.
        try:
            await self.publish(self.result_topic, json.dumps(result), qos=1)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[pi_agent] failed to publish result for {action}: {e}")

    async def publish_registration(self):
        payload = {
            "ip_address": self.get_ip_address(),
            "role": self.role,
            "topics": [self.cmd_topic_mine, self.cmd_topic_all],
            "metadata": {"interfaces": await self.get_network_interfaces()},
        }
        await self.publish(self.registration_topic, json.dumps(payload), qos=1, retain=True)

    async def on_connect(self):
        """Subscribe, announce, and make sure the background loops exist.

        Runs on every (re)connect, so the loop guards matter: a reconnect
        must not leave a second scan loop running alongside the first.
        """
        await self.client.subscribe(self.cmd_topic_mine, qos=1)
        await self.client.subscribe(self.cmd_topic_all, qos=1)
        await self.publish(self.status_topic, "online", qos=1, retain=True)
        await self.publish_registration()
        await self.start_background_loops()

    async def start_background_loops(self):
        if not any(t.get_name() == "wifi-scan-loop" for t in self._background_tasks):
            self._spawn(self._wifi_background_scan_loop(), "wifi-scan-loop")
        if not any(t.get_name() == "interface-status-loop" for t in self._background_tasks):
            self._spawn(self._interface_status_loop(), "interface-status-loop")
        # Once per process start, not every reconnect - a saved profile is
        # replayed here rather than in start() because it needs the wifi
        # lock/pending-command machinery (asyncio primitives, same event
        # loop) rather than running before the loop is definitely up.
        if not any(t.get_name() == "wifi-reconnect" for t in self._background_tasks):
            self._spawn(self._replay_saved_wifi_profiles(), "wifi-reconnect")

    async def on_message(self, message):
        try:
            payload = json.loads(message.payload.decode())
        except (json.JSONDecodeError, AttributeError, UnicodeDecodeError):
            return
        try:
            await self.handle_command(payload)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[pi_agent] unhandled error processing {payload.get('action')}: {e}")

    async def start(self):
        """Process entry point: one-time startup work, then run forever.

        The stale-rule sweep used to happen in __init__, which it no longer
        can now that it awaits. Best-effort by design - iptables missing
        (not every Pi image has it), no root, or any other environment
        quirk must never stop the agent reaching the broker. A failed
        cleanup just risks a stale rule surviving until start_ap_webui_proxy
        next replaces it, which is not worth an offline agent.
        """
        try:
            await self._cleanup_stale_webui_proxy_rules()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[pi_agent] webui proxy rule cleanup failed, continuing without it: {e}")
        await self.run()

    async def run(self):
        """Connect, serve commands, and reconnect forever.

        Each command is handled as its own task rather than awaited inline:
        a long-running action (a ping sweep, an iperf run) must not stop the
        loop pulling the next message, which is the async equivalent of the
        keepalive starvation the old threaded dispatch existed to avoid.
        """
        while True:
            try:
                # Bind to the wired interface's current IP, if it has one,
                # so the connection to the broker goes out over Ethernet
                # even when a wifi radio also has a route to it (and might
                # otherwise be what the OS picks as the default route).
                # Re-resolved on every (re)connect, not just once, since
                # DHCP can renew that IP or the interface can come up after
                # the agent already started. Best-effort: no IP yet (cable
                # unplugged, interface still coming up) falls back to
                # unbound - whatever the OS routing table picks - rather
                # than refusing to connect at all.
                bind_address = ""
                if self.wired_interface:
                    try:
                        bind_address = await self.get_interface_ip(self.wired_interface) or ""
                    except asyncio.CancelledError:
                        raise
                    except Exception as e:
                        print(f"[pi_agent] could not resolve {self.wired_interface}'s IP, connecting unbound: {e}")
                    if not bind_address:
                        print(f"[pi_agent] {self.wired_interface} has no IPv4 address yet, connecting unbound")
                    else:
                        # Otherwise a successful bind is silent, which made
                        # it indistinguishable from an agent build that
                        # predates this feature entirely (both produce no
                        # matching log line) - print it explicitly so
                        # `journalctl -u pi-agent | grep bound` gives a
                        # definite yes/no per connect.
                        print(f"[pi_agent] MQTT connection bound to {self.wired_interface} ({bind_address})")

                # clean_session=True: the broker (mosquitto 1.6.9) only
                # speaks MQTT 3.1.1, and a fresh session on every connect is
                # the unambiguous way to guarantee no stale/queued command
                # (an old tcpdump start, say) gets replayed on reconnect.
                async with aiomqtt.Client(
                    hostname=self.broker_host,
                    port=self.broker_port,
                    identifier=self.pi_id,
                    protocol=aiomqtt.ProtocolVersion.V311,
                    clean_session=True,
                    keepalive=30,
                    will=aiomqtt.Will(self.status_topic, payload=b"offline", qos=1, retain=True),
                    bind_address=bind_address,
                ) as client:
                    self.client = client
                    await self.on_connect()
                    async for message in client.messages:
                        self._spawn(self.on_message(message), "command")
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[pi_agent] connection loop crashed, reconnecting in "
                      f"{RECONNECT_DELAY_SECONDS}s: {e}")
            finally:
                self.client = None
            await asyncio.sleep(RECONNECT_DELAY_SECONDS)
