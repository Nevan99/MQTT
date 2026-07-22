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
    payload: dict
    timestamp: datetime