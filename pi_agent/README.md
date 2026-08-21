# Pi Agent

MQTT-controlled agent for network testing/diagnostics on a Raspberry Pi
(iperf3 throughput, syslog/tcpdump streaming, wifi connect/disconnect,
hostapd channel changes, ping).

## Setup

```bash
./install-deps.sh                          # system tools: iperf3, tcpdump, iw, etc.
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt  # python deps: aiomqtt, python-dotenv
```

`install-deps.sh` installs the command-line tools Pi_agent.py shells out to
(apt-based, e.g. Raspberry Pi OS): `iperf3`, `tcpdump`, `iw`,
`network-manager` (`nmcli`), `hostapd`, `iputils-ping`, `iproute2`.

## Architecture

The agent runs on a single asyncio event loop. It is almost entirely an
orchestrator of CLI tools (`iw`, `nmcli`, `wpa_cli`, `dhcpcd`, `tcpdump`),
so what used to be a thread per command and per background loop is now a
task per command and per loop, with the waiting done by
`asyncio.create_subprocess_exec` (see `agent/proc.py`) instead of by a
blocked thread. On the 4-radios-per-Pi rigs that means a slow `iw scan` on
one interface no longer occupies anything while the other three are worked
on.

Two pieces are worth knowing about:

- `agent/proc.py` is the single seam every mixin's CLI calls go through.
  `run_hard` additionally kills the whole process group on timeout, which
  matters for `dhcpcd`/`nmcli` - they fork helpers that inherit the pipes,
  and killing only the direct child leaves the read hanging.
- `agent/wpa_events.py` listens on wpa_supplicant's control socket instead
  of polling `wpa_cli status` once a second. Besides the latency, this is
  the only way to see *why* an association failed: the async events carry
  reason/status codes (`CTRL-EVENT-ASSOC-REJECT status_code=17`) that a
  state poll never shows. Falls back to polling when the socket isn't
  attachable.

## Tests

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest          # from this directory
```

The suite fakes both the CLI layer (`agent.proc`) and the MQTT client, so
it needs no hardware, no broker, and no root. A handful of
`agent/wpa_events.py` tests need `AF_UNIX` and skip on Windows.

## Configuration

All configuration lives in `.env` (loaded via `python-dotenv`), not hardcoded
in the script:

| Variable      | Meaning                                   | Example         |
|---------------|--------------------------------------------|-----------------|
| `BROKER_HOST` | MQTT broker address                        | `192.168.150.20`|
| `BROKER_PORT` | MQTT broker port                           | `1883`          |
| `PI_ID`       | Unique ID for this Pi, used in MQTT topics | `pi01`          |
| `ROLE`        | Registration role reported to the broker   | `client`        |

Copy `.env` and adjust these values per device before deploying.

## Why it needs root

`connect_wifi`, `disconnect_wifi`, and `restart_hostapd` shell out to
`nmcli` and `systemctl`, which require NetworkManager/systemd privileges
that a normal user isn't authorized for by default (you'll see a
`not authorized` D-Bus error otherwise). Rather than storing a sudo
password, the agent process itself runs as root via systemd (see below).

## Install as a systemd service

```bash
./install.sh
```

This copies `pi-agent.service` to `/etc/systemd/system/`, reloads systemd,
enables it (so it runs as root and starts on boot and on failure), and
restarts it so it's running the current code.

Requires `.env` to already exist in this directory — `load_dotenv()` finds
it via the service's `WorkingDirectory`.

### Monitor-mode interfaces

There's no boot-time setup for this anymore — an interface's mode (managed
vs monitor) is switched at runtime, in place, via the `set_interface_mode`
action (`{"action": "set_interface_mode", "params": {"interface": "wlan1",
"mode": "monitor"}}`), exposed as a toggle button per interface in the fleet
UI. This replaces the old approach of a permanent, separate `monN` interface
created per phy at boot: `set_interface_mode` flips the *same* interface
in place via `iw dev <iface> set type <mode>` (handing it to/back from
NetworkManager as needed), so `wlan1` itself becomes the monitor interface
when needed instead of always keeping a second `mon1` around.

If this Pi still has `pi-monitor-setup.service` installed from before this
change, disable it once: `sudo systemctl disable --now pi-monitor-setup.service`.

**Re-run `./install.sh` any time you edit `Pi_agent.py`, `.env`, or
`pi-agent.service`** — it always restarts the service at the end, so the
running process picks up the change.

## Operating the service

```bash
systemctl status pi-agent.service        # check it's running
journalctl -u pi-agent.service -f        # tail logs live
sudo systemctl disable --now pi-agent.service  # stop and unregister
```

## Running without systemd (local testing)

```bash
.venv/bin/python Pi_agent.py
```

Note: wifi/hostapd actions will fail with a `not authorized` error unless
this is run as root, since there's no privilege-escalation path in the
script itself.
