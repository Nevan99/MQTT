"""Shared fixtures for the pi_agent tests.

The agent is almost entirely an orchestrator of blocking CLI tools (iw,
nmcli, wpa_cli, dhcpcd, tcpdump) plus an MQTT client, so nearly every test
here needs those two things faked. FakeCommands stands in for subprocess
and records what ran, in what order, and how long each call held the
caller - which is what lets the locking/concurrency tests assert on real
elapsed time rather than on implementation details.
"""
import asyncio
import os
import subprocess
import sys
import threading
import time

import pytest

# The agent modules read these at import time.
os.environ.setdefault("BROKER_HOST", "localhost")
os.environ.setdefault("BROKER_PORT", "1883")
os.environ.setdefault("PI_ID", "test-pi")
os.environ.setdefault("ROLE", "test")
os.environ.setdefault("CAPTURE_SOCKET_HOST", "localhost")
os.environ.setdefault("CAPTURE_SOCKET_PORT", "9999")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


# Realistic timings, in seconds, for the commands whose duration actually
# matters to the concurrency tests. A full `iw scan` drives the radio and
# blocks; a trigger returns at once; a dump is a kernel-cache read.
FULL_SCAN_SECONDS = 3.0
TRIGGER_SECONDS = 0.02
DUMP_SECONDS = 0.05

SCAN_DUMP_OUTPUT = (
    "BSS 54:7e:1a:18:30:ea(on wlan1)\n"
    "\tsignal: -45.00 dBm\n"
    "\tSSID: Telia-test\n"
    "\tfreq: 2437\n"
    "BSS aa:bb:cc:dd:ee:01(on wlan1)\n"
    "\tsignal: -70.00 dBm\n"
    "\tSSID: Other-AP\n"
    "\tfreq: 5180\n"
)


class FakeCommands:
    """Records every subprocess invocation and replays scripted results.

    Rules are matched by the longest registered command prefix, so a test
    can override one specific `iw ... scan dump` without having to respell
    every other command the code under test happens to call.
    """

    def __init__(self):
        self.calls = []            # list of (argv list, started_at, duration)
        self._rules = {}
        self._lock = threading.Lock()
        self.t0 = time.time()
        self.install_defaults()

    # --- scripting -----------------------------------------------------

    def register(self, prefix, returncode=0, stdout="", stderr="", duration=0.0):
        self._rules[tuple(prefix.split())] = {
            "returncode": returncode, "stdout": stdout,
            "stderr": stderr, "duration": duration,
        }

    def install_defaults(self):
        self.register("iw dev wlan1 scan trigger", duration=TRIGGER_SECONDS)
        self.register("iw dev wlan1 scan dump", stdout=SCAN_DUMP_OUTPUT, duration=DUMP_SECONDS)
        self.register("iw dev wlan1 scan", stdout=SCAN_DUMP_OUTPUT, duration=FULL_SCAN_SECONDS)
        self.register("iw dev wlan1 link", stdout="Not connected.")
        self.register("iw dev wlan1 set channel")
        self.register("ip addr flush dev wlan1")
        self.register("ip link set wlan1 up")
        self.register("ip link set wlan1 down")
        self.register("dhcpcd")
        self.register("nmcli")
        self.register("wpa_cli")
        self.register("wpa_supplicant")

    # --- lookup --------------------------------------------------------

    def _match(self, cmd):
        argv = tuple(str(c) for c in cmd)
        for n in range(len(argv), 0, -1):
            rule = self._rules.get(argv[:n])
            if rule is not None:
                return rule
        return {"returncode": 0, "stdout": "", "stderr": "", "duration": 0.0}

    async def run(self, cmd, timeout=None, **kwargs):
        rule = self._match(cmd)
        started = time.time() - self.t0
        if rule["duration"]:
            await asyncio.sleep(rule["duration"])
        with self._lock:
            self.calls.append({
                "argv": [str(c) for c in cmd],
                "cmd": " ".join(str(c) for c in cmd),
                "at": started,
                "duration": rule["duration"],
            })
        return subprocess.CompletedProcess(
            cmd, rule["returncode"], rule["stdout"], rule["stderr"],
        )

    # --- assertions helpers --------------------------------------------

    def commands(self):
        with self._lock:
            return [c["cmd"] for c in self.calls]

    def ran(self, fragment):
        return any(fragment in c for c in self.commands())

    def count(self, fragment):
        return sum(1 for c in self.commands() if fragment in c)

    def clear(self):
        with self._lock:
            self.calls.clear()


@pytest.fixture
def fake_cmds(monkeypatch):
    """Replaces the CLI layer for every mixin at once.

    agent.proc is the single seam all of them go through, so patching its
    two entry points is enough - no per-module patching, unlike the sync
    version which had to reach into each module's `subprocess`.
    """
    fake = FakeCommands()
    import agent.proc as proc_mod

    monkeypatch.setattr(proc_mod, "run", fake.run)
    monkeypatch.setattr(proc_mod, "run_hard", lambda cmd, timeout=None: fake.run(cmd))
    return fake


class FakeMqttClient:
    """Stands in for the aiomqtt client the agent holds while connected."""

    def __init__(self):
        self.published = []
        self.subscriptions = []

    async def publish(self, topic, payload=None, qos=0, retain=False):
        self.published.append({"topic": topic, "payload": payload, "qos": qos, "retain": retain})

    async def subscribe(self, topic, qos=0):
        self.subscriptions.append(topic)


@pytest.fixture
def agent(fake_cmds):
    """A PiAgent with its CLI layer and MQTT client faked out.

    Built inside the running loop because __init__ now creates asyncio.Lock
    objects, which bind to whichever loop is current.
    """
    from agent.core import PiAgent

    a = PiAgent()
    a.client = FakeMqttClient()
    a.cmds = fake_cmds
    return a


def published_results(agent):
    """Decoded result payloads the agent published, in order."""
    import json
    out = []
    for msg in agent.client.published:
        if msg["topic"].endswith("/result"):
            try:
                out.append(json.loads(msg["payload"]))
            except (TypeError, ValueError):
                pass
    return out


async def wait_for(predicate, timeout=5.0, interval=0.01):
    """Polls until predicate() is truthy. Returns True if it became so.

    Used for the fire-and-forget dispatched commands, which publish from
    their own task rather than by the time the caller returns.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(interval)
    return False


def returns(value):
    """An async stand-in for a coroutine method, for monkeypatching.

    Every agent method the tests replace is a coroutine now, so a plain
    `lambda self, i: "192.168.1.50"` no longer substitutes for one - the
    caller awaits what it gets back.
    """
    async def _stub(*args, **kwargs):
        return value
    return _stub
