import json
import socket
import subprocess
import threading
import time
from datetime import datetime, timezone


class StreamingMixin:
    """Live view streaming (syslog/tcpdump over a socket to the backend),
    pcap capture recording, and the throughput/syslog-dump one-shot actions.
    See PiAgent (core.py) for the locks/state this relies on
    (self._pcap_*, self._streaming_*, self._tcpdump_*)."""

    def run_iperf_server_test(self, duration=10, interface=None):
        """Runs the throughput test against the broker host. Without an
        interface, iperf3 goes out over whatever the OS routing table picks
        for that destination - same as before. With one, `-B <local-ip>`
        binds the client socket to that interface's own address, so the
        test actually measures that interface's link instead of whichever
        one happens to win the route (this Pi could have several, e.g. a
        wired eth0 and several wifi radios all able to reach the broker)."""
        cmd = ["iperf3", "-c", self.broker_host, "-t", str(duration), "-J"]
        if interface:
            bind_ip = self.get_interface_ip(interface)
            if not bind_ip:
                return {"error": f"{interface} has no IPv4 address to bind to"}
            cmd += ["-B", bind_ip]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=duration + 15)
        data = json.loads(result.stdout)
        return {
            "interface": interface,
            "throughput_mbps": data["end"]["sum_received"]["bits_per_second"] / 1e6,
            "retransmits": data["end"]["sum_sent"].get("retransmits"),
        }

    def get_syslog(self, lines=100):
        """Pull recent journal lines."""
        out = subprocess.run(
            ["journalctl", "-n", str(lines), "--no-pager"],
            capture_output=True, text=True,
        ).stdout
        return out.splitlines()

    def start_pcap_capture(self, interface, name=None):
        """Start a pcap capture for one interface, piped live to the backend's
        capture socket server as tcpdump produces it - independent of the
        parsed-line tcpdump stream (both can run on the same interface at
        once). Streaming continuously instead of writing to a local file
        means stop only has to close a socket, not upload a whole finished
        file - that upload-at-the-end approach was why stopping a capture
        used to take so long."""
        with self._pcap_lock:
            if interface in self._pcap_procs:
                return False
            proc = subprocess.Popen(
                ["tcpdump", "-i", interface, "-w", "-", "-U"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
            )
            # tcpdump fails fast on a bad interface or missing capture
            # permissions (needs root or cap_net_raw+cap_net_admin). Without
            # this check, start would report success even though tcpdump
            # already died.
            time.sleep(0.3)
            if proc.poll() is not None:
                output = proc.stderr.read().decode(errors="replace").strip() if proc.stderr else ""
                raise RuntimeError(output or f"tcpdump exited immediately (code {proc.returncode})")

            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.connect((self.capture_socket_host, self.capture_socket_port))
            capture_name = name or f"{self.pi_id}-pcap-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}"
            sock.sendall((json.dumps({
                "kind": "record", "pi_id": self.pi_id, "name": capture_name, "interface": interface,
            }) + "\n").encode())

            state = {"error": None, "capture_id": None, "byte_count": 0, "done": threading.Event()}
            thread = threading.Thread(target=self._relay_pcap, args=(proc, sock, state), daemon=True)
            thread.start()

            self._pcap_procs[interface] = proc
            self._pcap_state[interface] = state
        return True

    def _relay_pcap(self, proc, sock, state):
        """Pump tcpdump's stdout into the capture socket until tcpdump exits
        (stdout hits EOF), then half-close the socket and read the backend's
        ack off the same connection."""
        try:
            while True:
                chunk = proc.stdout.read(65536)
                if not chunk:
                    break
                sock.sendall(chunk)
        except Exception as e:
            state["error"] = str(e)
        finally:
            try:
                sock.shutdown(socket.SHUT_WR)
            except OSError:
                pass
            try:
                ack_line = sock.makefile("r").readline()
                ack = json.loads(ack_line) if ack_line else {}
                state["capture_id"] = ack.get("capture_id")
                state["byte_count"] = ack.get("byte_count", 0)
                if ack.get("error"):
                    state["error"] = state["error"] or ack["error"]
            except Exception as e:
                state["error"] = state["error"] or str(e)
            finally:
                sock.close()
                state["done"].set()

    def stop_pcap_capture(self, interface):
        """Stop the pcap capture for an interface and return the saved
        capture's metadata once the relay thread's socket stream finishes."""
        with self._pcap_lock:
            proc = self._pcap_procs.pop(interface, None)
            state = self._pcap_state.pop(interface, None)
        if proc is None:
            return {"error": f"no pcap capture running on {interface}"}

        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)

        if not state["done"].wait(timeout=15):
            return {"error": "timed out waiting for the capture upload to finish", "interface": interface}

        if state["error"]:
            return {"error": state["error"], "interface": interface}

        return {
            "interface": interface,
            "byte_count": state["byte_count"],
            "capture_id": state["capture_id"],
            "saved": True,
        }

    def _stream_tcpdump_socket(self, interface, proc, state):
        """Pump this view-only tcpdump process's stdout to the backend over
        a socket connection tagged kind=stream_tcpdump - decoded to text and
        relayed live by the backend, never written to a capture file (that's
        start_pcap_capture's job, a wholly separate tcpdump process)."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.connect((self.capture_socket_host, self.capture_socket_port))
            sock.sendall((json.dumps({
                "kind": "stream_tcpdump", "pi_id": self.pi_id, "interface": interface,
            }) + "\n").encode())
            while True:
                # Small read size (vs. 65536) so packets on a quiet
                # interface get forwarded as soon as tcpdump -U flushes
                # them, instead of sitting in the pipe until a large chunk
                # fills up.
                chunk = proc.stdout.read(4096)
                if not chunk:
                    break
                sock.sendall(chunk)
        except Exception as e:
            state["error"] = str(e)
        finally:
            try:
                sock.close()
            except OSError:
                pass
            with self._tcpdump_lock:
                self._tcpdump_running.discard(interface)
                self._tcpdump_procs.pop(interface, None)

    def start_tcpdump_stream(self, interface):
        """Start a live decoded-tcpdump view for one interface, no-op if
        already running. Independent of start_pcap_capture - both can run
        on the same interface at once, one for viewing, one for saving."""
        with self._tcpdump_lock:
            if interface in self._tcpdump_running:
                return False
            proc = subprocess.Popen(
                ["tcpdump", "-i", interface, "-w", "-", "-U"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
            )
            time.sleep(0.3)
            if proc.poll() is not None:
                output = proc.stderr.read().decode(errors="replace").strip() if proc.stderr else ""
                raise RuntimeError(output or f"tcpdump exited immediately (code {proc.returncode})")
            state = {"error": None}
            self._tcpdump_running.add(interface)
            self._tcpdump_procs[interface] = proc
        threading.Thread(target=self._stream_tcpdump_socket, args=(interface, proc, state), daemon=True).start()
        return True

    def stop_tcpdump_stream(self, interface):
        """Stop the tcpdump view for one interface, if running."""
        with self._tcpdump_lock:
            if interface not in self._tcpdump_running:
                return False
            self._tcpdump_running.discard(interface)
            proc = self._tcpdump_procs.pop(interface, None)
        if proc:
            proc.terminate()
        return True

    def _stream_syslog_socket(self, interface, proc):
        """Pump journalctl -f's output to the backend over a socket
        connection tagged kind=stream_syslog - relayed live as text lines,
        never persisted (same "view only" contract as stream_tcpdump)."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.connect((self.capture_socket_host, self.capture_socket_port))
            sock.sendall((json.dumps({
                "kind": "stream_syslog", "pi_id": self.pi_id, "interface": interface,
            }) + "\n").encode())
            for line in proc.stdout:
                sock.sendall((line.rstrip("\n") + "\n").encode())
        except Exception:
            pass
        finally:
            try:
                sock.close()
            except OSError:
                pass
            with self._streaming_lock:
                if self._syslog_proc is proc:
                    self._streaming_started = False
                    self._syslog_proc = None
                    self._syslog_interface = None

    def start_syslog_stream(self, interface=None):
        """Start the syslog streaming thread for the given interface filter.
        """
        cmd = ["journalctl", "-u", "NetworkManager", "-n", "50", "-f"]
        if interface:
            cmd += ["-g", interface]

        old_proc = None
        with self._streaming_lock:
            if self._streaming_started and self._syslog_interface == interface:
                return False
            if self._streaming_started:
                old_proc = self._syslog_proc
            self._streaming_started = True
            self._syslog_interface = interface
        if old_proc:
            old_proc.terminate()

        # bufsize=1 (line-buffered) so `for line in proc.stdout` yields each
        # journal line as soon as journalctl writes it, instead of Python's
        # default block-buffering on a non-tty pipe holding lines back until
        # a full buffer's worth accumulates.
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True, bufsize=1)
        with self._streaming_lock:
            self._syslog_proc = proc
        threading.Thread(target=self._stream_syslog_socket, args=(interface, proc), daemon=True).start()
        return True

    def stop_syslog_stream(self):
        """Stop the syslog streaming thread, if running."""
        with self._streaming_lock:
            if not self._streaming_started:
                return False
            self._streaming_started = False
            self._syslog_interface = None
            proc = self._syslog_proc
            self._syslog_proc = None
        if proc:
            proc.terminate()
        return True
