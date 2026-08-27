import json
import threading
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlmodel import Session, select

from database.database import get_session, get_session_direct
from database.models import TestCase, TestRun, Command
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
        started_at=r.started_at, completed_at=r.completed_at,
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
def list_runs(limit: int = 50, session: Session = Depends(get_session)):
    """Run history across every testcase, newest first - the Testcases tab's
    History view."""
    runs = session.exec(select(TestRun).order_by(TestRun.started_at.desc()).limit(limit)).all()
    return [_run_to_out(r) for r in runs]


@router.get("/runs/{run_id}", response_model=TestRunOut)
def get_run(run_id: int, session: Session = Depends(get_session)):
    run = session.get(TestRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return _run_to_out(run)


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
        entry_started = datetime.now(timezone.utc)
        with get_session_direct() as session:
            req = CommandRequest(action=action, params=dict(params))
            try:
                out = _dispatch(pi_id, req, session)
                session.commit()
            except Exception as e:
                log.append(_log_line("error", f"{label} -> {pi_id}: dispatch failed: {e}"))
                entries.append({
                    "pi_id": pi_id, "status": "failed", "error": str(e),
                    "dispatched_at": entry_started.isoformat(),
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                    "duration_ms": _elapsed_ms(entry_started),
                })
                step_passed = False
                continue

        log.append(_log_line("info", f"{label} -> {pi_id}: dispatched (command {out.command_id})"))
        status, result = _await_command(out.command_id)
        duration_ms = _elapsed_ms(entry_started)

        if status == "timeout":
            log.append(_log_line(
                "error",
                f"{label} -> {pi_id}: no result after {COMMAND_TIMEOUT_SECONDS}s "
                f"- giving up (command {out.command_id} may still be running on the Pi)",
            ))
            entries.append({
                "pi_id": pi_id, "command_id": out.command_id, "status": "timeout",
                "command_status": "timeout",
                "dispatched_at": entry_started.isoformat(),
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "duration_ms": duration_ms,
            })
            step_passed = False
            continue

        log.append(_log_line(
            "info" if status == "complete" else "error",
            f"{label} -> {pi_id}: {status} in {duration_ms / 1000:.1f}s - {_result_summary(result)}",
        ))

        ok, reason, checks = _evaluate_expected(result, expected)
        # One line per checked field rather than one for the step: with
        # several fields asserted, "expectation NOT met" alone doesn't say
        # which of them was wrong.
        for c in checks:
            log.append(_log_line(
                "info" if c["passed"] else "error",
                f"{label} -> {pi_id}: check {c['field'] or '<result>'} {c['op']} "
                f"{c['value']!r} -> {'OK' if c['passed'] else 'FAIL'} (actual {c['actual']!r})",
            ))
        entry_status = "passed" if status == "complete" and ok else "failed"
        if entry_status == "failed":
            step_passed = False
        entries.append({
            "pi_id": pi_id, "command_id": out.command_id, "status": entry_status,
            "command_status": status, "result": result, "reason": reason,
            "expected": expected, "checks": checks,
            "dispatched_at": entry_started.isoformat(),
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": duration_ms,
        })

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

    for pass_no in range(repeat_count):
        if stopped:
            break
        for idx, step in enumerate(steps):
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
                # apart.
                step_result["pass_index"] = pass_no
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
                    run.results_json = json.dumps(results)
                    session.add(run)
                    session.commit()

                if stopped:
                    break

    with get_session_direct() as session:
        run = session.get(TestRun, run_id)
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
