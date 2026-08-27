#!/bin/bash
# Continuous connectivity/DNS monitor for diagnosing intermittent offline
# events on pi01. Logs one line per interval; onstate change (OK<->FAIL)
# also dumps resolv.conf/route/nmcli snapshots for post-mortem.
LOG=/var/log/net_monitor.log
INTERVAL=1
TARGET_HOST=github.com
TARGET_IP=8.8.8.8

last_state=""

while true; do
    ts=$(date +%T.%N)

    if getent hosts "$TARGET_HOST" >/dev/null 2>&1; then
        dns_state=OK
    else
        dns_state=FAIL
    fi

    if ping -c1 -W1 "$TARGET_IP" >/dev/null 2>&1;
 then
        ping_state=OK
    else
        ping_state=FAIL
    fi

    state="dns=$dns_state ping=$ping_state"
    echo "$ts $state" >> "$LOG"

    if [ "$state" != "$last_state" ]; then
        {
            echo "=== STATE CHANGE $ts: $last_state -> $state ==="
            echo "--- resolv.conf ---"
            cat /etc/resolv.conf
            echo "--- ip route ---"
            ip route
            echo "--- nmcli device status ---"
            nmcli device status
            echo "===============================
===================="
        } >> "$LOG"
        last_state="$state"
    fi

    sleep "$INTERVAL"
done
