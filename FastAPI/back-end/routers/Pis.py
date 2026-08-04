import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from database.database import get_session
from database.models import Pi, LogEntry
from schemas.schemas import PiOut, LogEntryOut, PrimaryInterfaceRequest
from service.auth import get_current_user

router = APIRouter(prefix="/pis", tags=["pis"], dependencies=[Depends(get_current_user)])


def _to_out(p: Pi) -> PiOut:
    return PiOut(
        pi_id=p.pi_id, ip_address=p.ip_address, role=p.role,
        status=p.status, last_seen=p.last_seen, metadata=p.metadata_dict,
        primary_interface=p.primary_interface,
    )


@router.get("", response_model=list[PiOut])
def list_pis(session: Session = Depends(get_session)):
    pis = session.exec(select(Pi)).all()
    return [_to_out(p) for p in pis]


@router.get("/{pi_id}", response_model=PiOut)
def get_pi(pi_id: str, session: Session = Depends(get_session)):
    pi = session.get(Pi, pi_id)
    if pi is None:
        raise HTTPException(status_code=404, detail="Pi not found")
    return _to_out(pi)


@router.patch("/{pi_id}/primary-interface", response_model=PiOut)
def set_primary_interface(pi_id: str, req: PrimaryInterfaceRequest, session: Session = Depends(get_session)):
    pi = session.get(Pi, pi_id)
    if pi is None:
        raise HTTPException(status_code=404, detail="Pi not found")
    if req.primary_interface and req.primary_interface not in pi.metadata_dict.get("interfaces", []):
        raise HTTPException(status_code=400, detail="Not one of this Pi's known interfaces")
    pi.primary_interface = req.primary_interface
    session.add(pi)
    session.commit()
    session.refresh(pi)
    return _to_out(pi)


@router.get("/{pi_id}/logs", response_model=list[LogEntryOut])
def get_pi_logs(
    pi_id: str, category: str, since: Optional[datetime] = None,
    limit: int = 200, session: Session = Depends(get_session),
):
    """Persisted log entries for a Pi, oldest first.

    Without `since`: the most recent `limit` entries, used to repopulate a
    panel after a page reload. With `since`: every entry from that point
    onward (up to `limit`), used to pull a capture window - this reads from
    the DB rather than the live WebSocket feed, so it can't miss messages
    that arrived while the panel was collapsed or the tab was closed.
    """
    query = select(LogEntry).where(LogEntry.pi_id == pi_id, LogEntry.category == category)
    if since is not None:
        query = query.where(LogEntry.timestamp >= since)
    entries = session.exec(query.order_by(LogEntry.timestamp.desc()).limit(limit)).all()
    entries.reverse()
    return [
        LogEntryOut(
            pi_id=e.pi_id, category=e.category,
            payload=json.loads(e.payload_json), timestamp=e.timestamp,
        )
        for e in entries
    ]


@router.delete("/{pi_id}/logs")
def clear_pi_logs(pi_id: str, category: str, session: Session = Depends(get_session)):
    """Purge persisted log entries for a Pi/category so a reload doesn't
    repopulate a panel the user just cleared."""
    entries = session.exec(
        select(LogEntry).where(LogEntry.pi_id == pi_id, LogEntry.category == category)
    ).all()
    for e in entries:
        session.delete(e)
    session.commit()
    return {"deleted": len(entries)}


@router.delete("/{pi_id}")
def delete_pi(pi_id: str, session: Session = Depends(get_session)):
    pi = session.get(Pi, pi_id)
    if pi is None:
        raise HTTPException(status_code=404, detail="Pi not found")
    session.delete(pi)
    session.commit()
    return {"deleted": pi_id}