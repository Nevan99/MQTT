import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select

from database.database import get_session
from database.models import Pi, LogEntry, WifiScanHistory, WifiScanSnapshot, InterfaceStatus
from schemas.schemas import PiOut, LogEntryOut, PrimaryInterfaceRequest, InterfaceDefaultRequest
from service.auth import get_current_user

router = APIRouter(prefix="/pis", tags=["pis"], dependencies=[Depends(get_current_user)])


def _to_out(p: Pi) -> PiOut:
    return PiOut(
        pi_id=p.pi_id, ip_address=p.ip_address, role=p.role,
        status=p.status, last_seen=p.last_seen, metadata=p.metadata_dict,
        primary_interfaces=p.primary_interfaces,
        interface_defaults=p.interface_defaults,
    )


@router.get("", response_model=list[PiOut])
def list_pis(session: Session = Depends(get_session)):
    pis = session.exec(select(Pi)).all()
    return [_to_out(p) for p in pis]


def _wifi7_link_fields(r: InterfaceStatus) -> dict:
    """Wi-Fi 7 MLD/per-link fields of an InterfaceStatus row, with
    mlo_links decoded back from its JSON column - same names as the Pi's own
    link_info result, so the UI can treat either one as the link."""
    try:
        links = json.loads(r.mlo_links_json) if r.mlo_links_json else None
    except ValueError:
        links = None
    return {
        "mlo": r.mlo, "mld_address": r.mld_address,
        "ap_mld_address": r.ap_mld_address, "mlo_links": links,
    }


@router.get("/interface-status", response_model=list[dict])
def get_all_interface_status(session: Session = Depends(get_session)):
    """Fleet-wide flat view of every managed Pi's every interface's buffered
    status - the same InterfaceStatus buffer GET /{pi_id}/interface-status
    reads, just without the pi_id filter - for the Interfaces tab. Declared
    ahead of GET /{pi_id} below so this literal path isn't shadowed by that
    route's {pi_id} matching "interface-status" as a literal Pi id."""
    rows = session.exec(select(InterfaceStatus)).all()
    return [
        {
            "pi_id": r.pi_id, "interface": r.interface, "mac_address": r.mac_address,
            "state": r.state, "type": r.type, "ip_address": r.ip_address, "ipv6_address": r.ipv6_address,
            "connected": r.connected, "ssid": r.ssid, "bssid": r.bssid,
            "frequency_mhz": r.frequency_mhz, "band": r.band, "signal_dbm": r.signal_dbm,
            "rx_bitrate_mbps": r.rx_bitrate_mbps, "tx_bitrate_mbps": r.tx_bitrate_mbps,
            "gateway": r.gateway, "key_mgmt": r.key_mgmt, "pairwise_cipher": r.pairwise_cipher,
            "group_cipher": r.group_cipher, "wpa_state": r.wpa_state, "address": r.address,
            "wifi_generation": r.wifi_generation, "noise_dbm": r.noise_dbm,
            "avg_signal_dbm": r.avg_signal_dbm, "link_speed_mbps": r.link_speed_mbps,
            "channel_width": r.channel_width, "radio_type": r.radio_type,
            "wifi7_capable": r.wifi7_capable,
            "max_standard_capable": r.max_standard_capable,
            **_wifi7_link_fields(r),
            "updated_at": r.updated_at.isoformat(),
        }
        for r in rows
    ]


@router.get("/{pi_id}", response_model=PiOut)
def get_pi(pi_id: str, session: Session = Depends(get_session)):
    pi = session.get(Pi, pi_id)
    if pi is None:
        raise HTTPException(status_code=404, detail="Pi not found")
    return _to_out(pi)


@router.patch("/{pi_id}/primary-interface", response_model=PiOut)
def set_primary_interface(pi_id: str, req: PrimaryInterfaceRequest, session: Session = Depends(get_session)):
    pi = session.get(Pi, pi_id)
    if pi is None:
        raise HTTPException(status_code=404, detail="Pi not found")
    known = pi.metadata_dict.get("interfaces", [])
    unknown = [i for i in req.primary_interfaces if i not in known]
    if unknown:
        raise HTTPException(status_code=400, detail=f"Not one of this Pi's known interfaces: {unknown}")
    pi.primary_interfaces_json = json.dumps(req.primary_interfaces)
    session.add(pi)
    session.commit()
    session.refresh(pi)
    return _to_out(pi)


@router.put("/{pi_id}/interfaces/{interface}/default", response_model=PiOut)
def set_interface_default(
    pi_id: str, interface: str, req: InterfaceDefaultRequest, session: Session = Depends(get_session),
):
    """Sets (or, with both fields omitted, clears) the default band/channel
    for one of this Pi's interfaces - auto-applied by Commands._dispatch to
    any connect_wifi request against that interface that doesn't already
    specify its own channel/band, so a station interface can be pinned to a
    band or exact channel once instead of retyping it on every connect."""
    pi = session.get(Pi, pi_id)
    if pi is None:
        raise HTTPException(status_code=404, detail="Pi not found")
    known = pi.metadata_dict.get("interfaces", [])
    if interface not in known:
        raise HTTPException(status_code=400, detail=f"Not one of this Pi's known interfaces: {interface}")
    if req.band is not None and req.band not in ("bg", "a"):
        raise HTTPException(status_code=400, detail='band must be "bg" (2.4GHz), "a" (5GHz), or omitted')
    if req.channel is not None and req.channel <= 0:
        raise HTTPException(status_code=400, detail="channel must be a positive number")
    if req.band is not None and req.channel is not None:
        # Same convention connect_wifi/set_monitor_channel already use to
        # infer a band from a bare channel number - reject the pair up
        # front instead of silently saving a default that can never apply
        # (nmcli would just ignore/override the mismatched band).
        inferred = "bg" if req.channel <= 14 else "a"
        inferred_label = "2.4GHz" if inferred == "bg" else "5GHz"
        if req.band != inferred:
            raise HTTPException(
                status_code=400,
                detail=f"channel {req.channel} is {inferred_label}, not the selected band",
            )

    defaults = pi.interface_defaults
    if req.band is None and req.channel is None:
        defaults.pop(interface, None)
    else:
        defaults[interface] = {"band": req.band, "channel": req.channel}
    pi.interface_defaults_json = json.dumps(defaults)
    session.add(pi)
    session.commit()
    session.refresh(pi)
    return _to_out(pi)


@router.get("/{pi_id}/logs", response_model=list[LogEntryOut])
def get_pi_logs(
    pi_id: str, category: str, since: Optional[datetime] = None,
    limit: int = 200, session: Session = Depends(get_session),
):
    """Persisted log entries for a Pi, oldest first.

    Without `since`: the most recent `limit` entries, used to repopulate a
    panel after a page reload. With `since`: every entry from that point
    onward (up to `limit`), used to pull a capture window - this reads from
    the DB rather than the live WebSocket feed, so it can't miss messages
    that arrived while the panel was collapsed or the tab was closed.
    """
    query = select(LogEntry).where(LogEntry.pi_id == pi_id, LogEntry.category == category)
    if since is not None:
        query = query.where(LogEntry.timestamp >= since)
    entries = session.exec(query.order_by(LogEntry.timestamp.desc()).limit(limit)).all()
    entries.reverse()
    return [
        LogEntryOut(
            pi_id=e.pi_id, category=e.category,
            payload=json.loads(e.payload_json), timestamp=e.timestamp,
        )
        for e in entries
    ]


@router.delete("/{pi_id}/logs")
def clear_pi_logs(pi_id: str, category: str, session: Session = Depends(get_session)):
    """Purge persisted log entries for a Pi/category so a reload doesn't
    repopulate a panel the user just cleared."""
    entries = session.exec(
        select(LogEntry).where(LogEntry.pi_id == pi_id, LogEntry.category == category)
    ).all()
    for e in entries:
        session.delete(e)
    session.commit()
    return {"deleted": len(entries)}


# A WifiScanHistory row is upserted forever once a BSSID is first seen (see
# mqtt_service._update_wifi_scan_history) - first_seen/detection_count only
# make sense as a running history, not something that gets deleted, so it
# can't be used on its own to tell "AP is gone" apart from "Pi just hasn't
# produced a fresh successful scan in a while" (e.g. NetworkManager holding
# the radio busy for a couple minutes right after a Pi reboot - see
# PiAgent.SCAN_BUSY_RETRY_DELAYS_SECONDS). Membership in the
# WifiScanSnapshot cache (below) is what now decides whether an AP is still
# "in range" - that cache is self-pruning (only the WIFI_SCAN_SNAPSHOT_CAP
# most recent *successful* scans are kept, see mqtt_service.py), so it
# naturally keeps showing the last known-good result through any gap in
# scanning instead of going blank the moment a wall-clock cutoff elapses,
# and only actually drops an AP once enough real scans have happened
# without seeing it again.


@router.get("/{pi_id}/wifi-history", response_model=list[dict])
def get_wifi_scan_history(pi_id: str, interface: str, session: Session = Depends(get_session)):
    """The "Wifi Info" popup's data source. Unions the last
    WIFI_SCAN_SNAPSHOT_CAP (mqtt_service.py) full wifi_detail_scan results
    cached for this (Pi, interface) into one per-AP list, deduped by bssid
    (most recent snapshot containing that bssid wins) - so a single thin or
    empty scan cycle (an off-channel dwell, a busy radio) doesn't blank the
    popup as long as the AP showed up in any of the other still-cached
    snapshots. Each entry is that snapshot's raw per-AP fields (phy type,
    security, cipher, etc.) plus the WifiScanHistory rollup columns
    (first/last seen, detection count, min/max/avg signal quality) a single
    snapshot can't provide. An AP is included as long as it's present in
    that snapshot cache - no separate wall-clock staleness cutoff, so a
    stretch of failed/skipped scans (e.g. right after a Pi reboot) keeps
    showing the last cached result instead of blanking the popup, while an
    AP that's genuinely gone still ages out once enough fresh scans have
    passed without seeing it. Ordered most-recently-seen first, so an AP
    still being actively rescanned every cycle stays pinned near the top."""
    snapshots = session.exec(
        select(WifiScanSnapshot).where(
            WifiScanSnapshot.pi_id == pi_id, WifiScanSnapshot.interface == interface,
        ).order_by(WifiScanSnapshot.scanned_at.desc())
    ).all()
    by_bssid: dict[str, dict] = {}
    for snap in snapshots:
        try:
            networks = json.loads(snap.networks_json)
        except (TypeError, ValueError):
            continue
        for net in networks:
            bssid = net.get("bssid")
            if bssid and bssid not in by_bssid:
                by_bssid[bssid] = net

    history_rows = session.exec(
        select(WifiScanHistory).where(
            WifiScanHistory.pi_id == pi_id, WifiScanHistory.interface == interface,
            WifiScanHistory.bssid.in_(list(by_bssid.keys())),
        )
    ).all() if by_bssid else []

    out = []
    for r in history_rows:
        net = dict(by_bssid.get(r.bssid, {}))
        net.update({
            "bssid": r.bssid,
            "ssid": r.ssid or net.get("ssid"),
            "first_seen": r.first_seen.isoformat(),
            "last_seen": r.last_seen.isoformat(),
            "detection_count": r.detection_count,
            "min_signal_percent": r.min_signal_percent,
            "max_signal_percent": r.max_signal_percent,
            "avg_signal_percent": round(r.signal_sum / r.detection_count, 1) if r.detection_count else None,
        })
        out.append(net)
    out.sort(key=lambda n: n["last_seen"], reverse=True)
    return out


def _band_label(freq_mhz):
    if freq_mhz is None:
        return None
    if 2400 <= freq_mhz <= 2495:
        return "2.4GHz"
    if 5150 <= freq_mhz <= 5895:
        return "5GHz"
    if 5925 <= freq_mhz <= 7125:
        return "6GHz"
    return "unknown"


def _flatten_scan_entry(net):
    """Same reduction pi_agent's WifiScanMixin._flatten_scan_entry applies -
    kept in this exact shape (not the fuller stored snapshot fields) so the
    frontend's existing hotspot cards (built against get_nearby_hotspots'
    old MQTT-sourced shape) don't need to change at all, only where the
    data comes from."""
    freq_mhz = net.get("frequency_mhz")
    max_speed = net.get("max_speed_mbps")
    return {
        "ssid": net.get("ssid"),
        "bssid": net.get("bssid"),
        "mode": net.get("bss_type"),
        "channel": net.get("channel"),
        "frequency_mhz": freq_mhz,
        "band": _band_label(freq_mhz),
        "rate": f"{max_speed:g} Mbit/s" if max_speed else None,
        "signal_percent": net.get("signal_quality_percent"),
        # Raw dBm alongside the percentage - the percentage saturates at
        # 100 above -50 dBm, so it can't rank two strong signals against
        # each other, which the merge below needs to do.
        "signal_dbm": net.get("rssi_dbm"),
        "security": net.get("security"),
    }


def _merge_hotspot(merged, interface, net):
    """Ports pi_agent's WifiScanMixin._merge_hotspot - folds one
    interface's view of an AP into the merged-by-BSSID set, tracking which
    interfaces saw it (seen_by) and which measured it strongest
    (best_interface, compared on raw dBm - see _flatten_scan_entry)."""
    entry = _flatten_scan_entry(net)
    bssid = entry["bssid"]
    if not bssid:
        return
    existing = merged.get(bssid)
    if existing is None:
        entry["seen_by"] = [interface]
        entry["best_interface"] = interface
        merged[bssid] = entry
        return

    existing["seen_by"].append(interface)
    new_signal = entry["signal_dbm"]
    old_signal = existing["signal_dbm"]
    if new_signal is not None and (old_signal is None or new_signal > old_signal):
        seen_by = existing["seen_by"]
        entry["seen_by"] = seen_by
        entry["best_interface"] = interface
        merged[bssid] = entry


@router.get("/{pi_id}/nearby-hotspots", response_model=dict)
def get_nearby_hotspots(
    pi_id: str, interfaces: Optional[list[str]] = Query(None), session: Session = Depends(get_session),
):
    """Backend-only equivalent of pi_agent's own get_nearby_hotspots
    (agent/wifi_scan.py) - merges each requested interface's cached
    wifi_detail_scan results (WifiScanSnapshot, kept warm by
    PiAgent._wifi_background_scan_loop and written here by
    mqtt_service._update_wifi_scan_history) by BSSID, the same way the
    agent does, but entirely from the database - no MQTT command sent to
    the Pi, no waiting on it to actually run a scan. `interfaces` omitted
    covers every interface this Pi has ever reported a snapshot for.

    Trades a small amount of freshness (results are only as new as the
    background loop's last successful scan per interface, not a scan
    triggered by this request) for an answer that's instant regardless of
    how many radios/Pis are being asked about at once, and that still
    works through a stretch where the Pi's own scans are failing (see
    WifiScanSnapshot's self-pruning cache, not a wall-clock cutoff)."""
    if interfaces:
        target_interfaces = interfaces
    else:
        target_interfaces = [
            row for row in session.exec(
                select(WifiScanSnapshot.interface)
                .where(WifiScanSnapshot.pi_id == pi_id)
                .distinct()
            ).all()
        ]

    merged: dict[str, dict] = {}
    for iface in target_interfaces:
        snapshots = session.exec(
            select(WifiScanSnapshot).where(
                WifiScanSnapshot.pi_id == pi_id, WifiScanSnapshot.interface == iface,
            ).order_by(WifiScanSnapshot.scanned_at.desc())
        ).all()
        # Only the freshest snapshot's view of a given BSSID on this
        # interface counts - an older cached snapshot re-reporting the same
        # AP shouldn't get folded in as if it were a second, independent
        # sighting.
        seen_on_this_iface = set()
        for snap in snapshots:
            try:
                networks = json.loads(snap.networks_json)
            except (TypeError, ValueError):
                continue
            for net in networks:
                bssid = net.get("bssid")
                if not bssid or bssid in seen_on_this_iface:
                    continue
                seen_on_this_iface.add(bssid)
                _merge_hotspot(merged, iface, net)

    networks = sorted(
        merged.values(),
        key=lambda n: (n["signal_dbm"] is None, -(n["signal_dbm"] or 0), n["ssid"] or ""),
    )
    return {"interfaces": target_interfaces, "networks": networks}


@router.get("/{pi_id}/interface-status", response_model=list[dict])
def get_interface_status(pi_id: str, session: Session = Depends(get_session)):
    """One row per interface, continuously refreshed in the background by
    pi_agent (PiAgent._interface_status_loop, every
    INTERFACE_STATUS_INTERVAL_SECONDS) rather than a list_interfaces/
    link_info round-trip triggered by whoever's asking - see InterfaceStatus
    for why. Used by the fleet table and Pi detail page's interface cards
    for their passive periodic refresh; a user-triggered action (connect,
    disconnect, mode switch) still gets its own immediate live result
    instead of waiting on this buffer to catch up."""
    rows = session.exec(
        select(InterfaceStatus).where(InterfaceStatus.pi_id == pi_id)
    ).all()
    return [
        {
            "interface": r.interface, "mac_address": r.mac_address, "state": r.state, "type": r.type,
            "ip_address": r.ip_address, "ipv6_address": r.ipv6_address,
            "connected": r.connected, "ssid": r.ssid, "bssid": r.bssid,
            "frequency_mhz": r.frequency_mhz, "band": r.band, "signal_dbm": r.signal_dbm,
            "rx_bitrate_mbps": r.rx_bitrate_mbps, "tx_bitrate_mbps": r.tx_bitrate_mbps,
            "gateway": r.gateway, "key_mgmt": r.key_mgmt, "pairwise_cipher": r.pairwise_cipher,
            "group_cipher": r.group_cipher, "wpa_state": r.wpa_state, "address": r.address,
            "wifi_generation": r.wifi_generation, "noise_dbm": r.noise_dbm,
            "avg_signal_dbm": r.avg_signal_dbm, "link_speed_mbps": r.link_speed_mbps,
            "channel_width": r.channel_width, "radio_type": r.radio_type,
            "wifi7_capable": r.wifi7_capable,
            "max_standard_capable": r.max_standard_capable,
            **_wifi7_link_fields(r),
            "updated_at": r.updated_at.isoformat(),
        }
        for r in rows
    ]


@router.delete("/{pi_id}")
def delete_pi(pi_id: str, session: Session = Depends(get_session)):
    pi = session.get(Pi, pi_id)
    if pi is None:
        raise HTTPException(status_code=404, detail="Pi not found")
    session.delete(pi)
    session.commit()
    return {"deleted": pi_id}