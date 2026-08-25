"""Persists the last successfully connected SSID/password per interface, so
pi_agent can reconnect them itself on startup.

Every wl* interface here is permanently unmanaged by NetworkManager (see
99-pi-agent-unmanaged-wifi.conf), and connect_wifi's wpa_supplicant instance
is an ad-hoc process configured from a /tmp file - neither survives a reboot
or even just an agent restart, so nothing else auto-reconnects a radio to
its last network any more. See WifiMixin.connect_wifi (saves a profile on a
successful connect), WifiMixin.disconnect_wifi (clears it on an explicit
user disconnect, so a reboot does not silently undo that), and
WifiMixin._replay_saved_wifi_profiles (called once per process start from
PiAgent.start_background_loops).
"""
import json
import os

# Root (pi-agent.service runs as User=root), so /var/lib is writable and
# survives across reboots and reinstalls - unlike the /tmp wpa_supplicant
# config files these profiles are meant to outlive.
PROFILES_PATH = os.environ.get("WIFI_PROFILES_PATH", "/var/lib/pi-agent/wifi_profiles.json")


def load():
    try:
        with open(PROFILES_PATH) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def save(interface, profile):
    profiles = load()
    profiles[interface] = profile
    _write(profiles)


def clear(interface):
    profiles = load()
    if profiles.pop(interface, None) is not None:
        _write(profiles)


def _write(profiles):
    os.makedirs(os.path.dirname(PROFILES_PATH), exist_ok=True)
    # Write-then-rename so a crash mid-write can never leave a truncated/
    # corrupt file behind for the next load() to choke on.
    tmp_path = PROFILES_PATH + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(profiles, f)
    os.replace(tmp_path, PROFILES_PATH)
