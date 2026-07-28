import json
from datetime import datetime, timezone
from typing import Optional

from sqlmodel import SQLModel, Field


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Pi(SQLModel, table=True):
    pi_id: str = Field(primary_key=True)
    ip_address: str = ""
    role: str = "unassigned"
    topics_json: str = "[]"          # JSON-encoded list of extra topics, if any
    status: str = "offline"          # "online" | "offline"
    last_seen: datetime = Field(default_factory=utcnow)
    metadata_json: str = "{}"         # role-specific config, e.g. {"target_ssid": "..."}

    @property
    def topics(self) -> list:
        return json.loads(self.topics_json)

    @property
    def metadata_dict(self) -> dict:
        return json.loads(self.metadata_json)


class LogEntry(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    pi_id: str
    category: str          # "syslog" | "netlog" | "result" | "status" | "registration"
    payload_json: str
    timestamp: datetime = Field(default_factory=utcnow)


class Capture(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    pi_id: str
    category: str          # "logs" | "tcpdump"
    name: str
    filename: str           # name of the file under CAPTURES_DIR holding the lines
    line_count: int = 0
    created_at: datetime = Field(default_factory=utcnow)


class Command(SQLModel, table=True):
    command_id: str = Field(primary_key=True)   # uuid, echoed back by the Pi
    pi_id: str                                    # or "all" for broadcast
    action: str
    params_json: str = "{}"
    status: str = "pending"                        # pending | complete | failed | timeout
    result_json: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    completed_at: Optional[datetime] = None