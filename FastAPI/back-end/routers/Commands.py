import json
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from database.database import get_session
from database.models import Command, Pi
from schemas.schemas import CommandRequest, CommandOut
from service.mqtt_service import mqtt_service
from service.auth import get_current_user

router = APIRouter(tags=["commands"], dependencies=[Depends(get_current_user)])


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


@router.get("/commands", response_model=list[CommandOut])
def list_commands(limit: int = 50, session: Session = Depends(get_session)):
    """Most recent commands across the fleet, newest first, so a page reload
    can repopulate the command-result feed instead of starting empty."""
    commands = session.exec(
        select(Command).order_by(Command.created_at.desc()).limit(limit)
    ).all()
    return [
        CommandOut(
            command_id=c.command_id, pi_id=c.pi_id, action=c.action,
            status=c.status,
            result=json.loads(c.result_json) if c.result_json else None,
            created_at=c.created_at, completed_at=c.completed_at,
        )
        for c in commands
    ]


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


@router.delete("/commands/{command_id}")
def delete_command(command_id: str, session: Session = Depends(get_session)):
    command = session.get(Command, command_id)
    if command is None:
        raise HTTPException(status_code=404, detail="Command not found")
    session.delete(command)
    session.commit()
    return {"deleted": command_id}