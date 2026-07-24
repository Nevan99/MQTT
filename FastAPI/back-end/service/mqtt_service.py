import asyncio
import json
import os
from datetime import datetime, timezone

import paho.mqtt.client as mqtt
from dotenv import load_dotenv
from sqlmodel import select

from database.database import get_session_direct
from database.models import Pi, LogEntry, Command
from src.connection_manager import manager

load_dotenv()

MQTT_BROKER_HOST = os.environ["MQTT_BROKER_HOST"]
MQTT_BROKER_PORT = int(os.environ["MQTT_BROKER_PORT"])


class MQTTService:
    def __init__(self):
        self.client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id="backend-controller",
            protocol=mqtt.MQTTv5,
        )
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.main_loop: asyncio.AbstractEventLoop | None = None

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

            session.add(LogEntry(pi_id=pi_id, category=category, payload_json=json.dumps(payload)))
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

    def _update_command_result(self, session, pi_id: str, payload: dict):
        command_id = payload.get("command_id")
        if not command_id:
            return
        command = session.get(Command, command_id)
        if command is None:
            return
        command.status = "failed" if "error" in payload else "complete"
        command.result_json = json.dumps(payload)
        command.completed_at = datetime.now(timezone.utc)
        session.add(command)

    # --- publishing --------------------------------------------------------

    def publish_command(self, pi_id: str, command_id: str, action: str, params: dict):
        topic = f"test/{pi_id}/cmd" if pi_id != "all" else "test/all/cmd"
        message = {"command_id": command_id, "action": action, **params}
        self.client.publish(topic, json.dumps(message), qos=1)


mqtt_service = MQTTService()