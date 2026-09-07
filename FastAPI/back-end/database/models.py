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
    primary_interfaces_json: str = "[]"  # interfaces this Pi targets when included in a multicast command
    interface_defaults_json: str = "{}"  # interface name -> {"band": "bg"|"a"|None, "channel": int|None},
                                          # auto-applied to connect_wifi calls against that interface when
                                          # the request itself doesn't specify a channel/band

    @property
    def topics(self) -> list:
        return json.loads(self.topics_json)

    @property
    def metadata_dict(self) -> dict:
        return json.loads(self.metadata_json)

    @property
    def primary_interfaces(self) -> list:
        return json.loads(self.primary_interfaces_json)

    @property
    def interface_defaults(self) -> dict:
        return json.loads(self.interface_defaults_json)


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


class WifiScanHistory(SQLModel, table=True):
    # Rollup only (first/last seen, detection count, min/max/avg signal) -
    # the live per-AP fields (phy type, security, etc.) come from
    # WifiScanSnapshot below, not from a "last result" column here anymore;
    # a single stale/latest snapshot per BSSID was exactly what made one
    # empty/partial scan cycle blank the "Nearby Hotspot" popup.
    id: Optional[int] = Field(default=None, primary_key=True)
    pi_id: str
    interface: str
    bssid: str
    ssid: str = ""
    first_seen: datetime = Field(default_factory=utcnow)
    last_seen: datetime = Field(default_factory=utcnow)
    detection_count: int = 0
    min_signal_percent: Optional[int] = None
    max_signal_percent: Optional[int] = None
    signal_sum: int = 0   # avg_signal_percent = signal_sum / detection_count


class WifiScanSnapshot(SQLModel, table=True):
    """Rolling cache of the WIFI_SCAN_SNAPSHOT_CAP most recent full
    wifi_detail_scan results per (Pi, interface) - see
    mqtt_service._update_wifi_scan_history, which inserts one of these per
    scan and prunes anything beyond the newest cap. GET /pis/{id}/wifi-history
    (routers/Pis.py) unions all of them (deduped by bssid, most recent
    occurrence wins) to build the "Nearby Hotspot" popup's network list -
    a single scan cycle coming back empty or missing an AP doesn't blank
    it as long as that AP showed up in any of the other still-cached
    snapshots. This is a short-lived display cache, not history - unlike
    WifiScanHistory above, nothing here is ever meant to be looked at once
    it's aged out of the window."""
    id: Optional[int] = Field(default=None, primary_key=True)
    pi_id: str
    interface: str
    networks_json: str = "[]"
    scanned_at: datetime = Field(default_factory=utcnow)


class InterfaceStatus(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    pi_id: str
    interface: str
    mac_address: Optional[str] = None
    state: Optional[str] = None
    type: Optional[str] = None
    ip_address: Optional[str] = None
    ipv6_address: Optional[str] = None
    connected: Optional[bool] = None
    ssid: Optional[str] = None
    bssid: Optional[str] = None
    frequency_mhz: Optional[int] = None
    band: Optional[str] = None
    signal_dbm: Optional[int] = None
    rx_bitrate_mbps: Optional[float] = None
    tx_bitrate_mbps: Optional[float] = None
    gateway: Optional[str] = None
    updated_at: datetime = Field(default_factory=utcnow)


class Command(SQLModel, table=True):
    command_id: str = Field(primary_key=True)   # uuid, echoed back by the Pi
    pi_id: str                                    # or "all" for broadcast
    action: str
    params_json: str = "{}"
    status: str = "pending"                        # pending | complete | failed | timeout
    result_json: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    completed_at: Optional[datetime] = None


class TestCase(SQLModel, table=True):
    # steps_json holds the ordered step list - each step is a dict:
    # {action, target ("all"|"multicast"|a pi_id), target_pi_ids (for
    # multicast), params, delay_before_seconds, repeat_count,
    # expected: {field, op, value} | None}. No separate TestCaseStep table -
    # a testcase's steps are only ever read/written as one ordered whole
    # (the step builder saves/loads the entire list at once), so modeling
    # them as their own rows would just add join overhead for no benefit.
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    description: str = ""
    tags_json: str = "[]"
    author: str = ""
    status: str = "draft"                # "draft" | "ready" - display only, doesn't gate running
    stop_on_failure: bool = True
    repeat_count: int = 1
    steps_json: str = "[]"
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    @property
    def tags(self) -> list:
        return json.loads(self.tags_json)

    @property
    def steps(self) -> list:
        return json.loads(self.steps_json)


class TestRun(SQLModel, table=True):
    # A run snapshots the testcase's steps/config at launch time (steps_json,
    # stop_on_failure, repeat_count) - editing or deleting the testcase
    # afterward doesn't change what a past run says it executed. results_json
    # is appended to step-by-step as the run progresses (see
    # routers/TestCases._run_testcase) so polling GET /testcases/runs/{id}
    # shows live per-step progress, not just a final result.
    id: Optional[int] = Field(default=None, primary_key=True)
    testcase_id: int
    testcase_name: str
    stop_on_failure: bool = True
    repeat_count: int = 1
    steps_json: str = "[]"
    status: str = "running"              # running | passed | failed
    results_json: str = "[]"
    # Set when this run was launched as one step of a testsuite run (see
    # routers/TestSuites._run_testsuite), None for a standalone run. Lets
    # GET /testcases/runs (the Results tab's flat list) exclude these - the
    # owning TestSuiteRun already shows each one nested under itself, so
    # listing them again at the top level would just be the same run twice.
    suite_run_id: Optional[int] = None
    started_at: datetime = Field(default_factory=utcnow)
    completed_at: Optional[datetime] = None


class TestSuite(SQLModel, table=True):
    # testcase_ids_json is an ordered list of TestCase.id - membership only,
    # not ownership: the same testcase can be (and is expected to be)
    # referenced by several testsuites at once, which is the whole point of
    # building a new suite "based on the available testcases on other
    # testsuites" - there's no exclusivity constraint anywhere here, a
    # testcase just has to still exist to be runnable (see
    # routers/TestSuites._run_testsuite's handling of a since-deleted one).
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    description: str = ""
    tags_json: str = "[]"
    author: str = ""
    stop_on_failure: bool = True
    testcase_ids_json: str = "[]"
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    @property
    def tags(self) -> list:
        return json.loads(self.tags_json)

    @property
    def testcase_ids(self) -> list:
        return json.loads(self.testcase_ids_json)


class TestSuiteRun(SQLModel, table=True):
    # Orchestrates one TestRun per testcase_ids_json entry, in order, via
    # the existing single-testcase run engine (see
    # routers/TestSuites._run_testsuite, which calls
    # routers.TestCases._run_testcase directly rather than duplicating it) -
    # a suite run's results_json entries carry each testcase's own run_id,
    # so the UI can drill into that testcase's full per-step results the
    # same way it already does for a standalone testcase run.
    id: Optional[int] = Field(default=None, primary_key=True)
    testsuite_id: int
    testsuite_name: str
    stop_on_failure: bool = True
    testcase_ids_json: str = "[]"
    status: str = "running"              # running | passed | failed
    results_json: str = "[]"
    started_at: datetime = Field(default_factory=utcnow)
    completed_at: Optional[datetime] = None