from datetime import datetime
from typing import Optional, Any

from pydantic import BaseModel


class PiOut(BaseModel):
    pi_id: str
    ip_address: str
    role: str
    status: str
    last_seen: datetime
    metadata: dict = {}
    primary_interfaces: list[str] = []
    interface_defaults: dict = {}


class PrimaryInterfaceRequest(BaseModel):
    primary_interfaces: list[str] = []


class InterfaceDefaultRequest(BaseModel):
    # band is nmcli's own value ("bg" for 2.4GHz, "a" for 5GHz) so it can be
    # passed straight through to connect_wifi with no translation - the
    # front end maps its "2.4GHz"/"5GHz" labels to these before sending.
    band: Optional[str] = None
    channel: Optional[int] = None


class CommandRequest(BaseModel):
    action: str
    params: dict[str, Any] = {}


class CommandOut(BaseModel):
    command_id: str
    pi_id: str
    action: str
    status: str
    result: Optional[dict] = None
    created_at: datetime
    completed_at: Optional[datetime] = None


class LogEntryOut(BaseModel):
    pi_id: str
    category: str
    payload: Any
    timestamp: datetime


class CaptureRequest(BaseModel):
    pi_id: str
    category: str
    name: str
    lines: list[Any] = []


class CaptureOut(BaseModel):
    id: int
    pi_id: str
    category: str
    name: str
    created_at: datetime
    line_count: int