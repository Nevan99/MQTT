"""Incremental decoder for a classic-format pcap byte stream (what
`tcpdump -w -` produces), turning captured frames into short tcpdump-style
text summaries as the bytes arrive - used to give a live text view of a
pcap capture without waiting for it to finish and without a second capture
process, reusing exactly the bytes already being written to disk for the
saved .pcap file.

Deliberately not full tcpdump fidelity - just enough (addresses, ports,
TCP flags/seq/ack/win, protocol) to be useful reading it as a live log.
"""
import socket as socket_lib
import struct
from datetime import datetime, timezone

ETH_HEADER_LEN = 14
SLL_HEADER_LEN = 16  # Linux "cooked" capture (linktype 113)

_TCP_FLAG_BITS = [
    (0x01, "F"), (0x02, "S"), (0x04, "R"), (0x08, "P"),
    (0x10, "."), (0x20, "U"), (0x40, "E"), (0x80, "C"),
]
_PROTO_NAMES = {1: "ICMP", 6: "TCP", 17: "UDP"}


def _tcp_flags_str(flags):
    return "".join(ch for bit, ch in _TCP_FLAG_BITS if flags & bit) or "."


def _decode_ipv4(payload):
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
        return (f"{src}.{sport} > {dst}.{dport}: Flags [{_tcp_flags_str(flags)}], "
                f"seq {seq}, ack {ack}, win {win}, length {data_len}")
    if proto == 17 and len(body) >= 8:  # UDP
        sport, dport, udp_len = struct.unpack("!HHH", body[0:6])
        return f"{src}.{sport} > {dst}.{dport}: UDP, length {max(udp_len - 8, 0)}"
    if proto == 1 and body:  # ICMP
        return f"{src} > {dst}: ICMP type {body[0]}, length {len(body)}"
    return f"{src} > {dst}: {_PROTO_NAMES.get(proto, f'proto {proto}')}, length {len(body)}"


def _decode_arp(payload):
    if len(payload) < 28:
        return None
    op = struct.unpack("!H", payload[6:8])[0]
    src_ip = socket_lib.inet_ntoa(payload[14:18])
    dst_ip = socket_lib.inet_ntoa(payload[24:28])
    verb = "Request" if op == 1 else "Reply" if op == 2 else f"op {op}"
    return f"ARP, {verb}, {src_ip} > {dst_ip}"


def decode_packet(data: bytes, linktype: int) -> str:
    """Decode one captured frame's bytes into a one-line summary."""
    try:
        if linktype == 113 and len(data) >= SLL_HEADER_LEN:
            ethertype = struct.unpack("!H", data[14:16])[0]
            payload = data[SLL_HEADER_LEN:]
        elif len(data) >= ETH_HEADER_LEN:
            ethertype = struct.unpack("!H", data[12:14])[0]
            payload = data[ETH_HEADER_LEN:]
        else:
            return f"truncated frame, length {len(data)}"

        if ethertype == 0x0800:
            return _decode_ipv4(payload) or f"IP, length {len(payload)}"
        if ethertype == 0x0806:
            return _decode_arp(payload) or f"ARP, length {len(payload)}"
        if ethertype == 0x86DD:
            return f"IPv6, length {len(payload)}"
        return f"ethertype 0x{ethertype:04x}, length {len(payload)}"
    except Exception:
        return f"unparsed frame, length {len(data)}"


class PcapStreamDecoder:
    """Feed it raw bytes as they arrive over the capture socket; get back
    any packets that are now fully buffered, decoded to (timestamp,
    message) pairs. Handles the stream being split across chunks at
    arbitrary byte boundaries - a header or record is only consumed once
    all of it has arrived."""

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
            ts_sec, ts_frac, incl_len, _orig_len = struct.unpack(
                self._byte_order + "IIII", bytes(self._buf[:self.RECORD_HEADER_LEN])
            )
            if len(self._buf) < self.RECORD_HEADER_LEN + incl_len:
                break  # rest of this packet hasn't arrived yet

            data = bytes(self._buf[self.RECORD_HEADER_LEN:self.RECORD_HEADER_LEN + incl_len])
            del self._buf[:self.RECORD_HEADER_LEN + incl_len]

            frac = ts_frac / 1_000_000_000 if self._nsec else ts_frac / 1_000_000
            ts = datetime.fromtimestamp(ts_sec + frac, tz=timezone.utc)
            out.append((ts, decode_packet(data, self._linktype)))

        return out
