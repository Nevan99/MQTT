import json
import threading
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from database.database import get_session, get_session_direct
from database.models import TestSuite, TestSuiteRun, TestCase, TestRun
from schemas.schemas import TestSuiteRequest, TestSuiteOut, TestSuiteRunOut
from service.auth import get_current_user
from routers.TestCases import _run_testcase

router = APIRouter(prefix="/testsuites", tags=["testsuites"], dependencies=[Depends(get_current_user)])


def _testsuite_to_out(s: TestSuite) -> TestSuiteOut:
    return TestSuiteOut(
        id=s.id, name=s.name, description=s.description, tags=s.tags, author=s.author,
        stop_on_failure=s.stop_on_failure, testcase_ids=s.testcase_ids,
        created_at=s.created_at, updated_at=s.updated_at,
    )


def _suite_run_to_out(r: TestSuiteRun) -> TestSuiteRunOut:
    return TestSuiteRunOut(
        id=r.id, testsuite_id=r.testsuite_id, testsuite_name=r.testsuite_name,
        stop_on_failure=r.stop_on_failure, testcase_ids=json.loads(r.testcase_ids_json),
        status=r.status, results=json.loads(r.results_json),
        started_at=r.started_at, completed_at=r.completed_at,
    )


def _validate_testcase_ids(testcase_ids: list[int], session: Session):
    if not testcase_ids:
        return
    found = set(session.exec(select(TestCase.id).where(TestCase.id.in_(testcase_ids))).all())
    missing = [i for i in testcase_ids if i not in found]
    if missing:
        raise HTTPException(status_code=400, detail=f"unknown testcase id(s): {missing}")


@router.get("", response_model=list[TestSuiteOut])
def list_testsuites(q: str = "", tag: str = "", session: Session = Depends(get_session)):
    suites = session.exec(select(TestSuite).order_by(TestSuite.updated_at.desc())).all()
    if q:
        ql = q.lower()
        suites = [s for s in suites if ql in s.name.lower() or ql in s.description.lower()]
    if tag:
        suites = [s for s in suites if tag in s.tags]
    return [_testsuite_to_out(s) for s in suites]


@router.post("", response_model=TestSuiteOut)
def create_testsuite(req: TestSuiteRequest, session: Session = Depends(get_session)):
    _validate_testcase_ids(req.testcase_ids, session)
    suite = TestSuite(
        name=req.name, description=req.description, tags_json=json.dumps(req.tags),
        author=req.author, stop_on_failure=req.stop_on_failure,
        testcase_ids_json=json.dumps(req.testcase_ids),
    )
    session.add(suite)
    session.commit()
    session.refresh(suite)
    return _testsuite_to_out(suite)


# Declared ahead of GET/PUT/DELETE /{testsuite_id} below - same reasoning as
# routers/TestCases.py's /runs routes (a literal "/runs" path would
# otherwise be shadowed by {testsuite_id} matching it as a literal id).

@router.get("/runs", response_model=list[TestSuiteRunOut])
def list_suite_runs(limit: int = 50, session: Session = Depends(get_session)):
    runs = session.exec(select(TestSuiteRun).order_by(TestSuiteRun.started_at.desc()).limit(limit)).all()
    return [_suite_run_to_out(r) for r in runs]


@router.get("/runs/{run_id}", response_model=TestSuiteRunOut)
def get_suite_run(run_id: int, session: Session = Depends(get_session)):
    run = session.get(TestSuiteRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return _suite_run_to_out(run)


@router.delete("/runs/{run_id}")
def delete_suite_run(run_id: int, session: Session = Depends(get_session)):
    """Deletes the suite run's own record only - the individual TestRun rows
    it launched (each results entry's run_id) are left in place, same as
    they'd be if the testcases had been run standalone; delete those
    separately via DELETE /testcases/runs/{run_id} if wanted."""
    run = session.get(TestSuiteRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    session.delete(run)
    session.commit()
    return {"deleted": run_id}


@router.get("/{testsuite_id}", response_model=TestSuiteOut)
def get_testsuite(testsuite_id: int, session: Session = Depends(get_session)):
    suite = session.get(TestSuite, testsuite_id)
    if suite is None:
        raise HTTPException(status_code=404, detail="Testsuite not found")
    return _testsuite_to_out(suite)


@router.put("/{testsuite_id}", response_model=TestSuiteOut)
def update_testsuite(testsuite_id: int, req: TestSuiteRequest, session: Session = Depends(get_session)):
    """Overwrite-on-save - no versioning for v1, same as TestCase."""
    suite = session.get(TestSuite, testsuite_id)
    if suite is None:
        raise HTTPException(status_code=404, detail="Testsuite not found")
    _validate_testcase_ids(req.testcase_ids, session)
    suite.name = req.name
    suite.description = req.description
    suite.tags_json = json.dumps(req.tags)
    suite.author = req.author
    suite.stop_on_failure = req.stop_on_failure
    suite.testcase_ids_json = json.dumps(req.testcase_ids)
    suite.updated_at = datetime.now(timezone.utc)
    session.add(suite)
    session.commit()
    session.refresh(suite)
    return _testsuite_to_out(suite)


@router.post("/{testsuite_id}/duplicate", response_model=TestSuiteOut)
def duplicate_testsuite(testsuite_id: int, session: Session = Depends(get_session)):
    src = session.get(TestSuite, testsuite_id)
    if src is None:
        raise HTTPException(status_code=404, detail="Testsuite not found")
    copy = TestSuite(
        name=f"{src.name} (copy)", description=src.description, tags_json=src.tags_json,
        author=src.author, stop_on_failure=src.stop_on_failure, testcase_ids_json=src.testcase_ids_json,
    )
    session.add(copy)
    session.commit()
    session.refresh(copy)
    return _testsuite_to_out(copy)


@router.delete("/{testsuite_id}")
def delete_testsuite(testsuite_id: int, session: Session = Depends(get_session)):
    suite = session.get(TestSuite, testsuite_id)
    if suite is None:
        raise HTTPException(status_code=404, detail="Testsuite not found")
    session.delete(suite)
    session.commit()
    return {"deleted": testsuite_id}


# --- run engine ------------------------------------------------------------
# Runs each referenced testcase, in order, on this same background thread -
# _run_testcase (routers/TestCases.py) already blocks until that one
# testcase's run finishes, so calling it directly here (rather than firing
# each testcase's own /run endpoint and polling it separately) gets
# sequencing and stop-on-failure for free.

def _run_testsuite(suite_run_id: int):
    with get_session_direct() as session:
        suite_run = session.get(TestSuiteRun, suite_run_id)
        if suite_run is None:
            return
        testcase_ids = json.loads(suite_run.testcase_ids_json)
        stop_on_failure = suite_run.stop_on_failure

    results = []
    overall_passed = True

    for tc_id in testcase_ids:
        with get_session_direct() as session:
            testcase = session.get(TestCase, tc_id)
            if testcase is None:
                # Referenced testcase was deleted after this suite was
                # saved/launched - record it as a failed entry (no run to
                # point at) rather than crashing the whole suite run.
                results.append({
                    "testcase_id": tc_id, "testcase_name": None, "run_id": None,
                    "status": "failed", "error": "testcase no longer exists",
                })
                overall_passed = False
                with get_session_direct() as s2:
                    r = s2.get(TestSuiteRun, suite_run_id)
                    if r is None:
                        return
                    r.results_json = json.dumps(results)
                    s2.add(r)
                    s2.commit()
                if stop_on_failure:
                    break
                continue

            run = TestRun(
                testcase_id=testcase.id, testcase_name=testcase.name,
                stop_on_failure=testcase.stop_on_failure, repeat_count=testcase.repeat_count,
                steps_json=testcase.steps_json, suite_run_id=suite_run_id,
            )
            session.add(run)
            session.commit()
            session.refresh(run)
            run_id, testcase_name = run.id, testcase.name

        # Recorded as "running" with its run_id already known *before*
        # _run_testcase is called, not just once it finishes - this is what
        # lets the live view (testsuites-tab.js/results-tab.js) drill into
        # the currently-executing testcase's own step-by-step progress
        # instead of only ever showing testcases that have already finished.
        entry = {"testcase_id": tc_id, "testcase_name": testcase_name, "run_id": run_id, "status": "running"}
        results.append(entry)
        with get_session_direct() as session:
            r = session.get(TestSuiteRun, suite_run_id)
            if r is None:
                return
            r.results_json = json.dumps(results)
            session.add(r)
            session.commit()

        _run_testcase(run_id)

        with get_session_direct() as session:
            finished = session.get(TestRun, run_id)
            # That testcase run was deleted mid-suite (see DELETE
            # /testcases/runs/{run_id}) - record it the same way a since-
            # deleted testcase is above, rather than crash on a None status.
            status = finished.status if finished is not None else "failed"

        entry["status"] = status
        if status != "passed":
            overall_passed = False

        with get_session_direct() as session:
            r = session.get(TestSuiteRun, suite_run_id)
            if r is None:
                return
            r.results_json = json.dumps(results)
            session.add(r)
            session.commit()

        if status != "passed" and stop_on_failure:
            break

    with get_session_direct() as session:
        r = session.get(TestSuiteRun, suite_run_id)
        if r is None:
            return
        r.status = "passed" if overall_passed else "failed"
        r.completed_at = datetime.now(timezone.utc)
        session.add(r)
        session.commit()


@router.post("/{testsuite_id}/run", response_model=TestSuiteRunOut)
def run_testsuite(testsuite_id: int, session: Session = Depends(get_session)):
    suite = session.get(TestSuite, testsuite_id)
    if suite is None:
        raise HTTPException(status_code=404, detail="Testsuite not found")
    suite_run = TestSuiteRun(
        testsuite_id=suite.id, testsuite_name=suite.name,
        stop_on_failure=suite.stop_on_failure, testcase_ids_json=suite.testcase_ids_json,
    )
    session.add(suite_run)
    session.commit()
    session.refresh(suite_run)
    threading.Thread(target=_run_testsuite, args=(suite_run.id,), daemon=True).start()
    return _suite_run_to_out(suite_run)
