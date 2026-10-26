import asyncio
import json
import os
import socketserver
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from database.database import get_session_direct
from database.models import Capture
from service import recordings, run_logs
from service.pcap_decoder import PcapStreamDecoder
from src.connection_manager import manager

CAPTURES_DIR = Path(__file__).resolve().parent.parent / "captures_data"
CAPTURES_DIR.mkdir(exist_ok=True)

HOST = "0.0.0.0"
PORT = int(os.environ.get("CAPTURE_SOCKET_PORT", 9200))

# Set by start() - lets this module's background threads (each connection
# handler runs on its own thread, off the asyncio loop) schedule the
# WebSocket broadcast coroutine onto the main loop, same pattern
# mqtt_service uses for its own MQTT-thread callback.
_loop: asyncio.AbstractEventLoop | None = None


def _relay(pi_id, category, payload):
    if _loop is None:
        return
    asyncio.run_coroutine_threadsafe(
        manager.broadcast({"pi_id": pi_id, "category": category, "payload": payload}),
        _loop,
    )


class _CaptureHandler(socketserver.StreamRequestHandler):
    """One connection = one Pi-initiated stream, opened as soon as the
    corresponding action fires on the agent and kept open for its whole
    duration. First line in is a JSON header; its "kind" selects which of
    three independent things this connection is for - a saved recording,
    or one of two view-only live decodes. All three can run concurrently
    (even on the same interface), since each is its own tcpdump/journalctl
    process and its own socket connection on the agent side."""

    def handle(self):
        try:
            header_line = self.rfile.readline()
            if not header_line:
                return
            header = json.loads(header_line.decode())
            kind = header.get("kind", "record")
            if kind == "record":
                self._handle_record(header)
            elif kind == "stream_tcpdump":
                self._handle_stream_tcpdump(header)
            elif kind == "stream_syslog":
                self._handle_stream_syslog(header)
        except Exception as e:
            self._send({"error": str(e)})

    def _handle_record(self, header):
        """start_pcap_capture's connection: raw pcap bytes written straight
        to a capture file, saved as a Capture row once the stream ends - no
        live decoding here, that's stream_tcpdump's job on its own
        connection. A JSON ack (with the saved capture's id) is sent back
        once the stream ends."""
        pi_id = header["pi_id"]
        name = header.get("name") or f"{pi_id}-pcap-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}"

        filename = f"{uuid.uuid4().hex}.pcap"
        dest = CAPTURES_DIR / filename
        started_at = datetime.now(timezone.utc).replace(tzinfo=None)
        interface = header.get("interface") or ""
        recordings.register_pcap(pi_id, interface, name, started_at)

        byte_count = 0
        try:
            with dest.open("wb") as f:
                while True:
                    chunk = self.rfile.read(65536)
                    if not chunk:
                        break
                    byte_count += len(chunk)
                    f.write(chunk)
        finally:
            recordings.unregister_pcap(pi_id, interface)

        with get_session_direct() as session:
            capture = Capture(
                pi_id=pi_id, category="pcap", name=name, filename=filename, line_count=0,
                started_at=started_at, stopped_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
            session.add(capture)
            session.commit()
            session.refresh(capture)
            capture_id = capture.id

        self._send({"capture_id": capture_id, "byte_count": byte_count, "saved": True})

    def _handle_stream_tcpdump(self, header):
        """start_tcpdump_stream's connection (view only, nothing saved):
        raw pcap bytes decoded to structured packet records as they arrive
        and relayed live over the WebSocket as category "tcpdump" - same
        category name the old MQTT-based stream used, only the transport
        and the payload shape (structured fields instead of one text line,
        for a Wireshark-style packet list on the frontend) changed."""
        pi_id = header["pi_id"]
        interface = header.get("interface")
        decoder = PcapStreamDecoder()
        while True:
            # self.rfile is a buffered io.BufferedReader - .read(n) blocks
            # until n bytes actually arrive (or EOF), so on a quiet
            # interface nothing would get decoded/relayed until either the
            # buffer filled or the stream closed on stop. Reading straight
            # off the raw socket instead returns as soon as any data is
            # available, however little.
            chunk = self.connection.recv(4096)
            if not chunk:
                break
            # Batched per read-chunk (naturally several packets under any
            # real traffic) rather than one WS message per packet, so a
            # busy interface doesn't flood the browser - same reasoning as
            # the old per-line tcpdump batching over MQTT.
            decoded = decoder.feed(chunk)
            if decoded:
                # A test run sniffing this interface files them under its own
                # log too (service/run_logs.py) - the same stream serves the
                # live view and the run's packet log.
                run_logs.append_packets(pi_id, interface, decoded)
                self._relay_packets(pi_id, interface, decoded)

    def _handle_stream_syslog(self, header):
        """start_syslog_stream's connection (view only, nothing saved):
        newline-delimited text lines relayed live over the WebSocket as
        category "logs", same category name the old MQTT-based stream
        used - only the transport changed."""
        pi_id = header["pi_id"]
        for raw_line in self.rfile:
            line = raw_line.decode(errors="replace").rstrip("\n")
            if not line:
                continue
            recordings.append_log_line(pi_id, line)
            run_logs.append(pi_id, line)
            _relay(pi_id, "logs", line)

    def _relay_packets(self, pi_id, interface, decoded):
        payload = [
            {
                "timestamp": ts.isoformat(),
                "device_id": pi_id,
                "interface": interface,
                "length": orig_len,
                "protocol": rec["protocol"],
                "src": rec["src"],
                "dst": rec["dst"],
                "info": rec["info"],
            }
            for ts, orig_len, rec in decoded
        ]
        _relay(pi_id, "tcpdump", payload)

    def _send(self, payload):
        try:
            self.wfile.write((json.dumps(payload) + "\n").encode())
            self.wfile.flush()
        except OSError:
            pass


class _CaptureSocketServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


_server = None
_thread = None


def start(loop: asyncio.AbstractEventLoop):
    global _server, _thread, _loop
    _loop = loop
    _server = _CaptureSocketServer((HOST, PORT), _CaptureHandler)
    _thread = threading.Thread(target=_server.serve_forever, daemon=True)
    _thread.start()
    print(f"[capture-socket] listening on {HOST}:{PORT}")


def stop():
    if _server is not None:
        _server.shutdown()
        _server.server_close()
