# Pi Agent

MQTT-controlled agent for network testing/diagnostics on a Raspberry Pi
(iperf3 throughput, syslog/tcpdump streaming, wifi connect/disconnect,
hostapd channel changes, ping).

## Setup

```bash
./install-deps.sh                          # system tools: iperf3, tcpdump, iw, etc.
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt  # python deps: paho-mqtt, python-dotenv
```

`install-deps.sh` installs the command-line tools Pi_agent.py shells out to
(apt-based, e.g. Raspberry Pi OS): `iperf3`, `tcpdump`, `iw`,
`network-manager` (`nmcli`), `hostapd`, `iputils-ping`, `iproute2`.

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
restarts it so it's running the current code. It also installs and enables
`pi-monitor-setup.service`, a oneshot unit that runs `setup-monitor-interfaces.sh`
before `pi-agent.service` starts on every boot - see below.

Requires `.env` to already exist in this directory — `load_dotenv()` finds
it via the service's `WorkingDirectory`.

### Monitor-mode interfaces

`setup-monitor-interfaces.sh` creates one monitor-mode interface per wifi
radio (phy), on every phy except `phy0` - `phy0` is left managed-only (it's
the Pi's primary radio, `wlan0` in the fleet's actual layout), while every
other phy ends up with both its existing managed interface *and* a new
monitor one (named `mon<phy number>`, e.g. `mon1` on `phy1`), matching how
`phy1`/`wlan1`/`mon1` is already wired up on the fleet today. It's idempotent
(skips a phy that already has a monitor interface) and safe to re-run.

It has to run on every boot, not just once at install time - interfaces
created via `iw ... interface add` don't survive a reboot, so
`pi-monitor-setup.service` (installed by `install.sh`) recreates them before
`pi-agent.service` starts, every time.

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
