#!/usr/bin/env bash
# Creates one monitor-mode interface per wifi radio (phy), on every phy
# except phy0 - phy0 stays managed-only (it's the Pi's primary/control-plane
# radio, e.g. wlan0 in the fleet's actual `iw dev` layout) - while leaving
# each phy's existing managed interface(s) completely untouched; a phy ends
# up with both, same as phy1's wlan1 (managed) + mon1 (monitor) already does
# on the fleet today.
#
# Idempotent - safe to re-run, and meant to run on every boot (see
# pi-monitor-setup.service) since interfaces created via `iw ... interface
# add` are not persistent; they vanish on reboot and need recreating.
set -euo pipefail

for phy_path in /sys/class/ieee80211/phy*; do
    phy="$(basename "$phy_path")"
    if [[ "$phy" == "phy0" ]]; then
        continue
    fi

    net_dir="$phy_path/device/net"
    if [[ ! -d "$net_dir" ]]; then
        continue
    fi

    has_monitor=false
    for iface_path in "$net_dir"/*; do
        [[ -e "$iface_path" ]] || continue
        # ARPHRD_IEEE80211_RADIOTAP == 803 - the kernel's own, name-independent
        # way to tell a monitor-mode interface apart from managed/AP (which
        # reports ARPHRD_ETHER == 1, same as plain ethernet) - same signal
        # pi_agent.get_interface_details uses server-side (there it comes
        # from `ip -o link show`'s "link/ieee802.11/radiotap" instead).
        if [[ "$(cat "$iface_path/type" 2>/dev/null)" == "803" ]]; then
            has_monitor=true
            break
        fi
    done

    if [[ "$has_monitor" == true ]]; then
        echo "setup-monitor-interfaces: $phy already has a monitor interface, skipping"
        continue
    fi

    mon_name="mon${phy#phy}"
    echo "setup-monitor-interfaces: adding $mon_name (monitor) on $phy"
    iw phy "$phy" interface add "$mon_name" type monitor
    ip link set "$mon_name" up
done
