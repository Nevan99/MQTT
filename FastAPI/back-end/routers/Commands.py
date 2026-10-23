import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlmodel import Session, func, or_, select

from database.database import get_session
from database.models import Command, Pi
from schemas.schemas import CommandRequest, CommandOut
from service.mqtt_service import mqtt_service, TRANSIENT_ACTIONS
from service.auth import get_current_user

router = APIRouter(tags=["commands"], dependencies=[Depends(get_current_user)])


# Never written to command history (the Pi still gets them).
SECRET_PARAMS = {"eap_password", "private_key_pem", "private_key_passwd"}


def _stored_params(params: dict) -> str:
    return json.dumps({k: ("***" if k in SECRET_PARAMS and v else v) for k, v in params.items()})


def _dispatch(pi_id: str, req: CommandRequest, session: Session) -> CommandOut:
    command_id = str(uuid.uuid4())

    # A connect_wifi/set_monitor_channel call that doesn't pin its own
    # channel/band falls back to that interface's stored default (see
    # Pis.set_interface_default) - lets an interface be pinned to a
    # band/channel once instead of retyping it every time, from any of the
    # several UI paths that can trigger these (Action panel, fleet scan
    # card, detail page, per-interface card's own Save).
    if req.action in ("connect_wifi", "set_monitor_channel") and pi_id != "all":
        interface = req.params.get("interface")
        pi = session.get(Pi, pi_id)
        defaults = pi.interface_defaults.get(interface) if pi and interface else None
        if defaults:
            if "channel" not in req.params and defaults.get("channel"):
                req.params["channel"] = defaults["channel"]
            if "band" not in req.params and defaults.get("band"):
                req.params["band"] = defaults["band"]

    # link_info (and any other TRANSIENT_ACTIONS) is polled far too often -
    # by wifi status icons, connected marks, interface cards, wifi scans -
    # to persist as a Command row; it's tracked in memory only, still
    # correlated by command_id the same way, but never written to the DB
    # or shown in command history.
    if req.action in TRANSIENT_ACTIONS:
        entry = mqtt_service.register_transient_command(command_id, pi_id, req.action)
        mqtt_service.publish_command(pi_id, command_id, req.action, req.params)
        return CommandOut(
            command_id=command_id, pi_id=pi_id, action=req.action,
            status=entry["status"], result=None,
            created_at=entry["created_at"], completed_at=None,
        )

    command = Command(
        command_id=command_id,
        pi_id=pi_id,
        action=req.action,
        params_json=_stored_params(req.params),
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


def _filtered_commands(query, pi_id: str | None, action: str | None,
                       status: str | None, q: str | None):
    if pi_id:
        query = query.where(Command.pi_id == pi_id)
    if action:
        query = query.where(Command.action == action)
    if status:
        query = query.where(Command.status == status)
    if q:
        like = f"%{q}%"
        query = query.where(or_(Command.pi_id.ilike(like), Command.action.ilike(like),
                                Command.result_json.ilike(like)))
    return query


@router.get("/commands", response_model=list[CommandOut])
def list_commands(response: Response, limit: int = 50, offset: int = 0,
                  pi_id: str | None = None, action: str | None = None,
                  status: str | None = None, q: str | None = None,
                  session: Session = Depends(get_session)):
    """Commands across the fleet, newest first, one page at a time
    (limit/offset), optionally filtered; X-Total-Count is the number that
    match the filters, so the History tab can page through all of them.
    q searches the Pi id, action and result text."""
    total = session.exec(_filtered_commands(
        select(func.count()).select_from(Command), pi_id, action, status, q)).one()
    response.headers["X-Total-Count"] = str(total)
    commands = session.exec(
        _filtered_commands(select(Command), pi_id, action, status, q)
        .order_by(Command.created_at.desc()).offset(max(offset, 0)).limit(limit)
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


@router.delete("/commands")
def delete_commands(pi_id: str | None = None, action: str | None = None,
                    status: str | None = None, q: str | None = None,
                    session: Session = Depends(get_session)):
    """Delete every stored command matching the same filters as the list
    (none = the whole history). Pending commands are kept: a running
    testcase is still waiting on their result row."""
    match = _filtered_commands(select(Command), pi_id, action, status, q)
    commands = session.exec(match.where(Command.status != "pending")).all()
    skipped = session.exec(_filtered_commands(
        select(func.count()).select_from(Command), pi_id, action, status, q)
        .where(Command.status == "pending")).one()
    for command in commands:
        session.delete(command)
    session.commit()
    return {"deleted": len(commands), "skipped_pending": skipped}


@router.get("/commands/stats")
def command_stats(session: Session = Depends(get_session)):
    """Totals for the History tab's summary and filter options, over every
    stored command (not just the page shown)."""
    by_status = dict(session.exec(
        select(Command.status, func.count()).group_by(Command.status)).all())
    return {
        "total": sum(by_status.values()),
        "by_status": by_status,
        "pis": sorted(session.exec(select(Command.pi_id).distinct()).all()),
        "actions": sorted(session.exec(select(Command.action).distinct()).all()),
    }


@router.get("/commands/{command_id}", response_model=CommandOut)
def get_command(command_id: str, session: Session = Depends(get_session)):
    transient = mqtt_service.get_transient_command(command_id)
    if transient is not None:
        return CommandOut(**transient)
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
        if mqtt_service.pop_transient_command(command_id):
            return {"deleted": command_id}
        raise HTTPException(status_code=404, detail="Command not found")
    session.delete(command)
    session.commit()
    return {"deleted": command_id}