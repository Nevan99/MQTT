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


class TestCaseStepExpected(BaseModel):
    # field is a dot-path into the step's command result (e.g.
    # "connected" or "output"); None compares the whole result. See
    # routers/TestCases._evaluate_expected for the op implementations.
    field: Optional[str] = None
    op: str = "eq"          # eq|ne|gt|gte|lt|lte|contains|exists
    value: Any = None


class TestCaseStep(BaseModel):
    action: str
    target: str = "all"                  # "all" | "multicast" | a pi_id
    target_pi_ids: list[str] = []        # used when target == "multicast"
    params: dict[str, Any] = {}
    delay_before_seconds: float = 0
    repeat_count: int = 1
    expected: Optional[TestCaseStepExpected] = None


class TestCaseRequest(BaseModel):
    name: str
    description: str = ""
    tags: list[str] = []
    author: str = ""
    status: str = "draft"
    stop_on_failure: bool = True
    repeat_count: int = 1
    steps: list[TestCaseStep] = []


class TestCaseOut(TestCaseRequest):
    id: int
    created_at: datetime
    updated_at: datetime


class TestRunOut(BaseModel):
    id: int
    testcase_id: int
    testcase_name: str
    stop_on_failure: bool
    repeat_count: int
    steps: list[dict] = []
    status: str
    results: list[dict] = []
    started_at: datetime
    completed_at: Optional[datetime] = None


class TestSuiteRequest(BaseModel):
    name: str
    description: str = ""
    tags: list[str] = []
    author: str = ""
    stop_on_failure: bool = True
    testcase_ids: list[int] = []          # ordered; a testcase may appear in any number of suites


class TestSuiteOut(TestSuiteRequest):
    id: int
    created_at: datetime
    updated_at: datetime


class TestSuiteRunOut(BaseModel):
    id: int
    testsuite_id: int
    testsuite_name: str
    stop_on_failure: bool
    testcase_ids: list[int] = []
    status: str
    results: list[dict] = []
    started_at: datetime
    completed_at: Optional[datetime] = None