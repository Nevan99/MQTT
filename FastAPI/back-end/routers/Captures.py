import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from database.database import get_session
from database.models import Capture
from routers.Commands import _dispatch
from schemas.schemas import CaptureRequest, CaptureOut, CommandRequest, LogRecordingStart
from service import recordings
from service.auth import get_current_user

router = APIRouter(prefix="/captures", tags=["captures"], dependencies=[Depends(get_current_user)])

CAPTURES_DIR = Path(__file__).resolve().parent.parent / "captures_data"
CAPTURES_DIR.mkdir(exist_ok=True)


def _line_to_text(line) -> str:
    if isinstance(line, str):
        return line
    return json.dumps(line)


def _extension(category: str) -> str:
    return ".pcap" if category == "pcap" else ".txt"


def _safe_download_name(capture: Capture) -> str:
    base = f"{capture.pi_id}_{capture.category}_{capture.name}"
    return re.sub(r'[^A-Za-z0-9_.-]+', '_', base) + _extension(capture.category)


def _to_out(capture: Capture) -> CaptureOut:
    return CaptureOut(
        id=capture.id, pi_id=capture.pi_id, category=capture.category,
        name=capture.name, created_at=capture.created_at,
        line_count=capture.line_count,
        started_at=capture.started_at, stopped_at=capture.stopped_at,
    )


def _utc(dt: datetime | None) -> datetime | None:
    """Store naive UTC, like created_at, so the frontend's parseApiDate
    (which appends Z to tz-less values) reads every column the same way."""
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc)
    return dt.replace(tzinfo=None)


def _file_contains(capture: Capture, needle: str) -> bool:
    if capture.category == "pcap":
        return False
    path = CAPTURES_DIR / capture.filename
    try:
        return needle in path.read_text(encoding="utf-8", errors="replace").lower()
    except OSError:
        return False


@router.post("", response_model=CaptureOut)
def create_capture(req: CaptureRequest, session: Session = Depends(get_session)):
    filename = f"{uuid.uuid4().hex}{_extension(req.category)}"
    text = "\n".join(_line_to_text(line) for line in req.lines)
    (CAPTURES_DIR / filename).write_text(text, encoding="utf-8")

    capture = Capture(
        pi_id=req.pi_id, category=req.category, name=req.name,
        filename=filename, line_count=len(req.lines),
        started_at=_utc(req.started_at),
        stopped_at=_utc(req.stopped_at) or _utc(datetime.now(timezone.utc)),
    )
    session.add(capture)
    session.commit()
    session.refresh(capture)
    return _to_out(capture)


@router.get("", response_model=list[CaptureOut])
def list_captures(pi_id: str | None = None, category: str | None = None,
                   contains: str | None = None,
                   session: Session = Depends(get_session)):
    """contains: case-insensitive search inside the saved log text (text
    captures only - pcap files are binary)."""
    query = select(Capture)
    if pi_id:
        query = query.where(Capture.pi_id == pi_id)
    if category:
        query = query.where(Capture.category == category)
    captures = session.exec(query.order_by(Capture.created_at.desc())).all()
    if contains:
        needle = contains.lower()
        captures = [c for c in captures if _file_contains(c, needle)]
    return [_to_out(c) for c in captures]


@router.get("/recordings")
def list_recordings(pi_id: str | None = None):
    """Recordings still in progress (logs and pcap), so a reloaded page can
    show them as recording and stop them."""
    return recordings.list_active(pi_id)


@router.post("/recordings/logs")
def start_log_recording(req: LogRecordingStart, session: Session = Depends(get_session)):
    """Start saving a Pi's syslog stream on the backend. Also asks the Pi to
    start the stream; if it's already running the Pi just says so."""
    try:
        rec = recordings.start_log(req.pi_id, req.name)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    _dispatch(req.pi_id, CommandRequest(action="stream_logs", params={}), session)
    return rec


@router.post("/recordings/logs/{pi_id}/stop", response_model=CaptureOut)
def stop_log_recording(pi_id: str):
    try:
        capture = recordings.stop_log(pi_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if capture is None:
        raise HTTPException(status_code=404, detail="No log recording running for this Pi")
    return _to_out(capture)


@router.get("/{capture_id}/download")
def download_capture(capture_id: int, session: Session = Depends(get_session)):
    capture = session.get(Capture, capture_id)
    if capture is None:
        raise HTTPException(status_code=404, detail="Capture not found")
    path = CAPTURES_DIR / capture.filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Capture file missing on disk")
    media_type = "application/vnd.tcpdump.pcap" if capture.category == "pcap" else "text/plain"
    return FileResponse(
        path, media_type=media_type, filename=_safe_download_name(capture),
    )


@router.delete("/{capture_id}")
def delete_capture(capture_id: int, session: Session = Depends(get_session)):
    capture = session.get(Capture, capture_id)
    if capture is None:
        raise HTTPException(status_code=404, detail="Capture not found")
    path = CAPTURES_DIR / capture.filename
    path.unlink(missing_ok=True)
    session.delete(capture)
    session.commit()
    return {"deleted": capture_id}