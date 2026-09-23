import asyncio
import re
import shutil
import ssl
import zlib

from . import proc

# The AP's own cert is self-signed (embedded device, no real CA chain) -
# this leg is Pi-to-AP on its own subnet, not exposed to anything else, so
# skip verification rather than fail every connection on an untrusted cert.
_INSECURE_TLS_CONTEXT = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
_INSECURE_TLS_CONTEXT.check_hostname = False
_INSECURE_TLS_CONTEXT.verify_mode = ssl.CERT_NONE

# Response content types worth scanning for hardcoded references to the
# AP's own address - see WebUiProxyMixin._rewrite_body_host_refs.
_REWRITABLE_TEXT_CONTENT_TYPES = (
    "text/html", "text/javascript", "application/javascript",
    "application/json", "text/css", "text/plain",
)
# (literal scheme in the page, scheme to rewrite it to on our plain-HTTP-
# facing proxy port). wss/https get downgraded to ws/http because the
# client is talking to this proxy over plain HTTP, not TLS - a page loaded
# over http can still open a ws:// (or even wss://) connection without
# hitting mixed-content blocking, but this proxy itself only speaks plain
# HTTP/WS on the client-facing side, so wss:// would just fail to connect.
_BODY_SCHEME_REWRITES = (("wss://", "ws://"), ("https://", "http://"),
                          ("ws://", "ws://"), ("http://", "http://"))


class WebUiProxyMixin:
    """AP web UI proxy - the tester's browser can't reach an AP's own subnet
    directly - only this Pi can, since it's the one actually associated to
    that AP. Runs a small HTTP-level reverse proxy on this Pi rather than
    plain iptables DNAT/MASQUERADE, which this used to be: a pure L3/L4 NAT
    forwards bytes but never touches the Host/Origin/Referer headers the
    client's browser sends, which still name the Pi's own proxy address.
    Many AP web UIs validate those headers on login (CSRF/anti-hijack
    checks) and silently reject an otherwise-correct login when they don't
    match the AP's own address - this is why login worked from a device
    connected directly to the AP's hotspot but failed through this proxy.
    This proxy terminates the client's plain-HTTP request, rewrites those
    headers to the AP's gateway address, and forwards it to <gateway>:
    <target_port> - the AP's own web UI port, which varies by device model
    and is passed in per-call. Port 443 is assumed HTTPS with a self-signed
    cert (skips verification for that leg - see _INSECURE_TLS_CONTEXT), any
    other port is assumed plain HTTP. Then rewrites any
    Location redirect back to the address the client actually used before
    relaying the response. Relies on self._default_gateway_for (WifiMixin,
    wifi.py).

    Text response bodies (HTML/JS/JSON/CSS) also get a best-effort string
    rewrite - see _rewrite_body_host_refs - for AP UIs whose JS hardcodes
    the AP's own address (e.g. building a JSON-RPC-over-WebSocket URL from
    a literal like `new WebSocket("wss://192.168.1.1/rpc")` instead of a
    relative one) rather than deriving it from window.location; header
    rewriting alone never touches page content, so without this the
    browser would try to open that connection straight to the AP - which
    it can't reach - and the WebSocket would simply never appear at all.

    Known limitation: this is plain string substitution, not a real HTML/
    JS parser - obfuscated or dynamically-constructed (e.g. string-
    concatenated at runtime) references to the AP's address won't match
    and will still break.
    """

    AP_WEBUI_TARGET_PORT = 443
    AP_WEBUI_PROXY_TTL_SECONDS = 300
    UPSTREAM_CONNECT_TIMEOUT = 10
    # Only used to find and remove rules left behind by the old iptables-
    # based implementation of this proxy - the current implementation never
    # adds rules under this (or any) comment itself.
    AP_WEBUI_PROXY_COMMENT_PREFIX = "piagent_webui_"

    @staticmethod
    def _webui_proxy_port_for(interface):
        """Deterministic per-interface port (same hashing pattern as
        _routing_table_for) so several interfaces' AP web UIs can be
        proxied concurrently without colliding, and repeated requests for
        the same interface always land on the same port."""
        return 18080 + (zlib.crc32(interface.encode()) % 1000)

    async def _cleanup_stale_webui_proxy_rules(self):
        """One-time migration sweep, run at startup: removes any DNAT/
        MASQUERADE iptables rules left behind by an older build of this
        agent that used raw NAT instead of this HTTP-level proxy. Those
        rules intercept traffic to the proxy port in the kernel, before it
        ever reaches this process's listening socket - if left in place,
        they silently redirect the port back to the old raw-NAT behavior
        (or a since-changed gateway) no matter what this class does, which
        is indistinguishable from the proxy not working at all. Safe to
        keep running on every startup indefinitely: a no-op once no such
        rules exist."""
        if not shutil.which("iptables-save"):
            return
        out = (await proc.run(["iptables-save", "-t", "nat"])).stdout
        for line in out.splitlines():
            if self.AP_WEBUI_PROXY_COMMENT_PREFIX not in line or not line.startswith("-A "):
                continue
            args = line[3:].split()
            await proc.run(["iptables", "-t", "nat", "-D", *args], timeout=15)

    def _arm_webui_proxy_ttl(self, interface):
        """A cancellable TTL: fires once, AP_WEBUI_PROXY_TTL_SECONDS from
        now, and can be cancelled to re-arm. Runs as a task so it dies with
        the agent rather than keeping anything alive past process exit."""
        async def expire():
            try:
                await asyncio.sleep(self.AP_WEBUI_PROXY_TTL_SECONDS)
            except asyncio.CancelledError:
                return
            await self._expire_webui_proxy(interface)

        task = asyncio.create_task(expire(), name=f"webui-proxy-ttl-{interface}")
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)
        return task

    async def _expire_webui_proxy(self, interface):
        async with self._webui_proxies_lock:
            entry = self._webui_proxies.pop(interface, None)
        if entry:
            await self._close_webui_server(entry["server"])

    @staticmethod
    async def _close_webui_server(server):
        server.close()
        try:
            await server.wait_closed()
        except Exception:
            pass

    async def start_ap_webui_proxy(self, interface, target_port=None):
        """(Re)starts, or extends the TTL of, the HTTP proxy for this
        interface's currently-connected AP. Auto-expires AP_WEBUI_PROXY_TTL_
        SECONDS after the last call that (re)armed it - not real traffic-
        idle detection, just "nobody's asked for this in N minutes" - so a
        forgotten tab doesn't leave a listener open indefinitely.

        target_port is the AP's own web UI port - it varies by device
        model, so callers pass whatever their AP actually listens on
        (defaults to AP_WEBUI_TARGET_PORT, 443, if omitted). Port 443 is
        assumed to be HTTPS with a self-signed cert (the common case for
        these devices); anything else is assumed to be plain HTTP."""
        if not interface:
            return {"error": "interface is required"}
        try:
            target_port = int(target_port) if target_port else self.AP_WEBUI_TARGET_PORT
        except (TypeError, ValueError):
            return {"error": f"invalid target_port: {target_port!r}"}
        gateway = await self._default_gateway_for(interface)
        if not gateway:
            return {"error": f"{interface} has no known gateway (not connected to an AP?)"}
        port = self._webui_proxy_port_for(interface)

        async with self._webui_proxies_lock:
            existing = self._webui_proxies.get(interface)

            if existing and existing["gateway"] == gateway and existing["target_port"] == target_port:
                # Same AP/port still proxied - just extend the TTL, the
                # listener is already bound and pointed at the right place.
                existing["timer"].cancel()
                existing["timer"] = self._arm_webui_proxy_ttl(interface)
                return {"interface": interface, "port": port, "gateway": gateway,
                         "target_port": target_port, "applied": True}

            if existing:
                # Reconnected to a different AP, or a different port on the
                # same one, since the last proxy - tear down the old
                # listener before binding the new one.
                existing["timer"].cancel()
                await self._close_webui_server(existing["server"])

            try:
                server = await asyncio.start_server(
                    lambda r, w, gw=gateway, tp=target_port: self._handle_webui_client(r, w, gw, tp),
                    "0.0.0.0", port,
                )
            except OSError as e:
                return {"error": f"could not bind proxy port {port}: {e}"}

            self._webui_proxies[interface] = {
                "port": port, "gateway": gateway, "target_port": target_port, "server": server,
                "timer": self._arm_webui_proxy_ttl(interface),
            }

        return {"interface": interface, "port": port, "gateway": gateway,
                 "target_port": target_port, "applied": True}

    async def _handle_webui_client(self, reader, writer, gateway, target_port):
        """One client HTTP exchange: read the request off `reader`, rewrite
        Host/Origin/Referer to point at the AP's gateway instead of this
        Pi, forward to <gateway>:<target_port>, then rewrite any Location
        redirect back to the address the client actually used before
        relaying the response.

        A WebSocket upgrade (Connection: Upgrade / Upgrade: websocket - the
        AP UI's login flow uses one, per its own comment - see
        _relay_websocket) skips the Connection: close this otherwise forces
        on both legs, and on a successful 101 response hands off to a raw
        bidirectional byte relay instead of the one-shot request/response
        path, since after the handshake this is no longer HTTP at all."""
        try:
            request_line, headers, body = await self._read_http_message(reader)
        except (asyncio.IncompleteReadError, ConnectionError, ValueError):
            writer.close()
            return
        if request_line is None:
            writer.close()
            return

        client_host = headers.get("Host", gateway)
        is_websocket = (headers.get("Upgrade", "").lower() == "websocket"
                         and "upgrade" in headers.get("Connection", "").lower())

        headers["Host"] = gateway
        for name in ("Origin", "Referer"):
            if name in headers:
                headers[name] = self._rewrite_url_host(headers[name], gateway)
        if not is_websocket:
            headers["Connection"] = "close"
            # Force an uncompressed response so _rewrite_body_host_refs can
            # actually decode and scan it - a gzip/br body would fail the
            # UTF-8 decode there and silently skip the rewrite entirely.
            headers["Accept-Encoding"] = "identity"

        try:
            upstream_reader, upstream_writer = await asyncio.wait_for(
                asyncio.open_connection(
                    gateway, target_port,
                    ssl=_INSECURE_TLS_CONTEXT if target_port == 443 else None,
                ),
                self.UPSTREAM_CONNECT_TIMEOUT,
            )
        except (OSError, asyncio.TimeoutError):
            await self._send_and_close(writer, b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
            return

        try:
            upstream_writer.write(self._serialize_message(request_line, headers, body))
            await upstream_writer.drain()

            status_line, resp_headers, resp_body = await self._read_http_message(upstream_reader)
            if status_line is None:
                writer.close()
                return

            if is_websocket and status_line.split(" ", 2)[1:2] == ["101"]:
                # Handshake succeeded - forward the 101 response as-is (its
                # Connection/Upgrade headers are already correct) and switch
                # to a raw relay; this call owns closing both sockets from
                # here, so skip the generic finally-block close below.
                writer.write(self._serialize_message(status_line, resp_headers, b""))
                await writer.drain()
                await self._relay_websocket(reader, writer, upstream_reader, upstream_writer)
                return

            if "Location" in resp_headers:
                resp_headers["Location"] = self._rewrite_url_host(
                    resp_headers["Location"], client_host, from_host=gateway,
                )

            if resp_body and self._is_rewritable_text(resp_headers.get("Content-Type", "")):
                rewritten = self._rewrite_body_host_refs(resp_body, gateway, target_port, client_host)
                if rewritten != resp_body:
                    resp_body = rewritten
                    resp_headers["Content-Length"] = str(len(resp_body))

            resp_headers["Connection"] = "close"

            await self._send_and_close(writer, self._serialize_message(status_line, resp_headers, resp_body))
        finally:
            upstream_writer.close()
            try:
                await upstream_writer.wait_closed()
            except Exception:
                pass

    @staticmethod
    async def _relay_websocket(client_reader, client_writer, upstream_reader, upstream_writer):
        """Glues client and upstream sockets together after a successful
        WebSocket upgrade: no frame inspection, just raw bytes shuttled in
        both directions until either side closes or errors, at which point
        both ends are torn down (so a client that never closes doesn't
        leave the other pump - and this connection - waiting forever)."""
        async def pump(src, dst):
            try:
                while True:
                    data = await src.read(65536)
                    if not data:
                        break
                    dst.write(data)
                    await dst.drain()
            except (ConnectionError, OSError):
                pass

        tasks = [
            asyncio.create_task(pump(client_reader, upstream_writer)),
            asyncio.create_task(pump(upstream_reader, client_writer)),
        ]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            for w in (client_writer, upstream_writer):
                w.close()
            for w in (client_writer, upstream_writer):
                try:
                    await w.wait_closed()
                except Exception:
                    pass

    @staticmethod
    async def _send_and_close(writer, data):
        try:
            writer.write(data)
            await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

    @staticmethod
    async def _read_http_message(reader):
        """Reads one HTTP/1.1 message (request or response) off `reader`:
        start line, headers (as a dict keyed by canonical header name), and
        body. Body length comes from Content-Length when present;
        Transfer-Encoding: chunked bodies are de-chunked into a single blob
        - the AP web UIs this proxies are simple embedded servers (config
        pages, forms), not large enough to need streaming. Returns
        (None, None, None) on a closed/empty connection."""
        try:
            head = await reader.readuntil(b"\r\n\r\n")
        except asyncio.IncompleteReadError as e:
            if not e.partial:
                return None, None, None
            raise
        except asyncio.LimitOverrunError:
            raise ValueError("header block too large")

        lines = head.decode("iso-8859-1").split("\r\n")
        start_line = lines[0]
        headers = {}
        for line in lines[1:]:
            if not line or ":" not in line:
                continue
            name, _, value = line.partition(":")
            headers[name.strip()] = value.strip()

        body = b""
        content_length = headers.get("Content-Length")
        transfer_encoding = headers.get("Transfer-Encoding", "").lower()
        if content_length is not None:
            try:
                n = int(content_length)
            except ValueError:
                n = 0
            if n > 0:
                body = await reader.readexactly(n)
        elif "chunked" in transfer_encoding:
            body = await WebUiProxyMixin._read_chunked_body(reader)
            del headers["Transfer-Encoding"]
            headers["Content-Length"] = str(len(body))

        return start_line, headers, body

    @staticmethod
    async def _read_chunked_body(reader):
        chunks = []
        while True:
            size_line = await reader.readuntil(b"\r\n")
            size = int(size_line.strip().split(b";")[0], 16)
            if size == 0:
                await reader.readuntil(b"\r\n")  # trailing CRLF after final chunk
                break
            chunks.append(await reader.readexactly(size))
            await reader.readexactly(2)  # CRLF after chunk data
        return b"".join(chunks)

    @staticmethod
    def _serialize_message(start_line, headers, body):
        lines = [start_line]
        for name, value in headers.items():
            lines.append(f"{name}: {value}")
        head = "\r\n".join(lines).encode("iso-8859-1") + b"\r\n\r\n"
        return head + body

    @staticmethod
    def _rewrite_url_host(value, new_host, from_host=None):
        """Rewrites the host portion of a Host/Origin/Referer/Location
        header value to `new_host`. Host/Origin/Referer are host-only or
        absolute-URL values that should always be pointed at the AP; give
        `from_host` (used for Location) to only rewrite when the existing
        host actually matches it, since a redirect may legitimately point
        somewhere else entirely and shouldn't be touched."""
        m = re.match(r'^(https?://)([^/]+)(.*)$', value, re.IGNORECASE)
        if not m:
            if from_host is not None:
                return value
            return new_host
        scheme, host, rest = m.groups()
        if from_host is not None and host != from_host and not host.startswith(from_host + ":"):
            return value
        return f"{scheme}{new_host}{rest}"

    @staticmethod
    def _is_rewritable_text(content_type):
        ct = content_type.split(";")[0].strip().lower()
        return any(ct.startswith(t) for t in _REWRITABLE_TEXT_CONTENT_TYPES)

    @staticmethod
    def _rewrite_body_host_refs(body, gateway, target_port, client_host):
        """Best-effort rewrite of hardcoded references to the AP's own
        address inside HTML/JS/JSON response bodies, so client-side code
        that builds a URL from a literal baked into the page (e.g.
        `new WebSocket("wss://192.168.1.1/rpc")`) talks back through this
        proxy instead of trying to reach the AP directly - which the
        browser can't do, since only this Pi is actually associated to
        that AP's subnet. Header rewriting (Host/Origin/Referer/Location)
        never touches page content, so this is the other half of that.

        Plain string substitution, not an HTML/JS parser: code that builds
        the URL dynamically from window.location at runtime is untouched,
        but doesn't need rewriting anyway - it already resolves against
        the proxy address the browser actually loaded the page from."""
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError:
            return body  # binary asset with a text-ish content-type - leave alone

        gateway_forms = (f"{gateway}:{target_port}", gateway)
        original = text
        for scheme_from, scheme_to in _BODY_SCHEME_REWRITES:
            for form in gateway_forms:
                text = text.replace(f"{scheme_from}{form}", f"{scheme_to}{client_host}")

        if text == original:
            return body
        return text.encode("utf-8")
