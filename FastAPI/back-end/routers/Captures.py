import re
import uuid
from pathlib import Path
import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from database.database import get_session
from database.models import Capture
from schemas.schemas import CaptureRequest, CaptureOut
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
    )


@router.post("", response_model=CaptureOut)
def create_capture(req: CaptureRequest, session: Session = Depends(get_session)):
    filename = f"{uuid.uuid4().hex}{_extension(req.category)}"
    text = "\n".join(_line_to_text(line) for line in req.lines)
    (CAPTURES_DIR / filename).write_text(text, encoding="utf-8")

    capture = Capture(
        pi_id=req.pi_id, category=req.category, name=req.name,
        filename=filename, line_count=len(req.lines),
    )
    session.add(capture)
    session.commit()
    session.refresh(capture)
    return _to_out(capture)


@router.get("", response_model=list[CaptureOut])
def list_captures(pi_id: str | None = None, category: str | None = None,
                   session: Session = Depends(get_session)):
    query = select(Capture)
    if pi_id:
        query = query.where(Capture.pi_id == pi_id)
    if category:
        query = query.where(Capture.category == category)
    captures = session.exec(query.order_by(Capture.created_at.desc())).all()
    return [_to_out(c) for c in captures]


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