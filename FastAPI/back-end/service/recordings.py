"""Recordings that are in progress, kept on the backend so they don't depend
on a browser tab staying open: a page reload just asks list_active() and
reattaches its buttons.

- Log recordings (one per Pi): every line of that Pi's stream_syslog
  connection is appended to the capture file as it arrives (see
  capture_socket_server._handle_stream_syslog). The Capture row is created
  on stop. The file grows on disk while recording, so a backend restart only
  loses the in-memory entry, not the lines.
- pcap recordings (one per Pi+interface) already stream to the backend
  (capture_socket_server._handle_record). They are only registered here so a
  reloaded page can find out which ones are running.

All state is in memory, guarded by one lock, because socket handlers run on
their own threads.
"""
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from database.database import get_session_direct
from database.models import Capture

CAPTURES_DIR = Path(__file__).resolve().parent.parent / "captures_data"
CAPTURES_DIR.mkdir(exist_ok=True)

_lock = threading.Lock()
_log_recordings: dict[str, dict] = {}
_pcap_recordings: dict[tuple[str, str], dict] = {}


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def start_log(pi_id: str, name: str) -> dict:
    with _lock:
        if pi_id in _log_recordings:
            raise ValueError("a log recording is already running for this Pi")
        filename = f"{uuid.uuid4().hex}.txt"
        rec = {
            "name": name, "started_at": _now(), "filename": filename,
            "fh": (CAPTURES_DIR / filename).open("w", encoding="utf-8"),
            "line_count": 0,
        }
        _log_recordings[pi_id] = rec
        return _public("logs", pi_id, None, rec)


def append_log_line(pi_id: str, line: str):
    with _lock:
        rec = _log_recordings.get(pi_id)
        if rec is None:
            return
        rec["fh"].write(line + "\n")
        rec["fh"].flush()
        rec["line_count"] += 1


def stop_log(pi_id: str) -> Capture | None:
    """Close the file and save it as a Capture. Returns None if nothing was
    recording; if no lines arrived, the empty file is dropped and no Capture
    is saved (raises ValueError)."""
    with _lock:
        rec = _log_recordings.pop(pi_id, None)
    if rec is None:
        return None
    rec["fh"].close()
    if rec["line_count"] == 0:
        (CAPTURES_DIR / rec["filename"]).unlink(missing_ok=True)
        raise ValueError("no log lines arrived during the recording")
    with get_session_direct() as session:
        capture = Capture(
            pi_id=pi_id, category="logs", name=rec["name"], filename=rec["filename"],
            line_count=rec["line_count"], started_at=rec["started_at"], stopped_at=_now(),
        )
        session.add(capture)
        session.commit()
        session.refresh(capture)
        return capture


def register_pcap(pi_id: str, interface: str, name: str, started_at: datetime):
    with _lock:
        _pcap_recordings[(pi_id, interface)] = {"name": name, "started_at": started_at}


def unregister_pcap(pi_id: str, interface: str):
    with _lock:
        _pcap_recordings.pop((pi_id, interface), None)


def _public(category, pi_id, interface, rec):
    return {
        "category": category, "pi_id": pi_id, "interface": interface,
        "name": rec["name"], "started_at": rec["started_at"],
        "line_count": rec.get("line_count"),
    }


def list_active(pi_id: str | None = None) -> list[dict]:
    with _lock:
        out = [_public("logs", p, None, r) for p, r in _log_recordings.items()]
        out += [_public("pcap", p, i, r) for (p, i), r in _pcap_recordings.items()]
    return [r for r in out if pi_id is None or r["pi_id"] == pi_id]
