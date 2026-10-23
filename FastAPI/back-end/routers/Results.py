import bisect
import csv
import io
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlmodel import Session, select

from database.database import get_session
from database.models import TestCase, TestRun, TestSuite, TestSuiteRun
from schemas.schemas import ResultBulkRequest, ResultFlagsRequest
from service import run_control, run_logs
from service.auth import get_current_user
from routers.TestCases import _resolve_targets, _run_results

router = APIRouter(prefix="/results", tags=["results"], dependencies=[Depends(get_current_user)])

# --- Results tab: one filtered, paged list over both run kinds ---------------
# Modelled on CDRouter's Results page: a "Show" choice (owner + which set of
# runs - current, starred, by date, archived, locked), "Filters" (device,
# type, status, package name, testcase name, tags) and a sortable, paged
# table. Standalone testcase runs and testsuite runs live in separate tables
# with different shapes, so both are flattened into one row shape here and
# filtered/sorted/paged in Python - fine at this rig's scale (thousands of
# runs), and it keeps every filter working across both kinds identically.
#
# Mapping onto CDRouter's columns:
#   Package -> the testcase/testsuite the run executed
#   Device  -> the Pi(s) its steps target (a suite: the union over its testcases)
#   Owner   -> that testcase/testsuite's author (there's a single login, so
#              "who started it" would always be the same name)
#   Tags    -> that testcase/testsuite's tags
# Owner/tags/devices come from the testcase/testsuite as it is *now* - runs
# don't snapshot them.
#
# Testcase runs launched by a suite are left out (suite_run_id set), same as
# GET /testcases/runs: the suite run's own row stands for them.

VIEWS = ("current", "starred", "date", "archived", "locked", "all")
SORTS = ("date", "id", "package", "kind", "status", "time", "owner")
BULK_ACTIONS = {
    "star": ("starred", True), "unstar": ("starred", False),
    "archive": ("archived", True), "unarchive": ("archived", False),
    "lock": ("locked", True), "unlock": ("locked", False),
}
KINDS = {"testcase": TestRun, "testsuite": TestSuiteRun}
FREQUENT_PACKAGES = 10


def _targets_of(steps: list) -> set:
    found = set()
    for step in steps:
        for t in _resolve_targets(step):
            if t:
                found.add(str(t))
    return found


def _as_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _duration_s(started, completed) -> Optional[float]:
    if started is None or completed is None:
        return None
    return max(0.0, (_as_utc(completed) - _as_utc(started)).total_seconds())


def _all_rows(session: Session) -> list[dict]:
    """Every listable run as one flat dict, without either table's big
    results_json except a suite's (one small entry per testcase)."""
    testcases = {
        t.id: t for t in session.exec(select(TestCase)).all()
    }
    tc_meta = {
        tid: {"name": t.name, "author": t.author or "", "tags": t.tags, "devices": _targets_of(t.steps)}
        for tid, t in testcases.items()
    }
    suites = {s.id: s for s in session.exec(select(TestSuite)).all()}

    rows = []
    tc_cols = session.exec(select(
        TestRun.id, TestRun.testcase_id, TestRun.testcase_name, TestRun.status,
        TestRun.started_at, TestRun.completed_at, TestRun.steps_json,
        TestRun.starred, TestRun.archived, TestRun.locked,
    ).where(TestRun.suite_run_id.is_(None))).all()
    for (rid, tc_id, name, status, started, completed, steps_json,
         starred, archived, locked) in tc_cols:
        meta = tc_meta.get(tc_id, {})
        rows.append({
            "kind": "testcase", "id": rid, "source_id": tc_id, "name": name,
            "status": status, "started_at": _as_utc(started), "completed_at": _as_utc(completed),
            # The run's own snapshot of its steps, not the testcase as it is now.
            "devices": sorted(_targets_of(json.loads(steps_json or "[]"))),
            "owner": meta.get("author", ""), "tags": meta.get("tags", []),
            "testcase_names": [name],
            "starred": bool(starred), "archived": bool(archived), "locked": bool(locked),
        })

    ts_cols = session.exec(select(
        TestSuiteRun.id, TestSuiteRun.testsuite_id, TestSuiteRun.testsuite_name, TestSuiteRun.status,
        TestSuiteRun.started_at, TestSuiteRun.completed_at, TestSuiteRun.testcase_ids_json,
        TestSuiteRun.results_json, TestSuiteRun.starred, TestSuiteRun.archived, TestSuiteRun.locked,
    )).all()
    for (rid, ts_id, name, status, started, completed, ids_json, results_json,
         starred, archived, locked) in ts_cols:
        suite = suites.get(ts_id)
        tc_ids = json.loads(ids_json or "[]")
        results = json.loads(results_json or "[]")
        devices = set()
        names = []
        for tc_id in tc_ids:
            meta = tc_meta.get(tc_id)
            if meta:
                devices |= meta["devices"]
                names.append(meta["name"])
        names += [e.get("testcase_name") for e in results if e.get("testcase_name")]
        rows.append({
            "kind": "testsuite", "id": rid, "source_id": ts_id, "name": name,
            "status": status, "started_at": _as_utc(started), "completed_at": _as_utc(completed),
            "devices": sorted(devices),
            "owner": (suite.author or "") if suite else "", "tags": suite.tags if suite else [],
            "testcase_names": names, "testcase_count": len(tc_ids),
            # A suite's pass/fail is per testcase, straight from its results.
            "passed": sum(1 for e in results if e.get("status") == "passed"),
            "failed": sum(1 for e in results if e.get("status") in ("failed", "timeout")),
            "starred": bool(starred), "archived": bool(archived), "locked": bool(locked),
        })
    return rows


def _in_view(row: dict, view: str) -> bool:
    if view == "starred":
        return row["starred"]
    if view == "archived":
        return row["archived"]
    if view == "locked":
        return row["locked"]
    if view == "all":
        return True
    return not row["archived"]          # current, date


def _parse_date(value: str, end: bool) -> Optional[datetime]:
    if not value:
        return None
    try:
        d = datetime.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"bad date: {value!r} (want YYYY-MM-DD)")
    if end and len(value) <= 10:
        d = d.replace(hour=23, minute=59, second=59)
    return _as_utc(d)


def _matches(row: dict, f: dict) -> bool:
    if f["owner"] and row["owner"] != f["owner"]:
        return False
    if f["device"] and f["device"] not in row["devices"]:
        return False
    if f["kind"] and row["kind"] != f["kind"]:
        return False
    if f["status"] and row["status"] != f["status"]:
        return False
    if f["package"] and f["package"] not in (row["name"] or "").lower():
        return False
    if f["testcase"] and not any(f["testcase"] in (n or "").lower() for n in row["testcase_names"]):
        return False
    if f["tags"] and not set(f["tags"]).issubset(row["tags"]):
        return False
    started = row["started_at"]
    if f["date_from"] and (started is None or started < f["date_from"]):
        return False
    if f["date_to"] and (started is None or started > f["date_to"]):
        return False
    return True


def _sort_key(sort: str):
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    return {
        "date": lambda r: r["started_at"] or epoch,
        "id": lambda r: r["id"],
        "package": lambda r: (r["name"] or "").lower(),
        "kind": lambda r: r["kind"],
        "status": lambda r: r["status"],
        "time": lambda r: _duration_s(r["started_at"], r["completed_at"]) or 0,
        "owner": lambda r: r["owner"].lower(),
    }[sort]


def _testcase_pass_fail(session: Session, run_id: int) -> tuple[int, int]:
    """Step-level counts for one testcase run - only computed for the rows on
    the page, since results_json can be large for a looped run."""
    run = session.get(TestRun, run_id)
    if run is None:
        return 0, 0
    results, live = _run_results(run)
    entries = list(results) if live is None else _locked_copy(results, live)
    return (
        sum(1 for e in entries if e.get("status") == "passed"),
        sum(1 for e in entries if e.get("status") in ("failed", "timeout")),
    )


def _locked_copy(results, live):
    with live.lock:
        return list(results)


def _out(row: dict, session: Session) -> dict:
    if row["kind"] == "testcase":
        passed, failed = _testcase_pass_fail(session, row["id"])
    else:
        passed, failed = row["passed"], row["failed"]
    return {
        "kind": row["kind"], "id": row["id"], "source_id": row["source_id"], "name": row["name"],
        "status": row["status"], "started_at": row["started_at"], "completed_at": row["completed_at"],
        "duration_s": _duration_s(row["started_at"], row["completed_at"]),
        "devices": row["devices"], "owner": row["owner"], "tags": row["tags"],
        "passed": passed, "failed": failed, "testcase_count": row.get("testcase_count"),
        "starred": row["starred"], "archived": row["archived"], "locked": row["locked"],
    }


def _facets(rows: list[dict]) -> dict:
    """What the sidebar offers, over every run in the current Show view
    (not narrowed by the other filters, so a choice never hides itself)."""
    tags, packages = {}, {}
    for r in rows:
        for t in r["tags"]:
            tags[t] = tags.get(t, 0) + 1
        key = (r["kind"], r["name"])
        packages[key] = packages.get(key, 0) + 1
    return {
        # The sidebar's "Running now" shortcut - what the old Running tab listed.
        "running": sum(1 for r in rows if r["status"] == "running"),
        "owners": sorted({r["owner"] for r in rows if r["owner"]}, key=str.lower),
        "devices": sorted({d for r in rows for d in r["devices"]}, key=str.lower),
        "tags": [{"tag": t, "count": n} for t, n in sorted(tags.items(), key=lambda kv: (-kv[1], kv[0].lower()))],
        "packages": [
            {"kind": k, "name": name, "count": n}
            for (k, name), n in sorted(packages.items(), key=lambda kv: -kv[1])[:FREQUENT_PACKAGES]
        ],
    }


def _query(session, view, owner, device, kind, status, package, testcase, tags, date_from, date_to):
    if view not in VIEWS:
        raise HTTPException(status_code=400, detail=f"view must be one of {VIEWS}")
    f = {
        "owner": owner, "device": device, "kind": kind, "status": status,
        "package": package.strip().lower(), "testcase": testcase.strip().lower(),
        "tags": [t for t in (x.strip() for x in tags.split(",")) if t],
        "date_from": _parse_date(date_from, end=False), "date_to": _parse_date(date_to, end=True),
    }
    in_view = [r for r in _all_rows(session) if _in_view(r, view)]
    return in_view, [r for r in in_view if _matches(r, f)]


@router.get("")
def list_results(
    view: str = "current",
    owner: str = "", device: str = "", kind: str = "", status: str = "",
    package: str = "", testcase: str = "", tags: str = "",
    date_from: str = "", date_to: str = "",
    sort: str = "date", order: str = "desc",
    offset: int = 0, limit: int = 25,
    ids_only: bool = False,
    session: Session = Depends(get_session),
):
    """One page of runs matching the Show view + filters, plus the total
    match count and the sidebar's facets. ids_only=true returns just every
    matching run's key - kind, id, plus what the bulk actions need
    (source_id, status, locked) - for the pager's "select all N" link."""
    in_view, matched = _query(session, view, owner, device, kind, status, package, testcase,
                              tags, date_from, date_to)
    if sort not in SORTS:
        raise HTTPException(status_code=400, detail=f"sort must be one of {SORTS}")
    matched.sort(key=_sort_key(sort), reverse=(order != "asc"))
    if ids_only:
        return {"total": len(matched), "keys": [
            {"kind": r["kind"], "id": r["id"], "source_id": r["source_id"],
             "status": r["status"], "locked": r["locked"]}
            for r in matched
        ]}
    page = matched[max(0, offset):max(0, offset) + limit] if limit > 0 else matched[max(0, offset):]
    return {
        "total": len(matched), "offset": offset, "limit": limit,
        "items": [_out(r, session) for r in page],
        "facets": _facets(in_view),
    }


@router.get("/export.csv")
def export_results(
    view: str = "current",
    owner: str = "", device: str = "", kind: str = "", status: str = "",
    package: str = "", testcase: str = "", tags: str = "",
    date_from: str = "", date_to: str = "",
    sort: str = "date", order: str = "desc",
    session: Session = Depends(get_session),
):
    """Every run matching the same view + filters as GET /results, as CSV."""
    _, matched = _query(session, view, owner, device, kind, status, package, testcase,
                        tags, date_from, date_to)
    if sort not in SORTS:
        raise HTTPException(status_code=400, detail=f"sort must be one of {SORTS}")
    matched.sort(key=_sort_key(sort), reverse=(order != "asc"))
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["date", "id", "type", "package", "device", "status", "pass", "fail",
                "time_s", "owner", "tags", "starred", "archived", "locked"])
    for r in matched:
        o = _out(r, session)
        w.writerow([
            o["started_at"].isoformat() if o["started_at"] else "", o["id"], o["kind"], o["name"],
            " ".join(o["devices"]), o["status"], o["passed"], o["failed"],
            round(o["duration_s"]) if o["duration_s"] is not None else "",
            o["owner"], " ".join(o["tags"]), o["starred"], o["archived"], o["locked"],
        ])
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return Response(
        content=buf.getvalue(), media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="results-{stamp}.csv"'},
    )


def _get_run(session: Session, kind: str, run_id: int):
    model = KINDS.get(kind)
    if model is None:
        raise HTTPException(status_code=400, detail=f"kind must be one of {tuple(KINDS)}")
    return session.get(model, run_id)


@router.patch("/{kind}/{run_id}")
def set_result_flags(kind: str, run_id: int, req: ResultFlagsRequest, session: Session = Depends(get_session)):
    run = _get_run(session, kind, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    for field in ("starred", "archived", "locked"):
        value = getattr(req, field)
        if value is not None:
            setattr(run, field, value)
    session.add(run)
    session.commit()
    return {"kind": kind, "id": run_id, "starred": run.starred, "archived": run.archived, "locked": run.locked}


@router.post("/bulk")
def bulk_results(req: ResultBulkRequest, session: Session = Depends(get_session)):
    """Applies one toolbar action to every listed run. Runs that no longer
    exist are skipped (a selection is a snapshot of the table), and delete
    skips locked runs rather than failing the rest - the response says how
    many of each so the UI can tell the user."""
    if req.action != "delete" and req.action not in BULK_ACTIONS:
        raise HTTPException(status_code=400, detail=f"action must be delete or one of {tuple(BULK_ACTIONS)}")
    done, missing, locked = 0, 0, 0
    for key in req.items:
        run = _get_run(session, key.kind, key.id)
        if run is None:
            missing += 1
            continue
        if req.action == "delete":
            if run.locked:
                locked += 1
                continue
            # Same as the single-run DELETE endpoints: stop it before the row goes.
            if key.kind == "testcase":
                run_control.request_run_stop(run.id, run_control.STOP_NOW)
                run_logs.delete(run.id)
            else:
                run_control.request_suite_stop(run.id, run_control.STOP_NOW)
            session.delete(run)
        else:
            field, value = BULK_ACTIONS[req.action]
            setattr(run, field, value)
            session.add(run)
        done += 1
    session.commit()
    return {"action": req.action, "done": done, "missing": missing, "skipped_locked": locked}


# --- one run's tests (CDRouter's result page) --------------------------------
# A run is shown the way CDRouter shows one result: a summary (status,
# progress, pass/fail/time) over a filterable, paged list of its "tests" -
# a testsuite run's testcases, or a testcase run's step executions (one per
# step x repeat x loop pass, in execution order). Used for live runs too, so
# the Results tab is also where a running testcase/testsuite is watched.

TEST_FILTERS = ("all", "run", "passed", "failed", "skipped", "pending", "running", "stopped")
FAILED_STATUSES = ("failed", "timeout")


def _test_matches(t: dict, status: str, q: str) -> bool:
    st = t["status"]
    if status == "run" and st in ("pending", "skipped"):
        return False
    if status == "failed" and st not in FAILED_STATUSES:
        return False
    if status not in ("all", "run", "failed") and st != status:
        return False
    if q and q not in t["name"].lower() and q not in t["description"].lower():
        return False
    return True


def _params_text(params: dict) -> str:
    bits = []
    for k, v in (params or {}).items():
        if v in (None, "", [], {}):
            continue
        text = v if isinstance(v, str) else json.dumps(v)
        bits.append(f"{k}={text if len(text) <= 40 else text[:37] + '...'}")
    return ", ".join(bits[:5]) + (", ..." if len(bits) > 5 else "")


def _target_text(step: dict) -> str:
    target = step.get("target")
    if target == "multicast":
        return ", ".join(step.get("target_pi_ids") or []) or "multicast"
    return "all Pis" if target in (None, "all") else str(target)


def _testcase_tests(run: TestRun) -> tuple[list, Optional[str]]:
    results, live = _run_results(run)
    entries = _locked_copy(results, live) if live is not None else list(results)
    steps = json.loads(run.steps_json or "[]")
    tests = []
    for i, e in enumerate(entries):
        idx = e.get("step_index")
        step = steps[idx] if isinstance(idx, int) and 0 <= idx < len(steps) else {}
        where = [f"-> {_target_text({**step, **{k: v for k, v in e.items() if k == 'target'}})}"]
        params = _params_text(e.get("params") or step.get("params") or {})
        if params:
            where.append(params)
        context = []
        if run.repeat_count > 1:
            context.append(f"pass {e.get('pass_index', 0) + 1}/{run.repeat_count}")
        if e.get("loop_group") and (e.get("loop_count") or 1) > 1:
            context.append(f"loop {e['loop_group']} {(e.get('loop_pass') or 0) + 1}/{e['loop_count']}")
        if (step.get("repeat_count") or 1) > 1:
            context.append(f"repeat {e.get('iteration', 1)}/{step['repeat_count']}")
        tests.append({
            "seq": i + 1, "name": f"#{(idx if isinstance(idx, int) else 0) + 1} {e.get('action') or '?'}",
            "description": " · ".join(where + context),
            "status": e.get("status", "pending"),
            "duration_s": (e["duration_ms"] / 1000) if e.get("duration_ms") is not None else None,
            "step_index": idx, "run_id": None,
            "error": e.get("error"),
        })
    current = None
    if live is not None and live.current is not None and 0 <= live.current < len(tests):
        current = tests[live.current]["name"]
    return tests, current


def _suite_tests(session: Session, run: TestSuiteRun) -> tuple[list, Optional[str]]:
    results = json.loads(run.results_json or "[]")
    if not results:   # not started yet: the plan, all pending
        results = [{"testcase_id": t, "status": "pending", "run_id": None}
                   for t in json.loads(run.testcase_ids_json or "[]")]
    tc_ids = [e.get("testcase_id") for e in results]
    testcases = {
        t.id: t for t in session.exec(select(TestCase).where(TestCase.id.in_(tc_ids))).all()
    } if tc_ids else {}
    child_ids = [e["run_id"] for e in results if e.get("run_id")]
    children = {
        rid: (started, completed)
        for rid, started, completed in session.exec(
            select(TestRun.id, TestRun.started_at, TestRun.completed_at).where(TestRun.id.in_(child_ids))
        ).all()
    } if child_ids else {}
    now = datetime.now(timezone.utc)
    tests, current = [], None
    for i, e in enumerate(results):
        tc = testcases.get(e.get("testcase_id"))
        child = children.get(e.get("run_id"))
        duration = None
        if child is not None:
            duration = _duration_s(child[0], child[1] or (now if e.get("status") == "running" else None))
        name = e.get("testcase_name") or (tc.name if tc else f"testcase #{e.get('testcase_id')}")
        if e.get("status") == "running":
            current = name
        tests.append({
            "seq": i + 1, "name": name,
            "description": (tc.description if tc and tc.description else ""),
            "status": e.get("status", "pending"), "duration_s": duration,
            "testcase_id": e.get("testcase_id"), "run_id": e.get("run_id"),
            "error": e.get("error"),
        })
    return tests, current


def _run_tests(session: Session, kind: str, run) -> tuple[list, Optional[str]]:
    return _testcase_tests(run) if kind == "testcase" else _suite_tests(session, run)


def _run_summary(session: Session, kind: str, run, tests: list, current: Optional[str]) -> dict:
    counts = {}
    for t in tests:
        key = "failed" if t["status"] in FAILED_STATUSES else t["status"]
        counts[key] = counts.get(key, 0) + 1
    total = len(tests)
    done = total - counts.get("pending", 0) - counts.get("running", 0)
    if kind == "testcase":
        source = session.get(TestCase, run.testcase_id)
        name, source_id = run.testcase_name, run.testcase_id
        steps = json.loads(run.steps_json or "[]")
        devices = sorted(_targets_of(steps))
        stop_mode = run_control.run_stop_mode(run.id)
        live = run_control.get_run(run.id) is not None
        extra = {"repeat_count": run.repeat_count, "step_count": len(steps), "suite_run_id": run.suite_run_id}
    else:
        source = session.get(TestSuite, run.testsuite_id)
        name, source_id = run.testsuite_name, run.testsuite_id
        tc_ids = json.loads(run.testcase_ids_json or "[]")
        found = set()
        if tc_ids:
            for tc in session.exec(select(TestCase).where(TestCase.id.in_(tc_ids))).all():
                found |= _targets_of(tc.steps)
        devices = sorted(found)
        suite_live = run_control.get_suite(run.id)
        stop_mode = suite_live.stop_mode if suite_live is not None else None
        live = suite_live is not None
        extra = {"testcase_count": len(tc_ids)}
    started, completed = _as_utc(run.started_at), _as_utc(run.completed_at)
    now = datetime.now(timezone.utc)
    return {
        "kind": kind, "id": run.id, "source_id": source_id, "name": name,
        "description": (source.description if source else "") or "",
        "status": run.status, "started_at": started, "completed_at": completed,
        "duration_s": _duration_s(started, completed or (now if run.status == "running" else None)),
        "total": total, "done": done,
        "progress": round(100 * done / total) if total else (0 if run.status == "running" else 100),
        "counts": counts, "current": current,
        "devices": devices, "owner": (source.author if source else "") or "",
        "tags": source.tags if source else [],
        "stop_on_failure": run.stop_on_failure, "stop_requested": stop_mode, "live": live,
        "starred": run.starred, "archived": run.archived, "locked": run.locked,
        "source_exists": source is not None,
        **extra,
    }


@router.get("/{kind}/{run_id}/tests")
def get_result_tests(
    kind: str, run_id: int,
    status: str = "all", q: str = "",
    offset: int = 0, limit: int = 25,
    around_seq: Optional[int] = None,
    session: Session = Depends(get_session),
):
    """One run's summary plus one page of its tests matching the status
    filter and name/description search. around_seq moves to the page that
    holds that test (Jump to / Prev / Next Failure); failure_seqs lists every
    failed test's seq in the filtered order, for that navigation."""
    run = _get_run(session, kind, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if status not in TEST_FILTERS:
        raise HTTPException(status_code=400, detail=f"status must be one of {TEST_FILTERS}")
    tests, current = _run_tests(session, kind, run)
    summary = _run_summary(session, kind, run, tests, current)
    needle = q.strip().lower()
    matched = [t for t in tests if _test_matches(t, status, needle)]
    if around_seq is not None and limit > 0:
        pos = next((i for i, t in enumerate(matched) if t["seq"] == around_seq), None)
        if pos is not None:
            offset = (pos // limit) * limit
    offset = max(0, offset)
    page = matched[offset:offset + limit] if limit > 0 else matched[offset:]
    return {
        "summary": summary, "total": len(matched), "offset": offset, "limit": limit,
        "items": page,
        "failure_seqs": [t["seq"] for t in matched if t["status"] in FAILED_STATUSES],
        "names": sorted({t["name"] for t in tests}, key=str.lower)[:500],
    }


@router.get("/{kind}/{run_id}/tests.csv")
def export_result_tests(kind: str, run_id: int, session: Session = Depends(get_session)):
    """Every test of one run as CSV (the result page's "Export as CSV")."""
    run = _get_run(session, kind, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    tests, _ = _run_tests(session, kind, run)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["seq", "status", "time_s", "test_name", "description", "error"])
    for t in tests:
        w.writerow([t["seq"], t["status"], round(t["duration_s"], 1) if t["duration_s"] is not None else "",
                    t["name"], t["description"], t.get("error") or ""])
    return Response(
        content=buf.getvalue(), media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{kind}-run-{run_id}-tests.csv"'},
    )


# --- one test's log (CDRouter's test log page) -------------------------------
# A test's log is the syslog its Pis produced while it ran (captured per run
# by service/run_logs.py), grouped under one SECTION per step execution and
# closed by PASS/FAIL lines for each Pi's result and the step itself. For a
# testcase run a test is one step execution; for a testsuite run it's one
# testcase, so its log is that testcase run's whole log, step by step.

SYSLOG_GRACE_SECONDS = 1.5   # lines that arrive just after a step's result
_JOURNAL_RE = re.compile(r"^[A-Z][a-z]{2}\s+\d+\s+\d\d:\d\d:\d\d\s+(\S+)\s+([^:]+):\s?(.*)$")
_ERROR_RE = re.compile(r"\b(error|exception|traceback|failed|critical)\b", re.I)
_WARN_RE = re.compile(r"\bwarn(ing)?\b", re.I)


def _parse_dt(value) -> Optional[datetime]:
    if not value:
        return None
    try:
        return _as_utc(datetime.fromisoformat(value) if isinstance(value, str) else value)
    except ValueError:
        return None


def _syslog_line(rec: dict) -> dict:
    m = _JOURNAL_RE.match(rec["line"])
    text = f"{m.group(2)}: {m.group(3)}" if m else rec["line"]
    level = "error" if _ERROR_RE.search(text) else ("warning" if _WARN_RE.search(text) else "info")
    return {"t": rec["t"], "kind": "syslog", "level": level, "src": rec["pi"], "text": text}


def _step_label(e: dict, steps: list) -> tuple[str, dict]:
    idx = e.get("step_index")
    step = steps[idx] if isinstance(idx, int) and 0 <= idx < len(steps) else {}
    target = _target_text({**step, **({"target": e["target"]} if e.get("target") else {})})
    return f"Step {(idx if isinstance(idx, int) else 0) + 1}: {e.get('action') or step.get('action') or '?'} -> {target}", step


class _SyslogIndex:
    """A run's captured syslog, sorted by arrival once, so each step finds
    its time window by binary search instead of scanning every line - a
    testcase repeated hundreds of times would otherwise rescan the whole
    log once per step execution."""

    def __init__(self, records: list):
        self.records = sorted(records, key=lambda r: r["t"])
        self.times = [r["t"] for r in self.records]
        self.pis = {r["pi"] for r in self.records}

    def window(self, start, until, next_start=None) -> list:
        """Lines with start <= t <= until, stopping before next_start (a line
        stamped that very instant belongs to the next step)."""
        lo = bisect.bisect_left(self.times, start)
        hi = bisect.bisect_right(self.times, until)
        if next_start is not None:
            hi = min(hi, bisect.bisect_left(self.times, next_start))
        return self.records[lo:hi] if hi > lo else []


def _step_pis(e: dict, step: dict, captured: set) -> set:
    pis = {str(x["pi_id"]) for x in (e.get("entries") or []) if x.get("pi_id")}
    if pis:
        return pis
    targets = set(_resolve_targets({**step, **({"target": e["target"]} if e.get("target") else {})}))
    return captured if "all" in targets or not targets else {str(t) for t in targets}


def _step_log_lines(e: dict, steps: list, syslog: "_SyslogIndex", now: datetime,
                    next_start: Optional[datetime] = None) -> list:
    """One step execution: SECTION, its Pis' syslog in its window, then a
    PASS/FAIL line per Pi result and one for the step. The window runs a
    little past the step's result (late-arriving lines) but never into the
    next step."""
    label, step = _step_label(e, steps)
    status = e.get("status", "pending")
    start = _parse_dt(e.get("started_at"))
    end = _parse_dt(e.get("completed_at"))
    lines = [{"t": start, "kind": "section", "level": "info", "src": None, "status": status,
              "text": label + ("" if start else f" ({status})")}]
    if start is not None:
        until = (end + timedelta(seconds=SYSLOG_GRACE_SECONDS)) if end else now
        pis = _step_pis(e, step, syslog.pis)
        lines += [_syslog_line(r) for r in syslog.window(start, until, next_start) if r["pi"] in pis]
    for x in e.get("entries") or []:
        who = x.get("pi_id") or "?"
        if x.get("interface"):
            who = f"{who}/{x['interface']}"
        st = x.get("status", "")
        if not x.get("pi_id") and x.get("error"):
            lines.append({"t": end, "kind": "fail", "level": "error", "src": None, "text": f"FAIL: {x['error']}"})
            continue
        took = f" in {x['duration_ms'] / 1000:.1f}s" if x.get("duration_ms") is not None else ""
        detail = x.get("reason") or x.get("error") or ""
        lines.append({
            "t": _parse_dt(x.get("completed_at")) or end, "kind": "pass" if st == "passed" else "fail",
            "level": "info" if st == "passed" else "error", "src": x.get("pi_id"),
            "text": f"{'PASS' if st == 'passed' else 'FAIL'}: {who} {st}{took}{f' - {detail}' if detail else ''}",
        })
        for c in x.get("checks") or []:
            ok = c.get("passed")
            lines.append({
                "t": _parse_dt(x.get("completed_at")) or end, "kind": "pass" if ok else "fail",
                "level": "info" if ok else "error", "src": x.get("pi_id"),
                "text": f"{'PASS' if ok else 'FAIL'}: {who} check {c.get('field') or '<result>'} {c.get('op')} "
                        f"{c.get('value')!r} (actual {c.get('actual')!r})",
            })
    if status in ("passed", "failed", "timeout", "stopped"):
        took = f" ({e['duration_ms'] / 1000:.1f}s)" if e.get("duration_ms") is not None else ""
        lines.append({"t": end, "kind": "pass" if status == "passed" else "fail",
                      "level": "info" if status == "passed" else "error", "src": None,
                      "text": f"{'PASS' if status == 'passed' else 'FAIL'}: {label} {status}{took}"})
    elif status == "running":
        lines.append({"t": None, "kind": "info", "level": "info", "src": None, "text": "... still running"})
    # Syslog sorted by arrival; the section opens first and results close it.
    head, body = lines[0], lines[1:]
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    body.sort(key=lambda ln: (ln["kind"] not in ("syslog",) and ln["t"] is None, ln["t"] or epoch,
                              0 if ln["kind"] == "syslog" else 1))
    head["count"] = len(body)
    return [head] + body


def _step_header(steps: list, e: Optional[dict] = None) -> list:
    """The step definition(s), the way CDRouter opens a log with the test's
    description."""
    def fmt(i, step):
        out = [f"    step {i + 1}. {step.get('action', '?')} -> {_target_text(step)}"]
        for k, v in (step.get("params") or {}).items():
            if v not in (None, "", [], {}):
                out.append(f"            {k} = {v if isinstance(v, str) else json.dumps(v)}")
        exp = step.get("expected")
        for x in (exp if isinstance(exp, list) else [exp] if exp else []):
            out.append(f"            expect {x.get('field') or '<result>'} {x.get('op', 'eq')} {x.get('value')!r}")
        if (step.get("repeat_count") or 1) > 1:
            out.append(f"            repeat x{step['repeat_count']}")
        return out
    if e is not None:
        idx = e.get("step_index")
        if isinstance(idx, int) and 0 <= idx < len(steps):
            return fmt(idx, steps[idx])
        return []
    out = []
    for i, step in enumerate(steps):
        out += fmt(i, step)
    return out


def _build_test_log(session: Session, kind: str, run_id: int, seq: int) -> dict:
    """Everything one test's log is made of: the description header, any
    lines before the first step (a note for a test that never ran), and one
    section per step execution - each its SECTION line plus body."""
    run = _get_run(session, kind, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    tests, _ = _run_tests(session, kind, run)
    if not 1 <= seq <= len(tests):
        raise HTTPException(status_code=404, detail="No such test in this run")
    test = tests[seq - 1]
    now = datetime.now(timezone.utc)
    rule = "-" * 78
    header = [rule]
    lines = []
    if kind == "testcase":
        results, live = _run_results(run)
        entries = _locked_copy(results, live) if live is not None else list(results)
        e = entries[seq - 1]
        steps = json.loads(run.steps_json or "[]")
        testcase = session.get(TestCase, run.testcase_id)
        header += [f"Test: {test['name']}  ({test['description']})",
                   f"Testcase: {run.testcase_name} - run #{run.id}"]
        if testcase and testcase.description:
            header.append(f"Description: {testcase.description}")
        header += ["", *_step_header(steps, e)]
        nxt = _parse_dt(entries[seq].get("started_at")) if seq < len(entries) else None
        lines = _step_log_lines(e, steps, _SyslogIndex(run_logs.read(run.id)), now, nxt)
        log_running = run.status == "running"
    else:
        child = session.get(TestRun, test["run_id"]) if test.get("run_id") else None
        testcase = session.get(TestCase, test["testcase_id"]) if test.get("testcase_id") else None
        header += [f"Test: {test['name']}", f"Testsuite: {run.testsuite_name} - run #{run.id}"
                   + (f", testcase run #{child.id}" if child else "")]
        if testcase and testcase.description:
            header.append(f"Description: {testcase.description}")
        steps = json.loads(child.steps_json or "[]") if child else (testcase.steps if testcase else [])
        if steps:
            header += ["", *_step_header(steps)]
        if child is not None:
            results, live = _run_results(child)
            entries = _locked_copy(results, live) if live is not None else list(results)
            syslog = _SyslogIndex(run_logs.read(child.id))
            for i, e in enumerate(entries):
                if e.get("status") == "pending":
                    continue
                nxt = _parse_dt(entries[i + 1].get("started_at")) if i + 1 < len(entries) else None
                lines += _step_log_lines(e, steps, syslog, now, nxt)
            log_running = child.status == "running"
        else:
            note = test.get("error") or ("not run yet" if test["status"] == "pending" else f"{test['status']} - nothing ran")
            lines.append({"t": None, "kind": "info", "level": "info", "src": None, "text": note})
            log_running = False
    header.append(rule)

    preamble, sections = [], []
    for ln in lines:
        if ln["kind"] == "section":
            sections.append({"head": ln, "body": []})
        elif sections:
            sections[-1]["body"].append(ln)
        else:
            preamble.append(ln)
    return {
        "kind": kind, "run": run, "test": test, "total": len(tests),
        "running": log_running or test["status"] == "running",
        "header": header, "preamble": preamble, "sections": sections,
    }


def _flat_lines(data: dict) -> list:
    out = [_line_out(ln) for ln in data["preamble"]]
    for sec in data["sections"]:
        out.append(_line_out(sec["head"]))
        out += [_line_out(ln) for ln in sec["body"]]
    return out


def _line_out(ln: dict) -> dict:
    return {**ln, "t": ln["t"].isoformat() if ln["t"] else None}


# A test with this many sections or fewer sends them all at once; past that
# the page opens with the outline and loads a section when it's expanded.
LOG_SECTIONS_ALL_UP_TO = 12
_SECTION_OPEN_STATUSES = ("failed", "timeout", "stopped", "running")


@router.get("/{kind}/{run_id}/tests/{seq}/log")
def get_test_log(kind: str, run_id: int, seq: int, sections: str = "", live: bool = False,
                 session: Session = Depends(get_session)):
    """One test's log as an outline: the description header, then one entry
    per step execution (title, status, line count, and its first line number
    so numbering stays the same whichever sections are loaded). Lines are
    included only for the sections asked for - `sections` is "all" or a
    comma list of indexes; by default every section of a short log, or for
    a long (repeated) one just the failed / stopped / running sections plus
    the first and the last. live=true also includes the running section
    and the last one (a page following a live test asks for what it has
    open plus wherever the test is now). Line records are {t, kind:
    section|syslog|pass|fail|info, level, src (Pi), text}."""
    data = _build_test_log(session, kind, run_id, seq)
    secs = data["sections"]
    if sections == "all" or (not sections and len(secs) <= LOG_SECTIONS_ALL_UP_TO):
        wanted = set(range(len(secs)))
    elif sections:
        try:
            wanted = {int(x) for x in sections.split(",") if x.strip()}
        except ValueError:
            raise HTTPException(status_code=400, detail="sections must be 'all' or a comma list of numbers")
    else:
        wanted = {i for i, sec in enumerate(secs) if sec["head"].get("status") in _SECTION_OPEN_STATUSES}
        if secs:
            wanted |= {0, len(secs) - 1}
    if live and secs:
        wanted |= {i for i, sec in enumerate(secs) if sec["head"].get("status") == "running"}
        wanted.add(len(secs) - 1)

    line_no = len(data["header"]) + len(data["preamble"])
    out_sections = []
    for i, sec in enumerate(secs):
        head = sec["head"]
        out_sections.append({
            "index": i, "first_line": line_no + 1, "count": len(sec["body"]),
            "text": head["text"], "status": head.get("status"),
            "t": head["t"].isoformat() if head["t"] else None,
            "has_fail": any(ln["kind"] == "fail" for ln in sec["body"]),
            "lines": [_line_out(ln) for ln in sec["body"]] if i in wanted else None,
        })
        line_no += 1 + len(sec["body"])

    run, test = data["run"], data["test"]
    return {
        "kind": kind, "run_id": run.id, "run_name": run.testcase_name if kind == "testcase" else run.testsuite_name,
        "run_status": run.status, "seq": seq, "total": data["total"],
        "test": test, "running": data["running"],
        "header": data["header"],
        "preamble": [_line_out(ln) for ln in data["preamble"]],
        "sections": out_sections,
        "pis": sorted({ln["src"] for sec in secs for ln in sec["body"] if ln.get("src")}),
        "line_count": line_no,
    }


@router.get("/{kind}/{run_id}/tests/{seq}/log.txt")
def download_test_log(kind: str, run_id: int, seq: int, session: Session = Depends(get_session)):
    """The whole log as plain text (the log page's Download), every section."""
    data = _build_test_log(session, kind, run_id, seq)
    out = list(data["header"])
    for ln in _flat_lines(data):
        stamp = ln["t"][:23].replace("T", " ") if ln["t"] else " " * 23
        tag = {"section": "SECTION", "syslog": f"SYSLOG({ln['src']})"}.get(ln["kind"], "")
        out.append(f"{stamp} {tag + ': ' if tag else ''}{ln['text']}")
    return Response(
        content="\n".join(out) + "\n", media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{kind}-run-{run_id}-test-{seq}.log"'},
    )
