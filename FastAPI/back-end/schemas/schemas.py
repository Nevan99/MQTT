from datetime import datetime
from typing import Optional, Any, Union

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
    started_at: Optional[datetime] = None
    stopped_at: Optional[datetime] = None


class LogRecordingStart(BaseModel):
    pi_id: str
    name: str


class CaptureOut(BaseModel):
    id: int
    pi_id: str
    category: str
    name: str
    created_at: datetime
    line_count: int
    started_at: Optional[datetime] = None
    stopped_at: Optional[datetime] = None


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
    # Loop membership. A contiguous run of steps sharing loop_group repeats
    # together loop_count times (taken from the group's first step) - see
    # routers/TestCases._expand_step_plan. Carried on the step rather than as
    # a separate range list on the testcase so it stays inside steps_json and
    # needs no new column. repeat_count above is still the *single* step's own
    # repeat, and applies within each loop pass.
    loop_group: Optional[str] = None
    loop_count: int = 1
    # A list: the step editor offers one checkable row per known result field
    # of the chosen action, so asserting on several at once (connected AND
    # ip_address AND signal_dbm) is the normal case rather than needing a
    # step each. The bare-object form is still accepted so testcases saved
    # before that existed keep loading and running - see
    # routers/TestCases._normalise_expectations. All checks must pass for the
    # step to pass.
    expected: Optional[Union[TestCaseStepExpected, list[TestCaseStepExpected]]] = None


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


class TestCaseBulkRequest(BaseModel):
    """Ids selected in the Testcases table's checkbox column, for the bulk
    toolbar's Run/Duplicate/Delete actions."""
    ids: list[int] = []


class TestCaseBulkEditStepsRequest(TestCaseBulkRequest):
    """Mass step edit - see service/step_bulk_edit.py for filter/ops.
    all_testcases ignores ids. dry_run only previews. exclude lists
    "<testcase_id>:<step_index>" changes unticked in the preview."""
    all_testcases: bool = False
    filter: dict[str, Any] = {}
    ops: list[dict[str, Any]] = []
    exclude: list[str] = []
    dry_run: bool = True


class TestCaseBulkTagRequest(TestCaseBulkRequest):
    """Bulk tag edit. `mode` decides what happens to each testcase's existing
    tags: "add" merges (the common case - tagging a batch without disturbing
    what they already carry), "remove" subtracts, "set" replaces outright."""
    tags: list[str] = []
    mode: str = "add"


class TestRunOut(BaseModel):
    id: int
    testcase_id: int
    testcase_name: str
    stop_on_failure: bool
    repeat_count: int
    steps: list[dict] = []
    status: str
    results: list[dict] = []
    suite_run_id: Optional[int] = None
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

class ResultKey(BaseModel):
    kind: str                              # "testcase" | "testsuite"
    id: int


class ResultFlagsRequest(BaseModel):
    """PATCH /results/{kind}/{id} - only the flags given are changed."""
    starred: Optional[bool] = None
    archived: Optional[bool] = None
    locked: Optional[bool] = None


class ResultBulkRequest(BaseModel):
    """POST /results/bulk - the Results tab toolbar's actions over its
    checked rows: star | unstar | archive | unarchive | lock | unlock | delete."""
    items: list[ResultKey] = []
    action: str
