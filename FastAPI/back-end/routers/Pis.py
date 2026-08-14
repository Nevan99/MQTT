import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from database.database import get_session
from database.models import Pi, LogEntry
from schemas.schemas import PiOut, LogEntryOut, PrimaryInterfaceRequest, InterfaceDefaultRequest
from service.auth import get_current_user

router = APIRouter(prefix="/pis", tags=["pis"], dependencies=[Depends(get_current_user)])


def _to_out(p: Pi) -> PiOut:
    return PiOut(
        pi_id=p.pi_id, ip_address=p.ip_address, role=p.role,
        status=p.status, last_seen=p.last_seen, metadata=p.metadata_dict,
        primary_interfaces=p.primary_interfaces,
        interface_defaults=p.interface_defaults,
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
    known = pi.metadata_dict.get("interfaces", [])
    unknown = [i for i in req.primary_interfaces if i not in known]
    if unknown:
        raise HTTPException(status_code=400, detail=f"Not one of this Pi's known interfaces: {unknown}")
    pi.primary_interfaces_json = json.dumps(req.primary_interfaces)
    session.add(pi)
    session.commit()
    session.refresh(pi)
    return _to_out(pi)


@router.put("/{pi_id}/interfaces/{interface}/default", response_model=PiOut)
def set_interface_default(
    pi_id: str, interface: str, req: InterfaceDefaultRequest, session: Session = Depends(get_session),
):
    """Sets (or, with both fields omitted, clears) the default band/channel
    for one of this Pi's interfaces - auto-applied by Commands._dispatch to
    any connect_wifi request against that interface that doesn't already
    specify its own channel/band, so a station interface can be pinned to a
    band or exact channel once instead of retyping it on every connect."""
    pi = session.get(Pi, pi_id)
    if pi is None:
        raise HTTPException(status_code=404, detail="Pi not found")
    known = pi.metadata_dict.get("interfaces", [])
    if interface not in known:
        raise HTTPException(status_code=400, detail=f"Not one of this Pi's known interfaces: {interface}")
    if req.band is not None and req.band not in ("bg", "a"):
        raise HTTPException(status_code=400, detail='band must be "bg" (2.4GHz), "a" (5GHz), or omitted')
    if req.channel is not None and req.channel <= 0:
        raise HTTPException(status_code=400, detail="channel must be a positive number")
    if req.band is not None and req.channel is not None:
        # Same convention connect_wifi/set_monitor_channel already use to
        # infer a band from a bare channel number - reject the pair up
        # front instead of silently saving a default that can never apply
        # (nmcli would just ignore/override the mismatched band).
        inferred = "bg" if req.channel <= 14 else "a"
        inferred_label = "2.4GHz" if inferred == "bg" else "5GHz"
        if req.band != inferred:
            raise HTTPException(
                status_code=400,
                detail=f"channel {req.channel} is {inferred_label}, not the selected band",
            )

    defaults = pi.interface_defaults
    if req.band is None and req.channel is None:
        defaults.pop(interface, None)
    else:
        defaults[interface] = {"band": req.band, "channel": req.channel}
    pi.interface_defaults_json = json.dumps(defaults)
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