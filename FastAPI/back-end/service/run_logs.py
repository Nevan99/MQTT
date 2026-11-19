"""Pi syslog and packets captured per testcase run, for the Results tab's
per-test log page (routers/Results.py, CDRouter's "test log").

While a run executes, every syslog line any of its target Pis streams to the
backend (capture_socket_server._handle_stream_syslog), and every packet off
the interfaces it asked to sniff (_handle_stream_tcpdump), is appended to
that run's own file, stamped with the backend's receive time. A test's log
is then just the records from its Pis inside its start/end window - step
results are timed on the same backend clock, so a Pi whose own clock is off
doesn't put its lines under the wrong step. That is also why a packet is
stamped on arrival rather than with the capture timestamp tcpdump gave it.

One JSON object per line, either
  {"t": ISO time, "pi": pi_id, "line": raw text}                  syslog
  {"t": ISO time, "pi": pi_id, "k": "pkt", "if": iface, "p": {}}  one packet
(a record with no "k" is syslog - that is what the first version wrote).
Files live next to the other captures and are removed with their run.

Syslog is tapped per Pi, packets per (Pi, interface): a run picks up any
syslog its Pis emit while it runs, but only the interfaces it asked for.

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
_files: dict[int, object] = {}                      # run_id -> open file handle
_taps: dict[str, set[int]] = {}                     # pi_id -> run_ids capturing it
_pkt_taps: dict[tuple[str, str], set[int]] = {}     # (pi_id, iface) -> run_ids


def _path(run_id: int) -> Path:
    return RUN_LOGS_DIR / f"testrun-{run_id}.jsonl"


def start(run_id: int, pi_ids, iface_pairs=()) -> None:
    """Begin capturing these Pis' syslog, and the packets off these
    (pi_id, interface) pairs, into run_id's file."""
    with _lock:
        if run_id not in _files:
            # "w", not "a": SQLite can reuse the id of a deleted newest run,
            # and a fresh run must not inherit an old file's lines.
            _files[run_id] = _path(run_id).open("w", encoding="utf-8")
        for pi in pi_ids:
            _taps.setdefault(str(pi), set()).add(run_id)
        for pi, iface in iface_pairs:
            _pkt_taps.setdefault((str(pi), str(iface)), set()).add(run_id)


def _release(taps: dict, run_id: int) -> set:
    """Drops run_id from every tap in `taps`, returning the keys left with no
    run behind them."""
    released = set()
    for key, runs in list(taps.items()):
        if run_id in runs:
            runs.discard(run_id)
            if not runs:
                del taps[key]
                released.add(key)
    return released


def stop(run_id: int) -> tuple[set[str], set[tuple[str, str]]]:
    """Stop capturing for run_id. Returns (Pis, (pi, interface) pairs) no
    other run is capturing any more - the caller may stop their streams."""
    with _lock:
        released = _release(_taps, run_id)
        released_pairs = _release(_pkt_taps, run_id)
        fh = _files.pop(run_id, None)
    if fh is not None:
        fh.close()
    return released, released_pairs


def is_tapped(pi_id: str) -> bool:
    with _lock:
        return bool(_taps.get(str(pi_id)))


def _write(runs: set, records: list) -> None:
    """Append already-encoded JSON lines to each run's file. Caller holds
    the lock."""
    blob = "".join(records)
    for run_id in runs:
        fh = _files.get(run_id)
        if fh is not None:
            fh.write(blob)
            fh.flush()


def append(pi_id: str, line: str) -> None:
    """One syslog line arrived from pi_id - file it under every run
    capturing that Pi."""
    with _lock:
        runs = _taps.get(str(pi_id))
        if not runs:
            return
        _write(runs, [json.dumps({"t": datetime.now(timezone.utc).isoformat(), "pi": pi_id, "line": line}) + "\n"])


def is_pkt_tapped(pi_id: str, interface) -> bool:
    with _lock:
        return bool(_pkt_taps.get((str(pi_id), str(interface))))


def append_packets(pi_id: str, interface, packets) -> None:
    """A batch of decoded packets arrived off pi_id's interface - file them
    under every run sniffing it. `packets` is what PcapStreamDecoder.feed
    returns: (capture time, original length, {protocol, src, dst, info}).
    All of a batch shares one arrival stamp; they stay in capture order."""
    with _lock:
        runs = _pkt_taps.get((str(pi_id), str(interface)))
        if not runs:
            return
        now = datetime.now(timezone.utc).isoformat()
        _write(runs, [
            json.dumps({"t": now, "pi": pi_id, "k": "pkt", "if": interface,
                        "p": {"len": orig_len, **rec}}) + "\n"
            for _ts, orig_len, rec in packets
        ])


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
