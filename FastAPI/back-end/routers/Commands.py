import json
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from database.database import get_session
from database.models import Command, Pi
from schemas.schemas import CommandRequest, CommandOut
from service.mqtt_service import mqtt_service

router = APIRouter(tags=["commands"])


def _dispatch(pi_id: str, req: CommandRequest, session: Session) -> CommandOut:
    command_id = str(uuid.uuid4())
    command = Command(
        command_id=command_id,
        pi_id=pi_id,
        action=req.action,
        params_json=json.dumps(req.params),
    )
    session.add(command)
    session.commit()

    mqtt_service.publish_command(pi_id, command_id, req.action, req.params)

    return CommandOut(
        command_id=command_id, pi_id=pi_id, action=req.action,
        status=command.status, result=None,
        created_at=command.created_at, completed_at=None,
    )


@router.post("/pis/{pi_id}/cmd", response_model=CommandOut)
def send_command(pi_id: str, req: CommandRequest, session: Session = Depends(get_session)):
    if pi_id != "all":
        pi = session.get(Pi, pi_id)
        if pi is None:
            raise HTTPException(status_code=404, detail="Pi not found")
    return _dispatch(pi_id, req, session)


@router.post("/pis/broadcast", response_model=CommandOut)
def broadcast_command(req: CommandRequest, session: Session = Depends(get_session)):
    return _dispatch("all", req, session)


@router.get("/commands/{command_id}", response_model=CommandOut)
def get_command(command_id: str, session: Session = Depends(get_session)):
    command = session.get(Command, command_id)
    if command is None:
        raise HTTPException(status_code=404, detail="Command not found")
    return CommandOut(
        command_id=command.command_id, pi_id=command.pi_id, action=command.action,
        status=command.status,
        result=json.loads(command.result_json) if command.result_json else None,
        created_at=command.created_at, completed_at=command.completed_at,
    )