"""Pi syslog captured per testcase run, for the Results tab's per-test log
page (routers/Results.py, CDRouter's "test log").

While a run executes, every syslog line any of its target Pis streams to the
backend (capture_socket_server._handle_stream_syslog) is appended to that
run's own file, stamped with the backend's receive time. A test's log is
then just the lines from its Pis inside its start/end window - step results
are timed on the same backend clock, so a Pi whose own clock is off doesn't
put its lines under the wrong step.

One JSON object per line: {"t": ISO time, "pi": pi_id, "line": raw text}.
Files live next to the other captures and are removed with their run.

State is in memory, guarded by one lock: socket handlers run on their own
threads, runs on theirs.
"""
import json
import threading
from datetime import datetime, timezone
from pathlib import Path

from service.recordings import CAPTURES_DIR

RUN_LOGS_DIR = CAPTURES_DIR / "run_logs"
RUN_LOGS_DIR.mkdir(exist_ok=True)

_lock = threading.Lock()
_files: dict[int, object] = {}          # run_id -> open file handle
_taps: dict[str, set[int]] = {}         # pi_id -> run_ids capturing it


def _path(run_id: int) -> Path:
    return RUN_LOGS_DIR / f"testrun-{run_id}.jsonl"


def start(run_id: int, pi_ids) -> None:
    """Begin capturing these Pis' syslog into run_id's file."""
    with _lock:
        if run_id not in _files:
            # "w", not "a": SQLite can reuse the id of a deleted newest run,
            # and a fresh run must not inherit an old file's lines.
            _files[run_id] = _path(run_id).open("w", encoding="utf-8")
        for pi in pi_ids:
            _taps.setdefault(str(pi), set()).add(run_id)


def stop(run_id: int) -> set[str]:
    """Stop capturing for run_id. Returns the Pis no other run is capturing
    any more (the caller may stop their stream)."""
    with _lock:
        released = set()
        for pi, runs in list(_taps.items()):
            if run_id in runs:
                runs.discard(run_id)
                if not runs:
                    del _taps[pi]
                    released.add(pi)
        fh = _files.pop(run_id, None)
    if fh is not None:
        fh.close()
    return released


def is_tapped(pi_id: str) -> bool:
    with _lock:
        return bool(_taps.get(str(pi_id)))


def append(pi_id: str, line: str) -> None:
    """One syslog line arrived from pi_id - file it under every run
    capturing that Pi."""
    with _lock:
        runs = _taps.get(str(pi_id))
        if not runs:
            return
        rec = json.dumps({"t": datetime.now(timezone.utc).isoformat(), "pi": pi_id, "line": line}) + "\n"
        for run_id in runs:
            fh = _files.get(run_id)
            if fh is not None:
                fh.write(rec)
                fh.flush()


def read(run_id: int) -> list[dict]:
    """Every captured line for run_id, oldest first, with "t" parsed."""
    path = _path(run_id)
    if not path.exists():
        return []
    out = []
    with path.open(encoding="utf-8") as fh:
        for raw in fh:
            try:
                rec = json.loads(raw)
                rec["t"] = datetime.fromisoformat(rec["t"])
            except (ValueError, KeyError, TypeError):
                continue
            out.append(rec)
    return out


def delete(run_id: int) -> None:
    stop(run_id)
    try:
        _path(run_id).unlink()
    except FileNotFoundError:
        pass
