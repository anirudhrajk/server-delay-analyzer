"""
website.py  -  where does the delay of a web page come from?
============================================================
For one address we:
  1. follow redirects, timing each hop;
  2. load the page several times on fresh connections, timing every phase:
         DNS lookup -> TCP connect -> TLS (secure) setup -> server wait -> download
  3. send two requests on one kept-alive connection, to measure what reusing a
     connection saves (the "setup cost per batch" idea from our formula);
  4. read the HTML and time every script, stylesheet, image and frame it loads
     (6 at a time, like a browser), at most MAX_RESOURCES files.

It is a gentle check: about the same number of requests as one visit with a
browser. It never sends floods of requests (no load testing).

Time to first byte is graded with Google's published thresholds (web.dev):
good <= 800 ms, poor > 1800 ms.
"""
import gzip
import http.client
import ipaddress
import os
import socket
import ssl
import statistics
import time
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urlunsplit

from .common import (ScanError, cause, fmt_bytes, fmt_ms, median, sort_causes, spread, stat, table)

UA = "ServerDelayAnalyzer/2.0 (local page-speed check)"
TIMEOUT = 15
MAX_BODY = 20 * 1024 * 1024        # stop downloading one file after 20 MB
MAX_HTML_PARSE = 4 * 1024 * 1024   # only read links from the first 4 MB of HTML
MAX_RESOURCES = 60
MAX_REDIRECTS = 8
PARALLEL = 6                       # browsers open about 6 connections per site

TTFB_GOOD, TTFB_POOR = 800.0, 1800.0
TEXT_TYPES = ("text/", "javascript", "json", "xml", "svg")

_ctx = None


def _ssl_context():
    """Windows' certificates plus the certifi bundle (some PCs lack intermediates)."""
    global _ctx
    if _ctx is None:
        ctx = ssl.create_default_context()
        try:
            import certifi
            ctx.load_verify_locations(certifi.where())
        except Exception:
            pass
        ctx.set_alpn_protocols(["http/1.1"])
        _ctx = ctx
    return _ctx


class FetchError(Exception):
    pass


def normalise_url(raw):
    raw = (raw or "").strip()
    if not raw:
        raise ScanError("Type a website address, for example https://example.com")
    if "://" not in raw:
        raw = "https://" + raw
    p = urlsplit(raw)
    if p.scheme not in ("http", "https"):
        raise ScanError("Only http:// and https:// addresses can be scanned.")
    if not p.hostname:
        raise ScanError("That does not look like a website address.")
    try:
        p.port
    except ValueError:
        raise ScanError("The port number in that address is not valid.")
    return urlunsplit((p.scheme, p.netloc, p.path or "/", p.query, ""))


def _host_header(p):
    host = p.hostname
    if ":" in host:
        host = f"[{host}]"
    default = 443 if p.scheme == "https" else 80
    return host if (p.port or default) == default else f"{host}:{p.port}"


def _open(p):
    """DNS + TCP + TLS on a fresh connection. Returns (sock, timings, ip, tls_version)."""
    https = p.scheme == "https"
    port = p.port or (443 if https else 80)
    t0 = time.perf_counter()
    try:
        infos = socket.getaddrinfo(p.hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise FetchError(f"Could not find the address of {p.hostname} (DNS lookup failed).")
    t1 = time.perf_counter()
    if os.environ.get("SDA_HOSTED") == "1":
        infos = [i for i in infos if ipaddress.ip_address(i[4][0].split("%")[0]).is_global]
        if not infos:
            raise FetchError(f"{p.hostname} is a private or internal address, which the website cannot scan.")
    sock, err, ip = None, None, None
    for fam, typ, proto, _, addr in infos[:4]:
        s = socket.socket(fam, typ, proto)
        s.settimeout(TIMEOUT)
        try:
            s.connect(addr)
            sock, ip = s, addr[0]
            break
        except OSError as e:
            err = e
            s.close()
    if sock is None:
        raise FetchError(f"Could not connect to {p.hostname}: {err}")
    t2 = time.perf_counter()
    tls = None
    if https:
        try:
            sock = _ssl_context().wrap_socket(sock, server_hostname=p.hostname)
        except ssl.SSLCertVerificationError as e:
            sock.close()
            raise FetchError(f"The security certificate of {p.hostname} is not valid ({e.verify_message}).")
        except (ssl.SSLError, OSError) as e:
            sock.close()
            raise FetchError(f"Secure connection to {p.hostname} failed: {e}")
        tls = sock.version()
    t3 = time.perf_counter()
    return sock, {"dns": (t1 - t0) * 1000, "connect": (t2 - t1) * 1000, "tls": (t3 - t2) * 1000}, ip, tls


def _request(conn, p, keep_alive, want_body):
    """Send GET on an open connection; time server wait and download."""
    path = (p.path or "/") + (("?" + p.query) if p.query else "")
    t0 = time.perf_counter()
    conn.putrequest("GET", path, skip_host=True, skip_accept_encoding=True)
    conn.putheader("Host", _host_header(p))
    conn.putheader("User-Agent", UA)
    conn.putheader("Accept", "text/html,application/xhtml+xml,*/*;q=0.8")
    conn.putheader("Accept-Encoding", "gzip, deflate")
    conn.putheader("Connection", "keep-alive" if keep_alive else "close")
    conn.endheaders()
    t1 = time.perf_counter()
    resp = conn.getresponse()
    t2 = time.perf_counter()
    size, keep, chunks = 0, [], 0
    while size < MAX_BODY:
        chunk = resp.read(65536)
        if not chunk:
            break
        size += len(chunk)
        if want_body and size <= MAX_HTML_PARSE + 65536:
            keep.append(chunk)
        chunks += 1
    t3 = time.perf_counter()
    headers = {k.lower(): v for k, v in resp.getheaders()}
    if not keep_alive or resp.will_close or size >= MAX_BODY:
        resp.close()
    return {
        "send": (t1 - t0) * 1000, "wait": (t2 - t1) * 1000, "download": (t3 - t2) * 1000,
        "status": resp.status, "reason": resp.reason, "headers": headers,
        "version": "HTTP/1.1" if resp.version == 11 else "HTTP/1.0",
        "bytes": size, "truncated": size >= MAX_BODY, "body": b"".join(keep) if want_body else b"",
        "will_close": resp.will_close,
    }


def timed_fetch(url, want_body=False):
    """One request on a brand-new connection, every phase timed in milliseconds."""
    p = urlsplit(url)
    sock, t, ip, tls = _open(p)
    conn = http.client.HTTPConnection(p.hostname, p.port or 80, timeout=TIMEOUT)
    conn.sock = sock
    try:
        r = _request(conn, p, keep_alive=False, want_body=want_body)
    except (OSError, http.client.HTTPException) as e:
        raise FetchError(f"The server at {p.hostname} did not answer properly: {e}")
    finally:
        conn.close()
    r.update(t)
    r.update({"url": url, "host": p.hostname, "ip": ip, "tls_version": tls})
    r["total"] = r["dns"] + r["connect"] + r["tls"] + r["send"] + r["wait"] + r["download"]
    r["ttfb"] = r["dns"] + r["connect"] + r["tls"] + r["send"] + r["wait"]
    return r


def keepalive_pair(url):
    """Two requests on one connection: returns (first, second) timings, or None if the server closes it."""
    p = urlsplit(url)
    sock, t, _, _ = _open(p)
    conn = http.client.HTTPConnection(p.hostname, p.port or 80, timeout=TIMEOUT)
    conn.sock = sock
    try:
        a = _request(conn, p, keep_alive=True, want_body=False)
        a.update(t)
        if a["will_close"]:
            return a, None
        b = _request(conn, p, keep_alive=False, want_body=False)
        return a, b
    except (OSError, http.client.HTTPException):
        return None, None
    finally:
        conn.close()


def _decode(body, encoding):
    encoding = (encoding or "").lower()
    try:
        if "gzip" in encoding:
            return gzip.decompress(body)
        if "deflate" in encoding:
            try:
                return zlib.decompress(body)
            except zlib.error:
                return zlib.decompress(body, -zlib.MAX_WBITS)
    except (OSError, EOFError, zlib.error):
        return b""
    return body


class _Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.found, self.in_head, self.base = [], True, None

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        has = lambda k: k in {x[0].lower() for x in attrs}
        if tag == "base" and a.get("href") and self.base is None:
            self.base = a["href"]
        elif tag == "body":
            self.in_head = False
        elif tag == "script" and a.get("src"):
            blocking = self.in_head and not has("async") and not has("defer") and a.get("type", "").lower() != "module"
            self.found.append(("script", a["src"], blocking, False))
        elif tag == "link" and a.get("href"):
            rel = a.get("rel", "").lower().split()
            if "stylesheet" in rel:
                media = a.get("media", "all").lower()
                self.found.append(("style", a["href"], self.in_head and media in ("", "all", "screen"), False))
            elif "preload" in rel or "modulepreload" in rel:
                self.found.append((a.get("as", "preload") or "preload", a["href"], False, False))
            elif "icon" in rel:
                self.found.append(("icon", a["href"], False, False))
        elif tag == "img":
            src = a.get("src") or (a.get("srcset", "").split(",")[0].strip().split(" ")[0])
            if src:
                self.found.append(("image", src, False, a.get("loading", "").lower() == "lazy"))
        elif tag == "iframe" and a.get("src"):
            self.found.append(("frame", a["src"], False, a.get("loading", "").lower() == "lazy"))


def find_resources(html_bytes, page_url, charset="utf-8"):
    try:
        text = html_bytes.decode(charset or "utf-8", errors="replace")
    except LookupError:
        text = html_bytes.decode("utf-8", errors="replace")
    parser = _Links()
    try:
        parser.feed(text)
    except Exception:
        pass
    base = urljoin(page_url, parser.base) if parser.base else page_url
    seen, out = set(), []
    for kind, ref, blocking, lazy in parser.found:
        ref = ref.strip()
        if not ref or ref.startswith(("data:", "javascript:", "blob:", "mailto:", "#", "about:")):
            continue
        u = urljoin(base, ref).split("#")[0]
        if urlsplit(u).scheme not in ("http", "https") or u in seen:
            continue
        seen.add(u)
        out.append({"kind": kind, "url": u, "blocking": blocking, "lazy": lazy})
    return out, len(seen)


def _is_text(ctype):
    ctype = (ctype or "").lower()
    return any(t in ctype for t in TEXT_TYPES)


def _cache_policy(h):
    cc = h.get("cache-control", "").lower()
    if "no-store" in cc:
        return "no-store"
    if "max-age=" in cc:
        try:
            age = int(cc.split("max-age=")[1].split(",")[0].strip())
            return f"{age}s" if age > 0 else "none"
        except ValueError:
            pass
    if h.get("expires"):
        return "expires"
    if "no-cache" in cc:
        return "revalidate"
    return "none"


def _short(url, n=70):
    p = urlsplit(url)
    s = (p.path or "/") + (("?" + p.query) if p.query else "")
    name = s.rsplit("/", 1)[-1] or s
    out = f"{p.hostname}…/{name}" if s.count("/") > 1 else f"{p.hostname}{s}"
    return out if len(out) <= n else out[: n - 1] + "…"


def scan_website(job, url, samples=3, check_files=True):
    url = normalise_url(url)
    samples = max(1, min(int(samples), 5))
    notes = []

    # ---- 1. follow redirects -------------------------------------------------
    hops, current, visited = [], url, set()
    job.update(0.03, f"Connecting to {urlsplit(url).hostname}…")
    while True:
        if current in visited:
            raise ScanError("The website redirects in a loop and never shows a page.")
        visited.add(current)
        try:
            r = timed_fetch(current, want_body=True)
        except FetchError as e:
            raise ScanError(str(e))
        loc = r["headers"].get("location")
        if r["status"] in (301, 302, 303, 307, 308) and loc:
            if len(hops) >= MAX_REDIRECTS:
                raise ScanError(f"More than {MAX_REDIRECTS} redirects. The site sends visitors round in circles.")
            hops.append(r)
            current = urljoin(current, loc)
            job.update(0.05 + 0.02 * len(hops), f"Redirected to {current}")
            continue
        break
    first = r
    final_url = current
    redirect_ms = sum(h["total"] for h in hops)

    # ---- 2. repeat visits on fresh connections -------------------------------
    visits = [first]
    for i in range(1, samples):
        job.update(0.12 + 0.18 * i / samples, f"Visit {i + 1} of {samples}…")
        try:
            visits.append(timed_fetch(final_url))
        except FetchError as e:
            notes.append(f"Visit {i + 1} failed: {e}")
    med = {k: median([v[k] for v in visits]) for k in ("dns", "connect", "tls", "send", "wait", "download", "total", "ttfb")}
    lo_total, hi_total = spread([v["total"] for v in visits])

    # ---- 3. reused connection --------------------------------------------------
    job.update(0.32, "Checking connection reuse…")
    ka_first, ka_second = keepalive_pair(final_url)

    # ---- 4. files the page loads ------------------------------------------------
    h = first["headers"]
    ctype = h.get("content-type", "")
    resources, res_results, total_refs = [], [], 0
    checked = bool(check_files and "html" in ctype.lower() and first["status"] < 400)
    if checked:
        charset = "utf-8"
        if "charset=" in ctype.lower():
            charset = ctype.lower().split("charset=")[1].split(";")[0].strip()
        html = _decode(first["body"], h.get("content-encoding"))
        resources, total_refs = find_resources(html, final_url, charset)
        if total_refs > MAX_RESOURCES:
            notes.append(f"The page links to {total_refs} files; the first {MAX_RESOURCES} were checked.")
        resources = resources[:MAX_RESOURCES]
        done = 0
        with ThreadPoolExecutor(PARALLEL) as pool:
            futs = {pool.submit(timed_fetch, res["url"]): res for res in resources}
            for fut in as_completed(futs):
                res = futs[fut]
                try:
                    res.update(fut.result())
                except FetchError as e:
                    res["error"] = str(e)
                except Exception as e:  # a single bad file must not stop the scan
                    res["error"] = f"{type(e).__name__}: {e}"
                res_results.append(res)
                done += 1
                job.update(0.35 + 0.6 * done / max(1, len(resources)), f"Checked {done} of {len(resources)} files…")
    elif check_files and "html" not in ctype.lower():
        notes.append("The address returned a non-HTML file, so there are no page files to check.")

    job.update(0.97, "Working out the causes…")
    return _report(url, final_url, hops, visits, med, (lo_total, hi_total), redirect_ms,
                   ka_first, ka_second, res_results, notes, checked)


def _report(url, final_url, hops, visits, med, total_range, redirect_ms, ka_first, ka_second, files, notes, checked):
    first = visits[0]
    h = first["headers"]
    rtt = med["connect"] or 0.0
    server_think = max(0.0, (med["wait"] or 0) - rtt)
    ttfb = redirect_ms + (med["ttfb"] or 0)
    rating = "good" if ttfb <= TTFB_GOOD else "needs improvement" if ttfb <= TTFB_POOR else "poor"
    causes = []

    # redirects
    if hops:
        causes.append(cause(
            f"{len(hops)} redirect{'s' if len(hops) > 1 else ''} before the page",
            "Every redirect is a full extra round trip before the real page starts loading: "
            + " → ".join(urlsplit(x["url"]).netloc + urlsplit(x["url"]).path for x in hops) + f" → {urlsplit(final_url).netloc}.",
            "Link straight to the final address, and make the server send the final page directly.",
            f"+{fmt_ms(redirect_ms)}", "high" if redirect_ms > 300 else "medium", redirect_ms))

    # server think time
    timing_hdr = h.get("server-timing")
    if server_think > 200:
        causes.append(cause(
            "The server is slow to prepare the page",
            f"After the request arrives, the server takes about {fmt_ms(server_think)} before sending the first byte."
            + (f" The server reports: {timing_hdr}." if timing_hdr else ""),
            "Cache the finished page, speed up database queries, or put a CDN that caches HTML in front.",
            f"+{fmt_ms(server_think)}", "high" if server_think > 600 else "medium", server_think))

    # distance
    trips = 1 + (1 if first["tls_version"] == "TLSv1.3" else 2 if first["tls_version"] else 0) + 1
    if rtt > 100:
        causes.append(cause(
            "The server is far away (slow round trips)",
            f"One round trip to the server takes about {fmt_ms(rtt)}, and loading the page needs at least {trips} of them.",
            "Use a CDN or host the site closer to its visitors.",
            f"+{fmt_ms(rtt * trips)}", "high" if rtt > 250 else "medium", rtt * trips))

    # DNS
    dns_first = first["dns"]
    if dns_first > 100:
        causes.append(cause(
            "Slow address lookup (DNS)",
            f"Finding the server's address took {fmt_ms(dns_first)} on the first visit.",
            "Use a faster DNS provider and a longer DNS time-to-live (TTL).",
            f"+{fmt_ms(dns_first)}", "medium" if dns_first > 250 else "low", dns_first))

    # TLS
    if first["tls_version"] and med["tls"] and med["tls"] > max(1.5 * rtt + 30, 60):
        causes.append(cause(
            "Slow secure-connection setup (TLS)",
            f"The secure handshake took {fmt_ms(med['tls'])} with {first['tls_version']}, which is more than its round trips explain.",
            "Enable TLS 1.3, session resumption and OCSP stapling; use a shorter certificate chain.",
            f"+{fmt_ms(med['tls'] - rtt)}", "low", med["tls"] - rtt))
    elif first["tls_version"] == "TLSv1.2":
        causes.append(cause(
            "Old TLS version (1.2)",
            "TLS 1.2 needs one more round trip than TLS 1.3 to set up a secure connection.",
            "Enable TLS 1.3 on the server.", f"+{fmt_ms(rtt)}", "low", rtt))

    # compression of the HTML
    html_enc = h.get("content-encoding", "")
    if _is_text(h.get("content-type")) and not html_enc and first["bytes"] > 2048:
        packed = len(gzip.compress(first["body"] or b"", 6)) if first["body"] else first["bytes"]
        saving = max(0, first["bytes"] - packed)
        dl_saving = med["download"] * saving / first["bytes"] if first["bytes"] else 0
        causes.append(cause(
            "The page is sent without compression",
            f"The HTML is {fmt_bytes(first['bytes'])} uncompressed; gzip would make it about {fmt_bytes(packed)}.",
            "Turn on gzip or Brotli compression on the server.",
            f"−{fmt_bytes(saving)}", "medium" if saving > 50_000 else "low", dl_saving))

    # big HTML
    if first["bytes"] > 500_000:
        causes.append(cause(
            "The page itself is very large",
            f"The HTML alone is {fmt_bytes(first['bytes'])} and takes {fmt_ms(med['download'])} to download.",
            "Send less HTML: paginate long lists, move inline data and SVGs into separate cached files.",
            f"+{fmt_ms(med['download'])}", "medium", med["download"]))

    # keep-alive / connection reuse (the 'setup cost' term of our formula)
    setup = (med["dns"] or 0) + (med["connect"] or 0) + (med["tls"] or 0)
    reuse_note = None
    if ka_first is not None and ka_second is None and ka_first.get("will_close"):
        causes.append(cause(
            "The server closes the connection after every request",
            f"Every file then pays the connection setup again (about {fmt_ms(setup)} each time).",
            "Enable HTTP keep-alive (and HTTP/2) on the server.",
            f"+{fmt_ms(setup)} per file", "medium", setup))
    elif ka_second is not None:
        reuse_note = (ka_first["wait"] + ka_first["download"] + setup, ka_second["wait"] + ka_second["download"])

    # variability
    lo, hi = total_range
    if len(visits) >= 3 and med["total"] and hi - lo > 0.5 * med["total"] and hi - lo > 100:
        causes.append(cause(
            "Response time jumps around",
            f"The same page took between {fmt_ms(lo)} and {fmt_ms(hi)} on {len(visits)} visits.",
            "The server is probably busy or under-powered at times: check its CPU, database and traffic peaks.",
            f"±{fmt_ms((hi - lo) / 2)}", "low", (hi - lo) / 2))

    # ---- page files ----------------------------------------------------------
    # 401/403/429 mean the server refused an automated check: not a problem of the page itself.
    refused = [f for f in files if "error" not in f and f["status"] in (401, 403, 429)]
    broken = [f for f in files if "error" in f or f["status"] in (404, 410) or f["status"] >= 500]
    ok = [f for f in files if f not in broken and f not in refused]
    if refused:
        notes = notes + [f"{len(refused)} file{'s' if len(refused) > 1 else ''} refused this scanner "
                         f"(HTTP {', '.join(sorted({str(f['status']) for f in refused}))}: automated checks are blocked or "
                         "rate-limited). Browsers may still be allowed, so they are left out of the results."]
    page_host = urlsplit(final_url).hostname
    hosts = {}
    for f in ok:
        hosts.setdefault(f["host"], []).append(f)
    other_hosts = [x for x in hosts if x != page_host]
    total_bytes = sum(f["bytes"] for f in ok)
    blocking = [f for f in ok if f["blocking"]]

    if broken:
        waste = sum(f.get("total", 0) for f in broken)
        causes.append(cause(
            f"{len(broken)} broken file{'s' if len(broken) > 1 else ''}",
            "The page asks for files that are missing, fail on the server, or cannot be loaded: "
            + ", ".join(f"{_short(f['url'], 45)} ({'error' if 'error' in f else f['status']})" for f in broken[:3]) + ".",
            "Remove or fix those links. Browsers still wait for them.",
            f"+{fmt_ms(waste)}", "medium", waste))
    if len(blocking) >= 3:
        bt = sum(f["total"] for f in blocking)
        causes.append(cause(
            f"{len(blocking)} files block the page from showing",
            "Scripts and stylesheets in the <head> without async/defer must finish before anything is drawn.",
            "Add defer to scripts, inline critical CSS, and load the rest later.",
            f"up to +{fmt_ms(max(f['total'] for f in blocking))}", "medium", bt / PARALLEL))
    if len(other_hosts) >= 3:
        per = median([g[0]["dns"] + g[0]["connect"] + g[0]["tls"] for x, g in hosts.items() if x != page_host]) or 0
        causes.append(cause(
            f"Files come from {len(other_hosts)} other domains",
            f"Each new domain needs its own address lookup and secure connection (about {fmt_ms(per)} each).",
            "Host files on your own domain, drop unneeded third-party scripts, or add <link rel=preconnect>.",
            f"~{fmt_ms(per)} each", "medium" if len(other_hosts) >= 6 else "low", per * len(other_hosts) / PARALLEL))
    big_imgs = [f for f in ok if f["kind"] == "image" and f["bytes"] > 300_000]
    if big_imgs:
        t = sum(f["download"] for f in big_imgs)
        causes.append(cause(
            f"{len(big_imgs)} large image{'s' if len(big_imgs) > 1 else ''}",
            "Biggest: " + ", ".join(f"{_short(f['url'], 40)} ({fmt_bytes(f['bytes'])})" for f in sorted(big_imgs, key=lambda f: -f["bytes"])[:3]) + ".",
            "Resize images to the size they are shown at and use WebP or AVIF.",
            f"+{fmt_ms(t)}", "medium", t))
    uncompressed = [f for f in ok if _is_text(f["headers"].get("content-type")) and not f["headers"].get("content-encoding") and f["bytes"] > 10_000]
    if uncompressed:
        b = sum(f["bytes"] for f in uncompressed)
        causes.append(cause(
            f"{len(uncompressed)} text file{'s' if len(uncompressed) > 1 else ''} sent without compression",
            f"Scripts and stylesheets totalling {fmt_bytes(b)} are sent uncompressed (gzip usually saves about 70%).",
            "Turn on gzip or Brotli compression for CSS, JavaScript, JSON and SVG.",
            f"−{fmt_bytes(b * 0.7)}", "low", sum(f["download"] for f in uncompressed) * 0.7))
    uncached = [f for f in ok if f["kind"] in ("script", "style", "image", "font", "icon") and _cache_policy(f["headers"]) in ("none", "no-store")]
    if len(uncached) >= 3:
        causes.append(cause(
            f"{len(uncached)} files are not cached by browsers",
            "Without caching headers, returning visitors download these files again on every visit.",
            "Send Cache-Control: max-age (for example one year for versioned files).",
            "every visit", "low", 0))

    causes = sort_causes(causes)

    # ---- verdict -----------------------------------------------------------------
    level = "good" if rating == "good" and not any(c["severity"] == "high" for c in causes) else \
            "bad" if rating == "poor" or any(c["severity"] == "high" for c in causes) else "warn"
    title = {
        "good": f"{urlsplit(final_url).hostname} responds quickly: first byte in {fmt_ms(ttfb)}.",
        "warn": f"{urlsplit(final_url).hostname} could be faster: first byte in {fmt_ms(ttfb)}.",
        "bad": f"{urlsplit(final_url).hostname} is slow: first byte after {fmt_ms(ttfb)}.",
    }[level]
    top = [c["name"].lower() for c in causes if c["severity"] in ("high", "medium")][:2]
    sub = ("Biggest delays: " + " and ".join(top) + ".") if top else "No major problems found."

    stats = [
        stat("Time to first byte", fmt_ms(ttfb), f"Google rates this {rating}", "good" if rating == "good" else "warm"),
        stat("Server thinking time", fmt_ms(server_think), "after the request arrives", "warm" if server_think > 200 else "good"),
        stat("Page HTML", fmt_bytes(first["bytes"]), f"downloaded in {fmt_ms(med['download'])}"),
        stat("Files on the page", str(len(files)) if checked else "—",
             (f"{fmt_bytes(total_bytes)} from {len(hosts)} domain{'s' if len(hosts) != 1 else ''}" if files
              else "no linked files") if checked else "not checked"),
    ]

    parts = [("redirect", "Redirects", redirect_ms), ("dns", "Address lookup (DNS)", med["dns"]),
             ("connect", "Connecting", med["connect"]), ("tls", "Secure setup (TLS)", med["tls"]),
             ("wait", "Server wait", (med["send"] or 0) + (med["wait"] or 0)), ("download", "Download", med["download"])]
    rows = [{"label": f"Typical visit (middle of {len(visits)})", "total": sum(v for _, _, v in parts if v),
             "parts": [{"key": k, "label": lab, "value": v or 0} for k, lab, v in parts]}]
    for i, v in enumerate(visits):
        vp = [("redirect", "Redirects", redirect_ms if i == 0 else 0), ("dns", "Address lookup (DNS)", v["dns"]),
              ("connect", "Connecting", v["connect"]), ("tls", "Secure setup (TLS)", v["tls"]),
              ("wait", "Server wait", v["send"] + v["wait"]), ("download", "Download", v["download"])]
        rows.append({"label": f"Visit {i + 1}" + (" (first)" if i == 0 else ""), "total": sum(x for _, _, x in vp),
                     "parts": [{"key": k, "label": lab, "value": x} for k, lab, x in vp]})
    breakdown = {"title": "Where the time goes", "note": "One page request, phase by phase.", "rows": rows}

    tables = [table("Each visit", ["Visit", "DNS", "Connect", "Secure setup", "Server wait", "Download", "Total"],
                    [[f"{i + 1}", fmt_ms(v["dns"]), fmt_ms(v["connect"]), fmt_ms(v["tls"]), fmt_ms(v["wait"]),
                      fmt_ms(v["download"]), fmt_ms(v["total"])] for i, v in enumerate(visits)],
                    "Each visit uses a fresh connection, like a new visitor.")]
    if reuse_note:
        tables[0]["note"] += (f" On a reused connection the page took {fmt_ms(reuse_note[1])} instead of "
                              f"{fmt_ms(reuse_note[0])}: that is the setup cost a kept-alive connection avoids.")
    if files:
        slow = sorted(files, key=lambda f: -(f.get("total") or 0))[:15]
        tables.append(table(
            "Slowest files on the page", ["Type", "File", "Size", "Server wait", "Download", "Total", "Note"],
            [[f["kind"], _short(f["url"]), fmt_bytes(f.get("bytes")), fmt_ms(f.get("wait")), fmt_ms(f.get("download")),
              fmt_ms(f.get("total")),
              f.get("error") or (f"refused scanner (HTTP {f['status']})" if f in refused else
                                 f"HTTP {f['status']}" if f.get("status", 200) >= 400 else
                                 "blocks page" if f.get("blocking") else "lazy" if f.get("lazy") else "")]
             for f in slow],
            "Each file timed on its own fresh connection, 6 at a time."))
        tables.append(table(
            "Domains the page uses", ["Domain", "Files", "Size", "Setup (DNS + connect + TLS)"],
            [[x + (" (this site)" if x == page_host else ""), str(len(g)), fmt_bytes(sum(f["bytes"] for f in g)),
              fmt_ms(median([f["dns"] + f["connect"] + f["tls"] for f in g]))]
             for x, g in sorted(hosts.items(), key=lambda kv: -len(kv[1]))]))
    tables.append(table("Response details", ["Item", "Value"], [
        ["Address checked", url], ["Final address", final_url],
        ["Status", f"{first['status']} {first['reason']}"], ["Protocol", first["version"]],
        ["Secure connection", first["tls_version"] or "none (plain http)"], ["Server IP", first["ip"] or "—"],
        ["Compression", h.get("content-encoding") or "none"], ["Caching", h.get("cache-control") or "not set"],
        ["Server software", h.get("server") or "not shown"],
        ["Server-Timing", timing_hdr or "not sent"],
    ]))

    notes = notes + [
        f"Measured from this computer, {len(visits)} visit{'s' if len(visits) > 1 else ''}; the typical visit is the middle value. "
        f"Total time ranged from {fmt_ms(lo)} to {fmt_ms(hi)}.",
        "Your own network adds to every number. Scan again at another time to compare.",
        "Files that the page adds later with JavaScript, and the time the browser spends drawing the page, are not included.",
        "Time-to-first-byte grades use Google's published thresholds: good up to 800 ms, poor above 1800 ms.",
    ]
    if first["status"] >= 400:
        notes.insert(0, f"The page answered with an error ({first['status']} {first['reason']}).")

    return {"kind": "website", "target": final_url,
            "verdict": {"title": title, "sub": sub, "level": level},
            "stats": stats, "causes": causes, "breakdown": breakdown, "charts": [], "tables": tables, "notes": notes}
