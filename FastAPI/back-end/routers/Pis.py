from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from database.database import get_session
from database.models import Pi
from schemas.schemas import PiOut

router = APIRouter(prefix="/pis", tags=["pis"])


@router.get("", response_model=list[PiOut])
def list_pis(session: Session = Depends(get_session)):
    pis = session.exec(select(Pi)).all()
    return [
        PiOut(
            pi_id=p.pi_id, ip_address=p.ip_address, role=p.role,
            status=p.status, last_seen=p.last_seen, metadata=p.metadata_dict,
        )
        for p in pis
    ]


@router.get("/{pi_id}", response_model=PiOut)
def get_pi(pi_id: str, session: Session = Depends(get_session)):
    pi = session.get(Pi, pi_id)
    if pi is None:
        raise HTTPException(status_code=404, detail="Pi not found")
    return PiOut(
        pi_id=pi.pi_id, ip_address=pi.ip_address, role=pi.role,
        status=pi.status, last_seen=pi.last_seen, metadata=pi.metadata_dict,
    )


@router.delete("/{pi_id}")
def delete_pi(pi_id: str, session: Session = Depends(get_session)):
    pi = session.get(Pi, pi_id)
    if pi is None:
        raise HTTPException(status_code=404, detail="Pi not found")
    session.delete(pi)
    session.commit()
    return {"deleted": pi_id}