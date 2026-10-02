import asyncio
import json
import os
import time
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
# How long a publish that failed because the connection was down stays
# worth retrying. Bounded by the UI's own polling ceiling
# (awaitCommandResult's maxAttempts x 1s, up to 320s in fleet-table.js /
# detail-page.js) - replaying a result well past that just delivers it to
# a browser that already gave up and reported "timed out waiting for the
# Pi", which is worse than not delivering it: silently stale data landing
# on a poll loop nobody is running any more.
PENDING_RESULT_MAX_AGE_SECONDS = 300


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
        # Caps how many interfaces can be mid-connect at once, system-wide
        # on this Pi - separate from _wifi_lock_for, which only serializes
        # commands aimed at the *same* interface and does nothing to limit
        # different interfaces running fully in parallel. connect_wifi alone
        # spawns roughly a dozen subprocesses per interface (wpa_supplicant,
        # ~7 wpa_cli calls, dhcpcd, ...); a 4-interface burst - connect_hotspot,
        # or several interfaces connected together from the UI - fired ~50
        # near-simultaneous subprocess spawns with nothing bounding it, and
        # was the leading suspect when a Pi went fully offline (no error
        # logged - consistent with the process/event loop stalling under the
        # load rather than raising, since our error handling only prints on
        # a caught exception) after receiving several connect_wifi commands
        # at once. 2 is a starting point, not a measured number - tune once
        # this is confirmed against real hardware (dmesg for OOM kills,
        # TasksMax vs TasksCurrent on the systemd unit during a repro).
        self._wifi_connect_semaphore = asyncio.Semaphore(2)
        # Separate from the above on purpose. disconnect_wifi's own work is
        # light (~3 subprocess spawns, normally done in a couple seconds) -
        # it never needed the same protection connect_wifi does. Sharing one
        # semaphore between them meant a disconnect could queue behind a
        # connect that was still mid-association or mid-DHCP, which can
        # legitimately run for up to ~200s (60-120s association wait + 2x40s DHCP
        # wait) - confirmed as the reason disconnects measured slower on
        # busier Pis (several interfaces mid-connect at once) than on quieter
        # ones, even though disconnect_wifi's own code path never changed.
        # 4 here is generous rather than tightly reasoned - disconnect's
        # subprocess burden is low enough that this is mostly a safety net
        # against something unbounded in the future, not a load-bearing cap
        # today.
        self._wifi_disconnect_semaphore = asyncio.Semaphore(4)

        # interface -> {"port", "gateway", "server", "timer"} for
        # start_ap_webui_proxy's HTTP reverse-proxy listener - see that
        # method for the full explanation.
        self._webui_proxies = {}
        self._webui_proxies_lock = asyncio.Lock()

        # The aiomqtt client for the current connection. Rebuilt on each
        # reconnect by run(); None while disconnected, which `publish`
        # tolerates rather than raising into a background loop.
        self.client = None
        self._client_lock = asyncio.Lock()
        # Results that failed to publish because the connection was down at
        # that exact moment - flushed on the next successful (re)connect.
        # See publish()/_flush_pending_results(). Without this, a command
        # that genuinely succeeded (a disconnect_wifi that really did tear
        # every interface down, say) could still leave the UI stuck on
        # "pending" forever: the work completing was never the problem, only
        # reporting that it completed was, and clean_session=True means the
        # broker never queued that publish for us the way it would a
        # subscription - a dropped publish is just gone unless we hold onto
        # it ourselves.
        self._pending_results = []

        # get_cached_interface_details()'s cache - see that method
        # (interfaces.py). Shared between _wifi_background_scan_loop and
        # _interface_status_loop so their independent ~5-6s timers don't
        # each pay for their own `ip link`/`ip addr` round trip within a
        # second of each other.
        self._interface_details_cache = None
        self._interface_details_cache_at = 0
        self._interface_details_cache_lock = asyncio.Lock()

        # get_link_info()'s cache - see _cache_link_info/_cached_link_info
        # (wifi.py). interface -> (cached_at, result); populated as a side
        # effect of every get_link_info call regardless of caller, read by
        # get_wifi_scan_detail's connected_bssid lookup so it doesn't have
        # to fire its own `iw dev link` when _interface_status_loop already
        # asked the same question moments ago.
        self._link_info_cache = {}

        # max_standard_capable()'s cache - see that method (wifi.py). phy
        # name -> standard. A radio's capabilities never change while it's plugged in,
        # and a replugged dongle comes back as a new phyN, so there's no
        # invalidation to do.
        self._max_standard_cache = {}

    # --- MQTT plumbing ---------------------------------------------------

    async def publish(self, topic, payload, qos=1, retain=False):
        """Publish, tolerating a disconnected client.

        Background loops publish constantly; a reconnect in progress must
        drop those rather than raise into the loop and kill it - so on
        failure this buffers rather than just dropping (see
        _pending_results / _flush_pending_results), and returns False either
        way so a caller that cares can still tell the send didn't happen
        synchronously.

        Buffering everything, not just command results, is deliberate: a
        retained status="online"/registration publish landing late is
        harmless (retained messages just overwrite the previous value), and
        treating every publish uniformly means one code path instead of the
        caller having to know which topics matter enough to retry.
        """
        client = self.client
        if client is None:
            self._buffer_pending_result(topic, payload, qos, retain)
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
            self._buffer_pending_result(topic, payload, qos, retain)
            return False

    def _buffer_pending_result(self, topic, payload, qos, retain):
        self._pending_results.append({
            "topic": topic, "payload": payload, "qos": qos, "retain": retain,
            "queued_at": asyncio.get_running_loop().time(),
        })

    async def _flush_pending_results(self):
        """Replays anything publish() couldn't send, on the next successful
        (re)connect. Age-checked here rather than on the way in, since an
        entry can sit in the buffer for the whole outage - the check needs
        to happen at flush time, against how old it actually turned out to
        be, not how old it was when queued."""
        if not self._pending_results:
            return
        pending, self._pending_results = self._pending_results, []
        now = asyncio.get_running_loop().time()
        sent = dropped = 0
        for entry in pending:
            age = now - entry["queued_at"]
            if age > PENDING_RESULT_MAX_AGE_SECONDS:
                dropped += 1
                continue
            if await self.publish(entry["topic"], entry["payload"], entry["qos"], entry["retain"]):
                sent += 1
            # else: publish() already re-buffered it (still disconnected,
            # or dropped again) - nothing further to do here.
        if sent or dropped:
            print(f"[pi_agent] reconnect: replayed {sent} pending result(s)"
                  f"{f', dropped {dropped} too stale to replay' if dropped else ''}")

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

        # One line per incoming command, password redacted - the connect/
        # disconnect/mode-switch actions below log their own start/end
        # around the dispatched task (see _run_dispatched_command), so this
        # also covers every other action (syslog, ping, tcpdump, etc.) that
        # handle_command runs inline and previously logged nothing at all.
        safe_payload = {k: ("***" if k == "password" else v) for k, v in payload.items()}
        print(f"[pi_agent] command received: {action} {safe_payload}")
        started_at = time.monotonic()

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
                    payload.get("bssid"), payload.get("channel"), payload.get("max_standard"),
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
                    payload.get("max_standard"),
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
                result = await self.start_ap_webui_proxy(payload.get("interface"), payload.get("target_port"))
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

        elapsed_ms = int((time.monotonic() - started_at) * 1000)
        error = result.get("error") if isinstance(result, dict) else None
        print(f"[pi_agent] command done ({elapsed_ms}ms): {action}"
              + (f" -> error: {error}" if error else " -> ok"))

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
        await self._flush_pending_results()
        await self.start_background_loops()

    async def start_background_loops(self):
        if not any(t.get_name() == "wifi-scan-loop" for t in self._background_tasks):
            self._spawn(self._wifi_background_scan_loop(), "wifi-scan-loop")
        if not any(t.get_name() == "interface-status-loop" for t in self._background_tasks):
            self._spawn(self._interface_status_loop(), "interface-status-loop")

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
                    # Default is 10s (aiomqtt.Client's `timeout`), which this
                    # Pi's own CPU contention (wifi scans/connects across 4
                    # radios, plus this box doubling as an interactive
                    # desktop) can occasionally outrun even though the
                    # broker acks in milliseconds - see the "Operation timed
                    # out" publish failures that motivated this. Kept below
                    # `keepalive` so a genuinely dead connection still gets
                    # caught before this would.
                    timeout=20,
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
