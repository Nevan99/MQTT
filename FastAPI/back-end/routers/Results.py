import csv
import io
import json
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlmodel import Session, select

from database.database import get_session
from database.models import TestCase, TestRun, TestSuite, TestSuiteRun
from schemas.schemas import ResultBulkRequest, ResultFlagsRequest
from service import run_control
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
