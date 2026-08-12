"""Incremental decoder for a classic-format pcap byte stream (what
`tcpdump -w -` produces), turning captured frames into structured records
(protocol/source/destination/length/info - the same columns Wireshark's
packet list shows) as the bytes arrive, reusing exactly the bytes already
being written to disk for the saved .pcap file.

Deliberately not full tcpdump/Wireshark fidelity - just enough (addresses,
ports, TCP flags/seq/ack/win, protocol) to be useful reading live.
"""
import socket as socket_lib
import struct
from datetime import datetime, timezone

ETH_HEADER_LEN = 14
SLL_HEADER_LEN = 16  # Linux "cooked" capture (linktype 113)

_TCP_FLAG_BITS = [
    (0x01, "FIN"), (0x02, "SYN"), (0x04, "RST"), (0x08, "PSH"),
    (0x10, "ACK"), (0x20, "URG"), (0x40, "ECE"), (0x80, "CWR"),
]
_PROTO_NAMES = {1: "ICMP", 6: "TCP", 17: "UDP"}


def _tcp_flags_str(flags):
    names = [name for bit, name in _TCP_FLAG_BITS if flags & bit]
    return ", ".join(names) if names else "none"


def _decode_ipv4(payload):
    """Returns a dict with protocol/src/dst/info, or None if malformed."""
    if len(payload) < 20:
        return None
    ihl = (payload[0] & 0x0F) * 4
    if ihl < 20 or len(payload) < ihl:
        return None
    total_len = struct.unpack("!H", payload[2:4])[0]
    proto = payload[9]
    src = socket_lib.inet_ntoa(payload[12:16])
    dst = socket_lib.inet_ntoa(payload[16:20])
    body = payload[ihl:ihl + max(total_len - ihl, 0)] if total_len >= ihl else payload[ihl:]

    if proto == 6 and len(body) >= 20:  # TCP
        sport, dport = struct.unpack("!HH", body[0:4])
        seq, ack = struct.unpack("!II", body[4:12])
        flags = body[13]
        win = struct.unpack("!H", body[14:16])[0]
        data_offset = (body[12] >> 4) * 4
        data_len = max(len(body) - data_offset, 0)
        return {
            "protocol": "TCP", "src": src, "dst": dst,
            "info": f"{sport} → {dport} [{_tcp_flags_str(flags)}] Seq={seq} Ack={ack} Win={win} Len={data_len}",
        }
    if proto == 17 and len(body) >= 8:  # UDP
        sport, dport, udp_len = struct.unpack("!HHH", body[0:6])
        return {
            "protocol": "UDP", "src": src, "dst": dst,
            "info": f"{sport} → {dport} Len={max(udp_len - 8, 0)}",
        }
    if proto == 1 and body:  # ICMP
        icmp_type = body[0]
        name = {8: "Echo (ping) request", 0: "Echo (ping) reply"}.get(icmp_type, f"Type {icmp_type}")
        return {"protocol": "ICMP", "src": src, "dst": dst, "info": name}
    return {
        "protocol": _PROTO_NAMES.get(proto, f"IP proto {proto}"), "src": src, "dst": dst,
        "info": f"Len={len(body)}",
    }


def _decode_arp(payload):
    if len(payload) < 28:
        return None
    op = struct.unpack("!H", payload[6:8])[0]
    src_ip = socket_lib.inet_ntoa(payload[14:18])
    dst_ip = socket_lib.inet_ntoa(payload[24:28])
    if op == 1:
        info = f"Who has {dst_ip}? Tell {src_ip}"
    elif op == 2:
        info = f"{src_ip} is at (reply to {dst_ip})"
    else:
        info = f"op {op}"
    return {"protocol": "ARP", "src": src_ip, "dst": dst_ip, "info": info}


def decode_packet(data: bytes, linktype: int) -> dict:
    """Decode one captured frame's bytes into {protocol, src, dst, info}."""
    try:
        if linktype == 113 and len(data) >= SLL_HEADER_LEN:
            ethertype = struct.unpack("!H", data[14:16])[0]
            payload = data[SLL_HEADER_LEN:]
        elif len(data) >= ETH_HEADER_LEN:
            ethertype = struct.unpack("!H", data[12:14])[0]
            payload = data[ETH_HEADER_LEN:]
        else:
            return {"protocol": "?", "src": None, "dst": None, "info": f"truncated frame, length {len(data)}"}

        if ethertype == 0x0800:
            return _decode_ipv4(payload) or {"protocol": "IP", "src": None, "dst": None, "info": f"length {len(payload)}"}
        if ethertype == 0x0806:
            return _decode_arp(payload) or {"protocol": "ARP", "src": None, "dst": None, "info": f"length {len(payload)}"}
        if ethertype == 0x86DD:
            return {"protocol": "IPv6", "src": None, "dst": None, "info": f"length {len(payload)}"}
        return {"protocol": f"0x{ethertype:04x}", "src": None, "dst": None, "info": f"length {len(payload)}"}
    except Exception:
        return {"protocol": "?", "src": None, "dst": None, "info": f"unparsed frame, length {len(data)}"}


class PcapStreamDecoder:
    """Feed it raw bytes as they arrive over the capture socket; get back
    any packets that are now fully buffered, decoded to
    (timestamp, frame_length, record) triples, where record is the dict
    from decode_packet() and frame_length is the packet's original
    on-the-wire length (Wireshark's "Length" column) - separate from how
    many bytes tcpdump actually captured, in case of a snaplen cutoff.
    Handles the stream being split across chunks at arbitrary byte
    boundaries - a header or record is only consumed once all of it has
    arrived."""

    GLOBAL_HEADER_LEN = 24
    RECORD_HEADER_LEN = 16
    MAGIC_USEC = 0xA1B2C3D4
    MAGIC_NSEC = 0xA1B23C4D

    def __init__(self):
        self._buf = bytearray()
        self._byte_order = "<"
        self._nsec = False
        self._linktype = 1
        self._header_parsed = False
        self._unrecognized = False

    def feed(self, chunk: bytes):
        self._buf += chunk
        out = []

        if not self._header_parsed:
            if len(self._buf) < self.GLOBAL_HEADER_LEN:
                return out
            header = bytes(self._buf[:self.GLOBAL_HEADER_LEN])
            del self._buf[:self.GLOBAL_HEADER_LEN]
            self._header_parsed = True

            magic_le = struct.unpack("<I", header[:4])[0]
            magic_be = struct.unpack(">I", header[:4])[0]
            if magic_le in (self.MAGIC_USEC, self.MAGIC_NSEC):
                self._byte_order, magic = "<", magic_le
            elif magic_be in (self.MAGIC_USEC, self.MAGIC_NSEC):
                self._byte_order, magic = ">", magic_be
            else:
                # Not a recognizable pcap global header - the raw bytes
                # are still saved to the file regardless, just no live
                # decoded text for this capture.
                self._unrecognized = True
                return out
            self._nsec = magic == self.MAGIC_NSEC
            self._linktype = struct.unpack(self._byte_order + "I", header[20:24])[0]

        if self._unrecognized:
            return out

        while len(self._buf) >= self.RECORD_HEADER_LEN:
            ts_sec, ts_frac, incl_len, orig_len = struct.unpack(
                self._byte_order + "IIII", bytes(self._buf[:self.RECORD_HEADER_LEN])
            )
            if len(self._buf) < self.RECORD_HEADER_LEN + incl_len:
                break  # rest of this packet hasn't arrived yet

            data = bytes(self._buf[self.RECORD_HEADER_LEN:self.RECORD_HEADER_LEN + incl_len])
            del self._buf[:self.RECORD_HEADER_LEN + incl_len]

            frac = ts_frac / 1_000_000_000 if self._nsec else ts_frac / 1_000_000
            ts = datetime.fromtimestamp(ts_sec + frac, tz=timezone.utc)
            out.append((ts, orig_len, decode_packet(data, self._linktype)))

        return out
