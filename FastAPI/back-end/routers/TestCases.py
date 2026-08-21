import json
import threading
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from database.database import get_session, get_session_direct
from database.models import TestCase, TestRun, Command
from schemas.schemas import TestCaseRequest, TestCaseOut, TestRunOut, CommandRequest
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
def list_testcases(q: str = "", tag: str = "", session: Session = Depends(get_session)):
    testcases = session.exec(select(TestCase).order_by(TestCase.updated_at.desc())).all()
    if q:
        ql = q.lower()
        testcases = [t for t in testcases if ql in t.name.lower() or ql in t.description.lower()]
    if tag:
        testcases = [t for t in testcases if tag in t.tags]
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


def _evaluate_expected(result, expected):
    """Returns (passed, reason). No expectation configured always passes -
    the step still has to complete without erroring/timing out to be
    considered passed at all (see _run_step_once)."""
    if not expected:
        return True, None
    field = expected.get("field")
    op = expected.get("op", "eq")
    expected_value = expected.get("value")
    actual = _get_dotted(result or {}, field)
    fn = _EXPECTED_OPS.get(op)
    if fn is None:
        return False, f"unknown operator: {op}"
    try:
        ok = bool(fn(actual, expected_value))
    except TypeError as e:
        return False, f"comparison error: {e}"
    return ok, None if ok else f"expected {field or '<result>'} {op} {expected_value!r}, got {actual!r}"


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


def _run_step_once(step: dict) -> dict:
    """Runs one step against every one of its resolved targets - one entry
    per target, each with its own dispatched command's result and pass/fail
    against the step's expected outcome. The step as a whole only passes if
    every target's entry does."""
    action = step.get("action")
    params = step.get("params") or {}
    expected = step.get("expected")
    entries = []
    step_passed = True

    targets = _resolve_targets(step)
    if not targets:
        return {"action": action, "status": "failed", "entries": [{"status": "failed", "error": "no target resolved"}]}

    for pi_id in targets:
        with get_session_direct() as session:
            req = CommandRequest(action=action, params=dict(params))
            try:
                out = _dispatch(pi_id, req, session)
                session.commit()
            except Exception as e:
                entries.append({"pi_id": pi_id, "status": "failed", "error": str(e)})
                step_passed = False
                continue

        status, result = _await_command(out.command_id)
        if status == "timeout":
            entries.append({"pi_id": pi_id, "command_id": out.command_id, "status": "timeout"})
            step_passed = False
            continue

        ok, reason = _evaluate_expected(result, expected)
        entry_status = "passed" if status == "complete" and ok else "failed"
        if entry_status == "failed":
            step_passed = False
        entries.append({
            "pi_id": pi_id, "command_id": out.command_id, "status": entry_status,
            "result": result, "reason": reason,
        })

    return {"action": action, "status": "passed" if step_passed else "failed", "entries": entries}


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

    for _ in range(repeat_count):
        if stopped:
            break
        for idx, step in enumerate(steps):
            if stopped:
                break
            for _ in range(max(1, step.get("repeat_count", 1))):
                delay = step.get("delay_before_seconds") or 0
                if delay:
                    time.sleep(delay)

                step_result = _run_step_once(step)
                step_result["step_index"] = idx
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
