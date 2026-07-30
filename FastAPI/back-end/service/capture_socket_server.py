import json
import os
import socketserver
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from database.database import get_session_direct
from database.models import Capture

CAPTURES_DIR = Path(__file__).resolve().parent.parent / "captures_data"
CAPTURES_DIR.mkdir(exist_ok=True)

HOST = "0.0.0.0"
PORT = int(os.environ.get("CAPTURE_SOCKET_PORT", 9200))


class _CaptureHandler(socketserver.StreamRequestHandler):
    """One connection = one pcap capture, opened by the Pi as soon as
    start_pcap_capture fires and kept open for the whole capture, so bytes
    land on disk as tcpdump produces them instead of all at once when the
    capture stops. First line in is a JSON header identifying the capture;
    everything after that, until the Pi shuts down its write side, is raw
    pcap bytes written straight to the capture file. A JSON ack (with the
    saved capture's id) is sent back once the stream ends."""

    def handle(self):
        try:
            header_line = self.rfile.readline()
            if not header_line:
                return
            header = json.loads(header_line.decode())
            pi_id = header["pi_id"]
            name = header.get("name") or f"{pi_id}-pcap-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}"

            filename = f"{uuid.uuid4().hex}.pcap"
            dest = CAPTURES_DIR / filename

            byte_count = 0
            with dest.open("wb") as f:
                while True:
                    chunk = self.rfile.read(65536)
                    if not chunk:
                        break
                    byte_count += len(chunk)
                    f.write(chunk)

            with get_session_direct() as session:
                capture = Capture(pi_id=pi_id, category="pcap", name=name, filename=filename, line_count=0)
                session.add(capture)
                session.commit()
                session.refresh(capture)
                capture_id = capture.id

            self._send({"capture_id": capture_id, "byte_count": byte_count, "saved": True})
        except Exception as e:
            self._send({"error": str(e)})

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


def start():
    global _server, _thread
    _server = _CaptureSocketServer((HOST, PORT), _CaptureHandler)
    _thread = threading.Thread(target=_server.serve_forever, daemon=True)
    _thread.start()
    print(f"[capture-socket] listening on {HOST}:{PORT}")


def stop():
    if _server is not None:
        _server.shutdown()
        _server.server_close()
