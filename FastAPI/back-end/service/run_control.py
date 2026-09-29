"""In-memory state for testcase/testsuite runs that are executing right now.

Two jobs:

1. Live results. A looped testcase can expand into thousands of step
   executions. Rewriting that whole results_json to SQLite after every step
   (and having every 1.5s poll parse it back out) was what made big loop runs
   hang - so the runner keeps its results here, readers (the summary / paged
   steps endpoints) serve from here while the run is live, and the DB copy is
   only flushed every few seconds and at the end.

2. Stop requests. POST /testcases/runs/{id}/stop and
   POST /testsuites/runs/{id}/stop only set a flag here; the runner threads
   check it between steps (and while waiting on a command), so a stop never
   has to reach into another thread.

Everything here is process-local: after a backend restart nothing is live,
and the endpoints fall back to what was last persisted.
"""
import threading

# Testcase run stop modes.
STOP_NOW = "now"                      # abandon the step in flight, skip the rest
STOP_AFTER_LOOP_PASS = "after_loop_pass"  # finish the current loop pass / block first
TESTCASE_STOP_MODES = (STOP_NOW, STOP_AFTER_LOOP_PASS)

# Testsuite run stop modes.
STOP_AFTER_TESTCASE = "after_testcase"  # let the current testcase finish, skip the rest
SUITE_STOP_MODES = (STOP_NOW, STOP_AFTER_TESTCASE)


class LiveRun:
    def __init__(self, results: list):
        # RLock: the runner mutates results under it, readers copy under it,
        # so nobody serializes a dict mid-update.
        self.lock = threading.RLock()
        self.results = results
        self.version = 0
        self.current = None           # index into results of the step in flight
        self.stop_mode = None

    def bump(self):
        self.version += 1


class LiveSuiteRun:
    def __init__(self):
        self.stop_mode = None
        self.current_run_id = None


_lock = threading.Lock()
_runs: dict[int, LiveRun] = {}
_suites: dict[int, LiveSuiteRun] = {}


# --- testcase runs ---------------------------------------------------------

def register_run(run_id: int, results: list) -> LiveRun:
    live = LiveRun(results)
    with _lock:
        _runs[run_id] = live
    return live


def get_run(run_id: int):
    with _lock:
        return _runs.get(run_id)


def unregister_run(run_id: int):
    with _lock:
        _runs.pop(run_id, None)


def request_run_stop(run_id: int, mode: str) -> bool:
    """False if the run isn't live in this process. "now" always wins over a
    pending "after_loop_pass" - asking to stop harder shouldn't be ignored."""
    live = get_run(run_id)
    if live is None:
        return False
    with live.lock:
        if live.stop_mode != STOP_NOW:
            live.stop_mode = mode
        live.bump()
    return True


def run_stop_mode(run_id: int):
    live = get_run(run_id)
    return live.stop_mode if live is not None else None


# --- testsuite runs --------------------------------------------------------

def register_suite(suite_run_id: int) -> LiveSuiteRun:
    live = LiveSuiteRun()
    with _lock:
        _suites[suite_run_id] = live
    return live


def get_suite(suite_run_id: int):
    with _lock:
        return _suites.get(suite_run_id)


def unregister_suite(suite_run_id: int):
    with _lock:
        _suites.pop(suite_run_id, None)


def request_suite_stop(suite_run_id: int, mode: str) -> bool:
    live = get_suite(suite_run_id)
    if live is None:
        return False
    if live.stop_mode != STOP_NOW:
        live.stop_mode = mode
    # "now" also cuts the testcase currently executing short; "after_testcase"
    # leaves it alone and just keeps the suite from starting the next one.
    if mode == STOP_NOW and live.current_run_id is not None:
        request_run_stop(live.current_run_id, STOP_NOW)
    return True


# --- thread-local abort check ---------------------------------------------
# _await_command and the dispatch loop sit several calls below the runner;
# rather than thread a callback through every signature, the runner thread
# registers which run it is executing and the helpers ask here.

_ctx = threading.local()


def set_current_run(run_id):
    _ctx.run_id = run_id


def should_abort_now() -> bool:
    run_id = getattr(_ctx, "run_id", None)
    return run_id is not None and run_stop_mode(run_id) == STOP_NOW
