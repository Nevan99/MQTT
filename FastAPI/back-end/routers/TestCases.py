import json
import threading
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlmodel import Session, select

from database.database import get_session, get_session_direct
from database.models import TestCase, TestRun, Command, Pi
from schemas.schemas import (
    TestCaseRequest, TestCaseOut, TestRunOut, CommandRequest,
    TestCaseBulkRequest, TestCaseBulkTagRequest,
)
from service.mqtt_service import mqtt_service
from service.auth import get_current_user
from routers.Commands import _dispatch

router = APIRouter(prefix="/testcases", tags=["testcases"], dependencies=[Depends(get_current_user)])

# How long one step's dispatched command is allowed to sit "pending" before
# the runner gives up on it and marks that step a timeout - generous enough
# to cover connect_wifi/disconnect_wifi's own up-to-5-minute nmcli timeout
# would need to be longer, but a testcase step timing out that slowly isn't
# a great experience either; 60s covers every other action comfortably.
COMMAND_TIMEOUT_SECONDS = 60


def _testcase_to_out(t: TestCase) -> TestCaseOut:
    return TestCaseOut(
        id=t.id, name=t.name, description=t.description, tags=t.tags, author=t.author,
        status=t.status, stop_on_failure=t.stop_on_failure, repeat_count=t.repeat_count,
        steps=t.steps, created_at=t.created_at, updated_at=t.updated_at,
    )


def _run_to_out(r: TestRun) -> TestRunOut:
    return TestRunOut(
        id=r.id, testcase_id=r.testcase_id, testcase_name=r.testcase_name,
        stop_on_failure=r.stop_on_failure, repeat_count=r.repeat_count,
        steps=json.loads(r.steps_json), status=r.status, results=json.loads(r.results_json),
        suite_run_id=r.suite_run_id, started_at=r.started_at, completed_at=r.completed_at,
    )


@router.get("", response_model=list[TestCaseOut])
def list_testcases(
    response: Response,
    q: str = "",
    tag: str = "",
    offset: int = 0,
    limit: int = 0,
    session: Session = Depends(get_session),
):
    """Testcases matching the filters, newest-updated first.

    Paginated via offset/limit, with the *unpaginated* match count returned
    in the X-Total-Count header - the table's pager needs "of 64" as well as
    the 25 rows it's showing, and a body that carried both would change this
    endpoint's shape for its other caller (the testsuite editor's testcase
    picker, which wants every testcase and no slicing). limit=0 means "no
    limit", which is what that caller keeps getting.
    """
    testcases = session.exec(select(TestCase).order_by(TestCase.updated_at.desc())).all()
    if q:
        ql = q.lower()
        testcases = [t for t in testcases if ql in t.name.lower() or ql in t.description.lower()]
    if tag:
        testcases = [t for t in testcases if tag in t.tags]

    response.headers["X-Total-Count"] = str(len(testcases))
    if limit > 0:
        testcases = testcases[offset:offset + limit]
    elif offset:
        testcases = testcases[offset:]
    return [_testcase_to_out(t) for t in testcases]


@router.post("", response_model=TestCaseOut)
def create_testcase(req: TestCaseRequest, session: Session = Depends(get_session)):
    testcase = TestCase(
        name=req.name, description=req.description, tags_json=json.dumps(req.tags),
        author=req.author, status=req.status, stop_on_failure=req.stop_on_failure,
        repeat_count=req.repeat_count, steps_json=json.dumps([s.model_dump() for s in req.steps]),
    )
    session.add(testcase)
    session.commit()
    session.refresh(testcase)
    return _testcase_to_out(testcase)


# Declared ahead of GET/PUT/DELETE /{testcase_id} below so these literal
# "/runs" paths aren't shadowed by {testcase_id} matching "runs" as a
# literal testcase id - same reasoning as routers/Pis.get_all_interface_status.

@router.get("/runs", response_model=list[TestRunOut])
def list_runs(limit: int = 50, include_suite_children: bool = False, session: Session = Depends(get_session)):
    """Run history across every testcase, newest first - the Testcases tab's
    History view and the Results tab's flat list.

    Excludes runs launched as one step of a testsuite run by default
    (suite_run_id set - see routers/TestSuites._run_testsuite): the owning
    TestSuiteRun already lists each one nested under itself (drill-down via
    GET /testsuites/runs/{id} -> its results[].run_id), so including them
    here too would show the same run twice. Pass include_suite_children=true
    to get the unfiltered list back."""
    query = select(TestRun).order_by(TestRun.started_at.desc())
    if not include_suite_children:
        query = query.where(TestRun.suite_run_id.is_(None))
    runs = session.exec(query.limit(limit)).all()
    return [_run_to_out(r) for r in runs]


@router.get("/runs/{run_id}", response_model=TestRunOut)
def get_run(run_id: int, session: Session = Depends(get_session)):
    run = session.get(TestRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return _run_to_out(run)


@router.delete("/runs/{run_id}")
def delete_run(run_id: int, session: Session = Depends(get_session)):
    """Deletes one run's history. A run still in progress can be deleted too
    - the background thread (_run_testcase) only touches this row through
    get_session_direct() lookups by id, which just come back None afterward
    and the thread quietly stops updating it."""
    run = session.get(TestRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    session.delete(run)
    session.commit()
    return {"deleted": run_id}


# --- bulk actions --------------------------------------------------------
# Back the Testcases table's checkbox toolbar. Also declared ahead of
# /{testcase_id} so "bulk" isn't matched as a testcase id.
#
# Ids that no longer exist are skipped rather than 404ing the whole call: a
# selection is a snapshot of what the table showed, and someone else
# deleting one of those rows in between shouldn't fail the other 24.

def _testcases_by_ids(session: Session, ids: list[int]) -> list[TestCase]:
    """Selected testcases, in the order the ids were given, skipping any
    that have since been deleted."""
    found = (session.get(TestCase, i) for i in dict.fromkeys(ids))
    return [t for t in found if t is not None]


@router.post("/bulk/run", response_model=list[TestRunOut])
def bulk_run_testcases(req: TestCaseBulkRequest, session: Session = Depends(get_session)):
    """Start one independent run per selected testcase.

    Deliberately not a single combined run: each testcase keeps its own
    stop_on_failure/repeat_count and its own row in the run history, exactly
    as if each had been launched from its own row button. They run
    concurrently, one background thread each, the same way _run_testcase is
    already started from run_testcase below."""
    runs = []
    for testcase in _testcases_by_ids(session, req.ids):
        run = TestRun(
            testcase_id=testcase.id, testcase_name=testcase.name,
            stop_on_failure=testcase.stop_on_failure, repeat_count=testcase.repeat_count,
            steps_json=testcase.steps_json,
        )
        session.add(run)
        session.commit()
        session.refresh(run)
        threading.Thread(target=_run_testcase, args=(run.id,), daemon=True).start()
        runs.append(_run_to_out(run))
    return runs


@router.post("/bulk/duplicate", response_model=list[TestCaseOut])
def bulk_duplicate_testcases(req: TestCaseBulkRequest, session: Session = Depends(get_session)):
    copies = []
    for src in _testcases_by_ids(session, req.ids):
        copy = TestCase(
            name=f"{src.name} (copy)", description=src.description, tags_json=src.tags_json,
            author=src.author, status="draft", stop_on_failure=src.stop_on_failure,
            repeat_count=src.repeat_count, steps_json=src.steps_json,
        )
        session.add(copy)
        copies.append(copy)
    session.commit()
    for copy in copies:
        session.refresh(copy)
    return [_testcase_to_out(c) for c in copies]


@router.post("/bulk/tag", response_model=list[TestCaseOut])
def bulk_tag_testcases(req: TestCaseBulkTagRequest, session: Session = Depends(get_session)):
    if req.mode not in ("add", "remove", "set"):
        raise HTTPException(status_code=400, detail="mode must be add, remove or set")

    updated = []
    for testcase in _testcases_by_ids(session, req.ids):
        if req.mode == "set":
            tags = list(dict.fromkeys(req.tags))
        elif req.mode == "add":
            # dict.fromkeys rather than a set: tag order is what the table
            # renders, so it should stay stable instead of reshuffling on
            # every bulk edit.
            tags = list(dict.fromkeys([*testcase.tags, *req.tags]))
        else:
            drop = set(req.tags)
            tags = [t for t in testcase.tags if t not in drop]
        testcase.tags_json = json.dumps(tags)
        testcase.updated_at = datetime.now(timezone.utc)
        session.add(testcase)
        updated.append(testcase)
    session.commit()
    for testcase in updated:
        session.refresh(testcase)
    return [_testcase_to_out(t) for t in updated]


@router.post("/bulk/delete")
def bulk_delete_testcases(req: TestCaseBulkRequest, session: Session = Depends(get_session)):
    deleted = []
    for testcase in _testcases_by_ids(session, req.ids):
        deleted.append(testcase.id)
        session.delete(testcase)
    session.commit()
    return {"deleted": deleted, "requested": len(set(req.ids))}


@router.get("/bulk/export")
def bulk_export_testcases(ids: str = "", session: Session = Depends(get_session)):
    """Selected testcases as a downloadable JSON file.

    `ids` is comma-separated to keep this a plain link the browser can
    follow (the toolbar's Export is an <a href>, not a fetch - so the
    download goes through the browser's own handling rather than needing a
    blob round-trip). Empty means every testcase."""
    try:
        wanted = [int(i) for i in ids.split(",") if i.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="ids must be comma-separated integers")

    if wanted:
        testcases = _testcases_by_ids(session, wanted)
    else:
        testcases = session.exec(select(TestCase).order_by(TestCase.updated_at.desc())).all()

    # Exported without ids/timestamps: this is a definition to import
    # elsewhere, not a row to restore in place - carrying an id would invite
    # an import that silently overwrites an unrelated local testcase.
    payload = [
        {
            "name": t.name, "description": t.description, "tags": t.tags, "author": t.author,
            "status": t.status, "stop_on_failure": t.stop_on_failure,
            "repeat_count": t.repeat_count, "steps": t.steps,
        }
        for t in testcases
    ]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return Response(
        content=json.dumps(payload, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="testcases-{stamp}.json"'},
    )


@router.get("/{testcase_id}", response_model=TestCaseOut)
def get_testcase(testcase_id: int, session: Session = Depends(get_session)):
    testcase = session.get(TestCase, testcase_id)
    if testcase is None:
        raise HTTPException(status_code=404, detail="Testcase not found")
    return _testcase_to_out(testcase)


@router.put("/{testcase_id}", response_model=TestCaseOut)
def update_testcase(testcase_id: int, req: TestCaseRequest, session: Session = Depends(get_session)):
    """Overwrite-on-save - no versioning for v1 (see TestCase model)."""
    testcase = session.get(TestCase, testcase_id)
    if testcase is None:
        raise HTTPException(status_code=404, detail="Testcase not found")
    testcase.name = req.name
    testcase.description = req.description
    testcase.tags_json = json.dumps(req.tags)
    testcase.author = req.author
    testcase.status = req.status
    testcase.stop_on_failure = req.stop_on_failure
    testcase.repeat_count = req.repeat_count
    testcase.steps_json = json.dumps([s.model_dump() for s in req.steps])
    testcase.updated_at = datetime.now(timezone.utc)
    session.add(testcase)
    session.commit()
    session.refresh(testcase)
    return _testcase_to_out(testcase)


@router.post("/{testcase_id}/duplicate", response_model=TestCaseOut)
def duplicate_testcase(testcase_id: int, session: Session = Depends(get_session)):
    src = session.get(TestCase, testcase_id)
    if src is None:
        raise HTTPException(status_code=404, detail="Testcase not found")
    copy = TestCase(
        name=f"{src.name} (copy)", description=src.description, tags_json=src.tags_json,
        author=src.author, status="draft", stop_on_failure=src.stop_on_failure,
        repeat_count=src.repeat_count, steps_json=src.steps_json,
    )
    session.add(copy)
    session.commit()
    session.refresh(copy)
    return _testcase_to_out(copy)


@router.delete("/{testcase_id}")
def delete_testcase(testcase_id: int, session: Session = Depends(get_session)):
    testcase = session.get(TestCase, testcase_id)
    if testcase is None:
        raise HTTPException(status_code=404, detail="Testcase not found")
    session.delete(testcase)
    session.commit()
    return {"deleted": testcase_id}


# --- run engine ----------------------------------------------------------
# Runs entirely on a background thread (started by POST /{testcase_id}/run,
# below), the same pattern mqtt_service and pi_agent's own worker threads
# use for anything that blocks - polling a step's command to completion can
# take up to COMMAND_TIMEOUT_SECONDS, which would otherwise tie up the
# request/event loop for the whole testcase's duration.

def _get_dotted(d, path):
    if not path:
        return d
    cur = d
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


_EXPECTED_OPS = {
    "eq": lambda a, e: a == e,
    "ne": lambda a, e: a != e,
    "gt": lambda a, e: a is not None and a > e,
    "gte": lambda a, e: a is not None and a >= e,
    "lt": lambda a, e: a is not None and a < e,
    "lte": lambda a, e: a is not None and a <= e,
    "contains": lambda a, e: a is not None and e in a,
    "exists": lambda a, e: a is not None,
}


def _normalise_expectations(expected) -> list:
    """The step's expectations as a list, whatever shape it was saved in.

    The editor now sends one entry per result field the operator ticked, but
    testcases saved before that carry a single bare object - accepted here
    rather than migrated, so an old testcase keeps running unchanged."""
    if not expected:
        return []
    if isinstance(expected, dict):
        return [expected]
    return [e for e in expected if e]


def _evaluate_expected(result, expected):
    """Returns (passed, reason, checks) - one check per expected field, each
    recording what was wanted and what actually came back.

    Every check must pass for the step to pass. `checks` is kept on the
    entry and written to the log line by line, so a failed step names the
    specific field that missed rather than just the first one: asserting
    connected AND ip_address AND signal_dbm should tell you which of the
    three was wrong.

    No expectations configured always passes - the step still has to
    complete without erroring or timing out to be considered passed at all
    (see _run_step_once)."""
    checks = []
    for exp in _normalise_expectations(expected):
        field = exp.get("field")
        op = exp.get("op", "eq")
        expected_value = exp.get("value")
        actual = _get_dotted(result or {}, field)
        fn = _EXPECTED_OPS.get(op)
        if fn is None:
            checks.append({"field": field, "op": op, "value": expected_value, "actual": actual,
                           "passed": False, "reason": f"unknown operator: {op}"})
            continue
        try:
            ok = bool(fn(actual, expected_value))
            reason = None if ok else f"expected {field or '<result>'} {op} {expected_value!r}, got {actual!r}"
        except TypeError as e:
            ok, reason = False, f"comparison error on {field or '<result>'}: {e}"
        checks.append({"field": field, "op": op, "value": expected_value, "actual": actual,
                       "passed": ok, "reason": reason})

    failed = [c for c in checks if not c["passed"]]
    reason = "; ".join(c["reason"] for c in failed if c["reason"]) or None
    return not failed, reason, checks


def _await_command(command_id: str, timeout_seconds: float = COMMAND_TIMEOUT_SECONDS):
    """Polls a dispatched command to completion - handles both a persisted
    Command row and a TRANSIENT_ACTIONS entry (see
    service.mqtt_service.TRANSIENT_ACTIONS) the same way GET /commands/{id}
    does for the frontend's own polling, just called directly from this
    backend-side runner instead of over HTTP."""
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        transient = mqtt_service.get_transient_command(command_id)
        if transient is not None:
            if transient["status"] != "pending":
                return transient["status"], transient["result"]
        else:
            with get_session_direct() as session:
                command = session.get(Command, command_id)
                if command is not None and command.status != "pending":
                    result = json.loads(command.result_json) if command.result_json else None
                    return command.status, result
        time.sleep(1)
    return "timeout", None


def _resolve_targets(step: dict) -> list:
    target = step.get("target", "all")
    if target == "multicast":
        return step.get("target_pi_ids") or []
    return [target]


# Sentinel an interface param carries to mean "whatever radios this Pi has",
# resolved per-Pi at run time rather than frozen into the testcase. A step
# saved with it keeps working when a Pi gains or loses a dongle, and one step
# covers a fleet whose members don't all have the same interface names.
ALL_INTERFACES = "*"


def _pi_interfaces(pi_id: str) -> list:
    """This Pi's known interfaces, as last reported by its registration (see
    routers/Pis - metadata_dict["interfaces"])."""
    with get_session_direct() as session:
        pi = session.get(Pi, pi_id)
        if pi is None:
            return []
        return [i for i in pi.metadata_dict.get("interfaces", []) if i]


def _resolve_iface_value(value, pi_id: str) -> list:
    """This Pi's share of an interface param, in any of the shapes a step can
    carry it:

      "*"                              every radio this Pi reports
      {"pi01": [...], "pi03": [...]}   per-Pi selection - only this Pi's entry
      ["wlan1", "wlan2"]               those names on every targeted Pi
      "wlan1"                          one name (the original single-select)

    The dict form is what the editor writes for a step targeting several Pis,
    and is the only one that can say "pi01's wlan1 but not pi03's". The list
    and string forms are kept because steps saved earlier use them.
    """
    if value == ALL_INTERFACES:
        return _pi_interfaces(pi_id)
    if isinstance(value, dict):
        return [v for v in (value.get(pi_id) or []) if v]
    if isinstance(value, list):
        return [v for v in value if v]
    return [value] if value else []


def _selection_omits_pi(value, pi_id: str) -> bool:
    """True when a per-Pi selection simply has nothing for this Pi.

    Distinguishes "you didn't pick anything here" from "you asked for every
    radio and this Pi reports none" - the first is the selection working as
    written and is skipped, the second is a real problem and fails the step.
    Only the dict form can express the former."""
    return isinstance(value, dict) and not (value.get(pi_id) or [])


def _expand_interface_dispatches(params: dict, pi_id: str):
    """One params dict per command this step should send to `pi_id`.

    Which key is present decides the shape, matching what pi_agent accepts:

      "interfaces" (nearby_hotspots, connect_hotspot) takes a list in a
      single command - the agent scans/connects them together on purpose, so
      "all" widens that one command's list rather than making several.

      "interface" (connect_wifi, link_info, ...) takes exactly one, so a
      multi-interface selection fans out into one command per interface -
      "connect these three radios" is three connects, not one.

    Whichever shape the param holds, _resolve_iface_value reduces it to this
    Pi's own list first - so a per-Pi map yields different interfaces per
    target, which is the whole point of it.

    Returns (list_of_params, resolved_interfaces). An empty list means this
    Pi resolved to no interfaces; the caller decides whether that is a skip
    (nothing was selected for it) or a failure - see _selection_omits_pi.
    """
    if "interfaces" in params:
        resolved = _resolve_iface_value(params["interfaces"], pi_id)
        if not resolved:
            return [], []
        return [{**params, "interfaces": resolved}], resolved

    if "interface" in params:
        value = params["interface"]
        # A plain single name is passed through untouched - no lookup, so a
        # step naming an interface the backend hasn't seen reported still
        # dispatches (and fails on the Pi, where the real answer is).
        if isinstance(value, str) and value != ALL_INTERFACES:
            return [dict(params)], [value]
        resolved = _resolve_iface_value(value, pi_id)
        if not resolved:
            return [], []
        return [{**params, "interface": i} for i in resolved], resolved

    return [dict(params)], []


def _log_line(level: str, message: str) -> dict:
    return {"ts": datetime.now(timezone.utc).isoformat(), "level": level, "message": message}


def _elapsed_ms(since: datetime) -> int:
    return int((datetime.now(timezone.utc) - since).total_seconds() * 1000)


def _result_summary(result) -> str:
    """One-line gist of a command result, for the step log.

    The full payload is kept on the entry itself - this is the bit that goes
    in the log stream, so it has to stay short enough to scan. Picks out the
    fields that actually say what happened on a wifi action (connected /
    ip_address / failure_reason and friends) and falls back to a truncated
    dump for actions with no known shape."""
    if result is None:
        return "no result payload"
    if not isinstance(result, dict):
        return str(result)[:200]

    interesting = ("connected", "disconnected", "ip_address", "ssid", "bssid",
                   "interface", "applied", "failure_reason", "error")
    parts = [f"{k}={result[k]!r}" for k in interesting if result.get(k) not in (None, "")]
    if parts:
        return ", ".join(parts)
    dumped = json.dumps(result, default=str)
    return dumped if len(dumped) <= 200 else dumped[:197] + "..."


def _run_step_once(step: dict, step_index: int = 0, iteration: int = 1) -> dict:
    """Runs one step against every one of its resolved targets - one entry
    per target, each with its own dispatched command's result and pass/fail
    against the step's expected outcome. The step as a whole only passes if
    every target's entry does.

    Every entry also carries its own timing and a `log` of what happened to
    it (dispatch, outcome, expectation check), and the step carries the
    merged stream. That detail is the point: a step that reports only
    "failed" leaves you guessing whether the command was never dispatched,
    timed out, came back with an error, or came back fine and simply missed
    its expected value - which are four different problems.
    """
    action = step.get("action")
    params = step.get("params") or {}
    expected = step.get("expected")
    entries = []
    log = []
    step_passed = True
    started_at = datetime.now(timezone.utc)
    label = f"step {step_index + 1} '{action}'"

    targets = _resolve_targets(step)
    if not targets:
        log.append(_log_line("error", f"{label}: no target resolved (target={step.get('target')!r})"))
        return {
            "action": action, "status": "failed", "target": step.get("target"),
            "params": params, "iteration": iteration,
            "started_at": started_at.isoformat(),
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": 0, "log": log,
            "entries": [{"status": "failed", "error": "no target resolved"}],
        }

    log.append(_log_line("info", f"{label} -> {len(targets)} target(s): {', '.join(map(str, targets))}"))
    if params:
        log.append(_log_line("debug", f"{label}: params {json.dumps(params, default=str)}"))

    for pi_id in targets:
        dispatches, resolved_ifaces = _expand_interface_dispatches(params, pi_id)
        if not dispatches:
            asked = params.get("interfaces", params.get("interface"))
            if _selection_omits_pi(asked, pi_id):
                # Targeted by the step but deliberately given no interfaces -
                # not a failure, just nothing to do here. Logged so a step
                # that silently does nothing on a Pi is still visible.
                log.append(_log_line(
                    "debug", f"{label} -> {pi_id}: no interfaces selected for this Pi, skipping"))
                continue
            log.append(_log_line(
                "error",
                f"{label} -> {pi_id}: no interfaces resolved "
                f"(step asked for {asked!r}; this Pi reports {_pi_interfaces(pi_id) or 'none'})",
            ))
            entries.append({"pi_id": pi_id, "status": "failed",
                            "error": "no interfaces resolved for this Pi"})
            step_passed = False
            continue

        if len(dispatches) > 1:
            log.append(_log_line(
                "info", f"{label} -> {pi_id}: fanning out over {len(resolved_ifaces)} "
                        f"interface(s): {', '.join(resolved_ifaces)}"))

        for dispatch_params in dispatches:
            # Which interface this particular command went to, for the entry
            # label - the singular case has one per dispatch, the plural case
            # carries the whole list in one.
            iface = dispatch_params.get("interface") or dispatch_params.get("interfaces")
            entry_started = datetime.now(timezone.utc)
            with get_session_direct() as session:
                req = CommandRequest(action=action, params=dict(dispatch_params))
                try:
                    out = _dispatch(pi_id, req, session)
                    session.commit()
                except Exception as e:
                    log.append(_log_line("error", f"{label} -> {pi_id}/{iface}: dispatch failed: {e}"))
                    entries.append({
                        "pi_id": pi_id, "interface": iface, "status": "failed", "error": str(e),
                        "dispatched_at": entry_started.isoformat(),
                        "completed_at": datetime.now(timezone.utc).isoformat(),
                        "duration_ms": _elapsed_ms(entry_started),
                    })
                    step_passed = False
                    continue

            log.append(_log_line("info", f"{label} -> {pi_id}/{iface}: dispatched (command {out.command_id})"))
            if _run_one_dispatch(
                label, pi_id, iface, out, expected, entry_started, log, entries,
            ) is False:
                step_passed = False

    # Every target skipped for having nothing selected means the step ran no
    # commands at all. Without this it would report "passed" on the strength
    # of having done nothing, which is the worst possible way to report it.
    if not entries:
        log.append(_log_line(
            "error",
            f"{label}: no commands sent - none of the {len(targets)} targeted Pi(s) "
            f"had any interface selected",
        ))
        entries.append({"status": "failed", "error": "no interfaces selected on any targeted Pi"})
        step_passed = False

    completed_at = datetime.now(timezone.utc)
    log.append(_log_line(
        "info" if step_passed else "error",
        f"{label}: {'passed' if step_passed else 'failed'} "
        f"({_elapsed_ms(started_at) / 1000:.1f}s total)",
    ))
    return {
        "action": action,
        "status": "passed" if step_passed else "failed",
        "target": step.get("target"),
        "params": params,
        "iteration": iteration,
        "started_at": started_at.isoformat(),
        "completed_at": completed_at.isoformat(),
        "duration_ms": _elapsed_ms(started_at),
        "log": log,
        "entries": entries,
    }


def _run_one_dispatch(label, pi_id, iface, out, expected, entry_started, log, entries):
    """Waits on one dispatched command and appends its entry. Returns False
    if it did not pass, so the caller can fail the whole step.

    Split out of _run_step_once only because that function now has an extra
    nesting level (target -> interface -> command); the logic is unchanged."""
    who = f"{pi_id}/{iface}" if iface else str(pi_id)
    status, result = _await_command(out.command_id)
    duration_ms = _elapsed_ms(entry_started)

    if status == "timeout":
        log.append(_log_line(
            "error",
            f"{label} -> {who}: no result after {COMMAND_TIMEOUT_SECONDS}s "
            f"- giving up (command {out.command_id} may still be running on the Pi)",
        ))
        entries.append({
            "pi_id": pi_id, "interface": iface, "command_id": out.command_id,
            "status": "timeout", "command_status": "timeout",
            "dispatched_at": entry_started.isoformat(),
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": duration_ms,
        })
        return False

    log.append(_log_line(
        "info" if status == "complete" else "error",
        f"{label} -> {who}: {status} in {duration_ms / 1000:.1f}s - {_result_summary(result)}",
    ))

    ok, reason, checks = _evaluate_expected(result, expected)
    # One line per checked field rather than one for the step: with several
    # fields asserted, "expectation NOT met" alone doesn't say which was wrong.
    for c in checks:
        log.append(_log_line(
            "info" if c["passed"] else "error",
            f"{label} -> {who}: check {c['field'] or '<result>'} {c['op']} "
            f"{c['value']!r} -> {'OK' if c['passed'] else 'FAIL'} (actual {c['actual']!r})",
        ))

    entry_status = "passed" if status == "complete" and ok else "failed"
    entries.append({
        "pi_id": pi_id, "interface": iface, "command_id": out.command_id,
        "status": entry_status, "command_status": status, "result": result,
        "reason": reason, "expected": expected, "checks": checks,
        "dispatched_at": entry_started.isoformat(),
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "duration_ms": duration_ms,
    })
    return entry_status == "passed"


# --- loop groups ----------------------------------------------------------
# Steps carry the loop with them (loop_group + loop_count) rather than the
# testcase holding a separate list of ranges: it keeps everything inside the
# existing steps_json, so no new column and no migration of the live
# pi_fleet.db. A group is a *contiguous* run of steps sharing loop_group; the
# count is taken from its first step.

def _expand_step_plan(steps: list) -> list:
    """(step, step_index, loop_group, loop_pass) in execution order.

    Non-contiguous reuse of the same group name is treated as two separate
    groups, each looping on its own - the editor only ever writes contiguous
    ranges, and silently stitching distant steps together would be a
    surprising way to interpret hand-edited JSON."""
    plan = []
    i, n = 0, len(steps)
    while i < n:
        group = steps[i].get("loop_group")
        if not group:
            plan.append((steps[i], i, None, None))
            i += 1
            continue
        j = i
        while j < n and steps[j].get("loop_group") == group:
            j += 1
        count = max(1, int(steps[i].get("loop_count") or 1))
        for it in range(count):
            for k in range(i, j):
                plan.append((steps[k], k, group, it + 1))
        i = j
    return plan


def _run_testcase(run_id: int):
    with get_session_direct() as session:
        run = session.get(TestRun, run_id)
        if run is None:
            return
        steps = json.loads(run.steps_json)
        stop_on_failure = run.stop_on_failure
        repeat_count = max(1, run.repeat_count)

    results = []
    overall_passed = True
    stopped = False

    # Built once: loop groups expand into the flat execution order here, so
    # the run loop below stays a straight walk and every step result can name
    # which loop pass produced it.
    plan = _expand_step_plan(steps)

    for pass_no in range(repeat_count):
        if stopped:
            break
        for step, idx, loop_group, loop_pass in plan:
            if stopped:
                break
            for rep in range(max(1, step.get("repeat_count", 1))):
                delay = step.get("delay_before_seconds") or 0
                delay_log = []
                if delay:
                    # Logged rather than slept through silently: a run that
                    # looks stalled is usually a step's own configured delay,
                    # and without this there is nothing in the stream between
                    # the previous step finishing and this one dispatching.
                    delay_log.append(_log_line(
                        "debug", f"step {idx + 1} '{step.get('action')}': waiting {delay}s before dispatch"))
                    time.sleep(delay)

                step_result = _run_step_once(step, step_index=idx, iteration=rep + 1)
                step_result["step_index"] = idx
                # Which outer repeat of the whole testcase this belongs to -
                # without it, repeat_count > 1 produces several identical-
                # looking rows for the same step with nothing to tell them
                # apart. loop_group/loop_pass do the same job for a step
                # inside a looped block.
                step_result["pass_index"] = pass_no
                step_result["loop_group"] = loop_group
                step_result["loop_pass"] = loop_pass
                if delay_log:
                    step_result["log"] = delay_log + step_result.get("log", [])
                results.append(step_result)

                if step_result["status"] == "failed":
                    overall_passed = False
                    if stop_on_failure:
                        stopped = True

                # Persisted after every step (not just at the end) so a
                # client polling GET /testcases/runs/{run_id} sees live
                # per-step progress instead of only the final result.
                with get_session_direct() as session:
                    run = session.get(TestRun, run_id)
                    # Deleted (see DELETE /testcases/runs/{run_id}) while this
                    # was still running - nothing left to write progress to,
                    # and the commands already dispatched can't be recalled,
                    # so just stop updating rather than crash the thread.
                    if run is None:
                        return
                    run.results_json = json.dumps(results)
                    session.add(run)
                    session.commit()

                if stopped:
                    break

    with get_session_direct() as session:
        run = session.get(TestRun, run_id)
        if run is None:
            return
        run.status = "passed" if overall_passed else "failed"
        run.completed_at = datetime.now(timezone.utc)
        session.add(run)
        session.commit()


@router.post("/{testcase_id}/run", response_model=TestRunOut)
def run_testcase(testcase_id: int, session: Session = Depends(get_session)):
    testcase = session.get(TestCase, testcase_id)
    if testcase is None:
        raise HTTPException(status_code=404, detail="Testcase not found")
    run = TestRun(
        testcase_id=testcase.id, testcase_name=testcase.name,
        stop_on_failure=testcase.stop_on_failure, repeat_count=testcase.repeat_count,
        steps_json=testcase.steps_json,
    )
    session.add(run)
    session.commit()
    session.refresh(run)
    threading.Thread(target=_run_testcase, args=(run.id,), daemon=True).start()
    return _run_to_out(run)
