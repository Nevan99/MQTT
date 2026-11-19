import asyncio
import json
import os
from datetime import datetime, timezone

import paho.mqtt.client as mqtt
from dotenv import load_dotenv
from sqlmodel import select

from database.database import get_session_direct
from database.models import Pi, Command, WifiScanHistory, WifiScanSnapshot, InterfaceStatus
from src.connection_manager import manager

load_dotenv()

MQTT_BROKER_HOST = os.environ["MQTT_BROKER_HOST"]
MQTT_BROKER_PORT = int(os.environ["MQTT_BROKER_PORT"])

# link_info is polled constantly (wifi status icons, connected marks,
# interface detail cards, wifi scan "connected" checks - all over the fleet
# table and Pi detail page), far more often than a user-initiated action.
# Persisting every one of those as a Command row would flood the command
# history and the DB with rows nobody ever wants to see or keep - so these
# are tracked purely in memory, correlated by command_id the same way, but
# never written to the database or surfaced by GET /commands.
TRANSIENT_ACTIONS = {"link_info", "wifi_detail_scan", "interface_status"}

# How long a transient command's result stays available for polling before
# being pruned - comfortably longer than the ~1s poll interval the frontend
# uses while awaiting a result.
TRANSIENT_TTL_SECONDS = 30

# How many of the most recent wifi_detail_scan results to keep cached per
# (pi_id, interface) - GET /pis/{id}/wifi-history unions all of them
# (deduped by bssid) so one thin/empty scan cycle doesn't blank the
# "Nearby Hotspot" popup as long as an AP showed up in any of the others.
WIFI_SCAN_SNAPSHOT_CAP = 5


class MQTTService:
    def __init__(self):
        # The broker (mosquitto 1.6.9) only speaks MQTT 3.1.1 - v5 broker
        # support wasn't added until mosquitto 2.0. Connecting as v5 anyway
        # is undefined behavior against this broker; clean_session=True is
        # the unambiguous v3.1.1 way to guarantee every (re)connect starts a
        # fresh session instead of risking a stale queued message replay.
        self.client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id="backend-controller",
            protocol=mqtt.MQTTv311,
            clean_session=True,
        )
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.main_loop: asyncio.AbstractEventLoop | None = None
        self._transient_commands: dict[str, dict] = {}

    # --- lifecycle -----------------------------------------------------

    def start(self, loop: asyncio.AbstractEventLoop):
        self.main_loop = loop
        self.client.connect(MQTT_BROKER_HOST, MQTT_BROKER_PORT, keepalive=30)
        self.client.loop_start()

    def stop(self):
        self.client.loop_stop()
        self.client.disconnect()

    # --- MQTT callbacks (run on paho's network thread) ------------------

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        print(f"[mqtt] backend connected, rc={reason_code}")
        client.subscribe("devices/+/registration", qos=1)
        client.subscribe("test/+/status", qos=1)
        client.subscribe("test/+/result", qos=1)
        client.subscribe("devices/+/logs/#", qos=1)
        client.subscribe("devices/+/tcpdump/+", qos=1)

    def _on_message(self, client, userdata, msg):
        parts = msg.topic.split("/")
        if len(parts) < 3:
            return
        pi_id, category = parts[1], parts[2]

        try:
            payload = json.loads(msg.payload.decode())
        except json.JSONDecodeError:
            payload = msg.payload.decode(errors="replace")

        # DB writes happen synchronously here, on paho's thread -
        # SQLite + check_same_thread=False makes this safe for a lab-scale rig.
        with get_session_direct() as session:
            if category == "registration":
                self._upsert_pi(session, pi_id, payload)
            elif category == "status":
                self._update_status(session, pi_id, payload)
            elif category == "result":
                self._update_command_result(session, pi_id, payload)

            session.commit()

        # Relay to any connected browsers - schedule onto the asyncio loop
        # since this callback runs on paho's own thread, not the event loop.
        if self.main_loop is not None:
            asyncio.run_coroutine_threadsafe(
                manager.broadcast({"pi_id": pi_id, "category": category, "payload": payload}),
                self.main_loop,
            )

    # --- DB helpers ------------------------------------------------------

    def _upsert_pi(self, session, pi_id: str, payload: dict):
        pi = session.get(Pi, pi_id)
        if pi is None:
            pi = Pi(pi_id=pi_id)
        pi.ip_address = payload.get("ip_address", pi.ip_address)
        pi.role = payload.get("role", pi.role)
        pi.topics_json = json.dumps(payload.get("topics", []))
        pi.metadata_json = json.dumps(payload.get("metadata", {}))
        pi.status = "online"
        pi.last_seen = datetime.now(timezone.utc)
        session.add(pi)

    def _update_status(self, session, pi_id: str, payload: dict):
        pi = session.get(Pi, pi_id)
        if pi is None:
            pi = Pi(pi_id=pi_id)
        # status payload can be a plain string ("online"/"offline") or a dict
        status_value = payload if isinstance(payload, str) else payload.get("status", "unknown")
        pi.status = status_value
        pi.last_seen = datetime.now(timezone.utc)
        session.add(pi)
        if status_value != "online":
            self._mark_interfaces_down(session, pi_id)

    # InterfaceStatus fields that describe the live link - meaningless once
    # the Pi is gone (MAC, type and radio capabilities stay as they were).
    LIVE_LINK_FIELDS = (
        "ip_address", "ipv6_address", "ssid", "bssid", "frequency_mhz", "band",
        "signal_dbm", "rx_bitrate_mbps", "tx_bitrate_mbps", "gateway", "key_mgmt",
        "pairwise_cipher", "group_cipher", "wpa_state", "noise_dbm", "avg_signal_dbm",
        "link_speed_mbps", "channel_width", "wifi_generation",
        "mlo", "mld_address", "ap_mld_address", "mlo_links",
    )

    def _mark_interfaces_down(self, session, pi_id: str):
        """An offline Pi stops reporting interface status, so its last
        report would otherwise show UP/connected until it comes back (when
        its interface status loop overwrites these again)."""
        rows = session.exec(select(InterfaceStatus).where(InterfaceStatus.pi_id == pi_id)).all()
        for row in rows:
            for field in self.LIVE_LINK_FIELDS:
                setattr(row, "mlo_links_json" if field == "mlo_links" else field, None)
            row.state = "DOWN"
            if row.connected is not None:
                row.connected = False
            row.updated_at = datetime.now(timezone.utc)
            session.add(row)

    # Actions whose result reports a failed attempt as connected=false
    # rather than with an "error" key - the agent only sets "error" when the
    # command couldn't run at all (bad args, an exception), not when it ran
    # and the radio didn't associate (scan rejected, auth failure, timeout).
    _CONNECT_ACTIONS = ("connect_wifi", "connect_hotspot")

    @classmethod
    def _command_status(cls, payload: dict) -> str:
        if "error" in payload:
            return "failed"
        if payload.get("action") in cls._CONNECT_ACTIONS and payload.get("connected") is False:
            return "failed"
        return "complete"

    def _update_command_result(self, session, pi_id: str, payload: dict):
        command_id = payload.get("command_id")
        if not command_id:
            return
        if payload.get("action") == "wifi_detail_scan":
            self._update_wifi_scan_history(session, pi_id, payload)
        elif payload.get("action") == "interface_status":
            self._update_interface_status(session, pi_id, payload)
        status = self._command_status(payload)
        transient = self._transient_commands.get(command_id)
        if transient is not None:
            transient["status"] = status
            transient["result"] = payload
            transient["completed_at"] = datetime.now(timezone.utc)
            return
        command = session.get(Command, command_id)
        if command is None:
            return
        command.status = status
        command.result_json = json.dumps(payload)
        command.completed_at = datetime.now(timezone.utc)
        session.add(command)

    def _update_wifi_scan_history(self, session, pi_id: str, payload: dict):
        """Rolls each network in a wifi_detail_scan result into
        WifiScanHistory - see that model for why. Runs even for a scan
        result that ends up failing to correlate to any live command/
        transient entry (e.g. after a page reload), since the history table
        has no such timing dependency."""
        interface = payload.get("interface")
        networks = payload.get("networks")
        if not interface or not networks:
            return
        now = datetime.now(timezone.utc)
        for net in networks:
            bssid = net.get("bssid")
            if not bssid:
                continue
            row = session.exec(
                select(WifiScanHistory).where(
                    WifiScanHistory.pi_id == pi_id,
                    WifiScanHistory.interface == interface,
                    WifiScanHistory.bssid == bssid,
                )
            ).first()
            if row is None:
                row = WifiScanHistory(
                    pi_id=pi_id, interface=interface, bssid=bssid, first_seen=now,
                )
            row.ssid = net.get("ssid") or row.ssid
            row.last_seen = now
            row.detection_count += 1
            quality = net.get("signal_quality_percent")
            if quality is not None:
                row.min_signal_percent = quality if row.min_signal_percent is None else min(row.min_signal_percent, quality)
                row.max_signal_percent = quality if row.max_signal_percent is None else max(row.max_signal_percent, quality)
                row.signal_sum += quality
            session.add(row)

        session.add(WifiScanSnapshot(pi_id=pi_id, interface=interface, networks_json=json.dumps(networks), scanned_at=now))
        session.flush()
        old_ids = session.exec(
            select(WifiScanSnapshot.id)
            .where(WifiScanSnapshot.pi_id == pi_id, WifiScanSnapshot.interface == interface)
            .order_by(WifiScanSnapshot.scanned_at.desc())
            .offset(WIFI_SCAN_SNAPSHOT_CAP)
        ).all()
        if old_ids:
            for snap in session.exec(select(WifiScanSnapshot).where(WifiScanSnapshot.id.in_(old_ids))).all():
                session.delete(snap)

    def _update_interface_status(self, session, pi_id: str, payload: dict):
        """Upserts one InterfaceStatus row per (pi_id, interface) - see that
        model for why. Ignores an error result for an interface (e.g. a wifi
        lock held by an in-progress connect_wifi at the moment
        PiAgent._publish_interface_status ran) rather than overwriting a
        previously-good row with error/missing fields."""
        interface = payload.get("interface")
        if not interface or "error" in payload:
            return
        row = session.exec(
            select(InterfaceStatus).where(
                InterfaceStatus.pi_id == pi_id, InterfaceStatus.interface == interface,
            )
        ).first()
        if row is None:
            row = InterfaceStatus(pi_id=pi_id, interface=interface)
        for field in (
            "mac_address", "state", "type", "ip_address", "ipv6_address",
            "connected", "ssid", "bssid", "frequency_mhz", "band",
            "signal_dbm", "rx_bitrate_mbps", "tx_bitrate_mbps", "gateway",
            "key_mgmt", "pairwise_cipher", "group_cipher", "wpa_state",
            "address", "wifi_generation", "noise_dbm", "avg_signal_dbm",
            "link_speed_mbps", "channel_width", "radio_type", "wifi7_capable",
            "max_standard_capable",
            "mlo", "mld_address", "ap_mld_address",
        ):
            if field in payload:
                setattr(row, field, payload[field])
        if "mlo_links" in payload:
            links = payload["mlo_links"]
            row.mlo_links_json = json.dumps(links) if links is not None else None
        row.updated_at = datetime.now(timezone.utc)
        session.add(row)

    # --- transient (non-persisted) commands -----------------------------

    def register_transient_command(self, command_id: str, pi_id: str, action: str) -> dict:
        self._prune_transient_commands()
        entry = {
            "command_id": command_id, "pi_id": pi_id, "action": action,
            "status": "pending", "result": None,
            "created_at": datetime.now(timezone.utc), "completed_at": None,
        }
        self._transient_commands[command_id] = entry
        return entry

    def get_transient_command(self, command_id: str) -> dict | None:
        return self._transient_commands.get(command_id)

    def pop_transient_command(self, command_id: str) -> bool:
        return self._transient_commands.pop(command_id, None) is not None

    def _prune_transient_commands(self):
        cutoff = datetime.now(timezone.utc).timestamp() - TRANSIENT_TTL_SECONDS
        stale = [cid for cid, c in self._transient_commands.items() if c["created_at"].timestamp() < cutoff]
        for cid in stale:
            self._transient_commands.pop(cid, None)

    # --- publishing --------------------------------------------------------

    def publish_command(self, pi_id: str, command_id: str, action: str, params: dict):
        topic = f"test/{pi_id}/cmd" if pi_id != "all" else "test/all/cmd"
        message = {"command_id": command_id, "action": action, **params}
        self.client.publish(topic, json.dumps(message), qos=1)


mqtt_service = MQTTService()