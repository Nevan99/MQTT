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
