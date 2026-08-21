import shutil
import subprocess
import threading
import zlib


class WebUiProxyMixin:
    """AP web UI proxy - the tester's browser can't reach an AP's own subnet
    directly - only this Pi can, since it's the one actually associated to
    that AP. So instead of the browser trying (and failing) to open the
    gateway IP itself, the Pi relays: DNAT whatever arrives at this Pi's own
    registered IP on a per-interface port to <gateway>:80, and MASQUERADE
    the reply path so the AP answers the Pi rather than trying (and
    failing) to reach the tester directly. Relies on self._default_gateway_for
    (WifiMixin, wifi.py)."""

    AP_WEBUI_TARGET_PORT = 80
    AP_WEBUI_PROXY_TTL_SECONDS = 300
    AP_WEBUI_PROXY_COMMENT_PREFIX = "piagent_webui_"

    @staticmethod
    def _webui_proxy_port_for(interface):
        """Deterministic per-interface port (same hashing pattern as
        _routing_table_for) so several interfaces' AP web UIs can be
        proxied concurrently without colliding, and repeated requests for
        the same interface always land on the same port."""
        return 18080 + (zlib.crc32(interface.encode()) % 1000)

    def _webui_proxy_comment(self, interface):
        return f"{self.AP_WEBUI_PROXY_COMMENT_PREFIX}{interface}"

    def _webui_proxy_rule_args(self, interface, port, gateway):
        comment = self._webui_proxy_comment(interface)
        dnat = ["PREROUTING", "-p", "tcp", "--dport", str(port),
                "-m", "comment", "--comment", comment,
                "-j", "DNAT", "--to-destination", f"{gateway}:{self.AP_WEBUI_TARGET_PORT}"]
        masq = ["POSTROUTING", "-d", gateway, "-p", "tcp", "--dport", str(self.AP_WEBUI_TARGET_PORT),
                "-m", "comment", "--comment", comment,
                "-j", "MASQUERADE"]
        return dnat, masq

    def _teardown_webui_proxy_rules(self, interface, port, gateway):
        dnat, masq = self._webui_proxy_rule_args(interface, port, gateway)
        subprocess.run(["iptables", "-t", "nat", "-D", *dnat], capture_output=True, text=True, timeout=15)
        subprocess.run(["iptables", "-t", "nat", "-D", *masq], capture_output=True, text=True, timeout=15)

    def _cleanup_stale_webui_proxy_rules(self):
        """Removes any DNAT/MASQUERADE rules a previous run of this agent
        added and never got to expire - e.g. the service was restarted
        while a proxy's TTL timer was still pending, which drops the
        in-process Timer but leaves the actual kernel iptables rule behind
        forever, since nothing else would ever remove it. Run once at
        startup so a restart can't leak a rule."""
        if not shutil.which("iptables-save"):
            return
        out = subprocess.run(["iptables-save", "-t", "nat"], capture_output=True, text=True).stdout
        for line in out.splitlines():
            if self.AP_WEBUI_PROXY_COMMENT_PREFIX not in line or not line.startswith("-A "):
                continue
            args = line[3:].split()
            subprocess.run(["iptables", "-t", "nat", "-D", *args], capture_output=True, text=True, timeout=15)

    def _expire_webui_proxy(self, interface):
        with self._webui_proxies_lock:
            entry = self._webui_proxies.pop(interface, None)
        if entry:
            self._teardown_webui_proxy_rules(interface, entry["port"], entry["gateway"])

    def start_ap_webui_proxy(self, interface):
        """(Re)starts, or extends the TTL of, the DNAT proxy for this
        interface's currently-connected AP. Auto-expires AP_WEBUI_PROXY_TTL_
        SECONDS after the last call that (re)armed it - not real traffic-
        idle detection, just "nobody's asked for this in N minutes" - so a
        forgotten tab doesn't leave a NAT rule open indefinitely."""
        if not interface:
            return {"error": "interface is required"}
        if not shutil.which("iptables"):
            return {"error": "iptables is not installed on this Pi - run: sudo apt-get install iptables"}
        gateway = self._default_gateway_for(interface)
        if not gateway:
            return {"error": f"{interface} has no known gateway (not connected to an AP?)"}
        port = self._webui_proxy_port_for(interface)

        with self._webui_proxies_lock:
            existing = self._webui_proxies.get(interface)

            if existing and existing["gateway"] == gateway:
                # Same AP still proxied - just extend the TTL, no need to
                # touch the (already-correct) iptables rules.
                existing["timer"].cancel()
                timer = threading.Timer(self.AP_WEBUI_PROXY_TTL_SECONDS, self._expire_webui_proxy, args=(interface,))
                timer.daemon = True
                timer.start()
                existing["timer"] = timer
                return {"interface": interface, "port": port, "gateway": gateway, "applied": True}

            if existing:
                # Reconnected to a different AP since the last proxy - drop
                # the stale rule pointing at the old gateway first.
                existing["timer"].cancel()
                self._teardown_webui_proxy_rules(interface, existing["port"], existing["gateway"])

            subprocess.run(["sysctl", "-w", "net.ipv4.ip_forward=1"], capture_output=True, text=True, timeout=10)

            dnat, masq = self._webui_proxy_rule_args(interface, port, gateway)
            dnat_ret = subprocess.run(["iptables", "-t", "nat", "-A", *dnat], capture_output=True, text=True, timeout=15)
            masq_ret = subprocess.run(["iptables", "-t", "nat", "-A", *masq], capture_output=True, text=True, timeout=15)
            if dnat_ret.returncode != 0 or masq_ret.returncode != 0:
                return {"error": (dnat_ret.stderr or masq_ret.stderr or "iptables rule failed").strip()}

            timer = threading.Timer(self.AP_WEBUI_PROXY_TTL_SECONDS, self._expire_webui_proxy, args=(interface,))
            timer.daemon = True
            timer.start()
            self._webui_proxies[interface] = {"port": port, "gateway": gateway, "timer": timer}

        return {"interface": interface, "port": port, "gateway": gateway, "applied": True}
