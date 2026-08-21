import json
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
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
            "gateway": r.gateway, "updated_at": r.updated_at.isoformat(),
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
# make sense as a running history, not something that gets deleted. But an
# AP that's since been turned off would otherwise sit in this endpoint's
# result indefinitely with a last_seen that stops moving - at the current
# ~3s scan cadence (see PiAgent.WIFI_BACKGROUND_SCAN_INTERVAL_SECONDS), a
# row that hasn't been refreshed in this long is a reliable signal the AP
# is actually gone, not just a slow poll cycle.
WIFI_HISTORY_STALE_SECONDS = 60


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
    snapshot can't provide. Rows for APs no longer in range are dropped via
    the same WIFI_HISTORY_STALE_SECONDS staleness check as before. Ordered
    most-recently-seen first, so an AP still being actively rescanned every
    cycle stays pinned near the top."""
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=WIFI_HISTORY_STALE_SECONDS)
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
            WifiScanHistory.last_seen >= cutoff,
        )
    ).all()

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
            "gateway": r.gateway, "updated_at": r.updated_at.isoformat(),
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