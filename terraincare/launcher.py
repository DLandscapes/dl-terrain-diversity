"""Start DL-TerrainDiversity and open it in the browser.

Ported from DL-3DGS Viewer (project/launcher.py). Like
that app this is a pure client-side tool, so this only needs to serve the folder
over HTTP -- ES modules will not load from a file:// URL. Standard library only,
so there is no virtualenv to build and no npm install.

    python launcher.py                      # the tool: pick a free port, open it
    python launcher.py --port 9000          # insist on one port
    python launcher.py --no-browser
    python launcher.py --page selftest.html        # the analysis-kernel self-test
    python launcher.py --page selftest-render.html # the pixel/geometry self-test
    python launcher.py --selftest           # start, check pages serve, exit

The DEM tiles live OUTSIDE this folder, in the sibling data/ directory, and are
served read-only at /data/ rather than being copied in -- same reasoning as the
3DGS app's /input/ mapping: test data should never end up inside an export or a
backup of the app itself. The site photographs are served at /input/ for the
same reason.

The port is negotiated rather than hard-coded: a second copy of the app must
never fight the one already running.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import posixpath
import socket
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

DEFAULT_PORT = 8994  # 8992 = DL-3DGS, 8765 = DL-TerrainSlicer
PORT_ATTEMPTS = 20
ROOT = Path(__file__).resolve().parent
# Read-only mounts onto sibling folders, keyed by URL prefix.
MOUNTS = {
    "/data/": ROOT.parent / "data",
    "/input/": ROOT.parent / "input",
}


def port_is_free(port: int) -> bool:
    """True if nothing is listening on the port and we could bind it.

    Deliberately NO SO_REUSEADDR: on Windows that option lets a bind succeed on
    a port that already has a listener, which would report a busy port as free
    and hand the user a server that dies on startup.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.2)
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            return False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def free_port(preferred: int, attempts: int = PORT_ATTEMPTS) -> int:
    for port in range(preferred, preferred + attempts):
        if port_is_free(port):
            return port
    raise SystemExit(
        f"No free port between {preferred} and {preferred + attempts - 1}. "
        f"Close the other copy of the app and try again.")


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static handler with sibling-folder mounts, kept uncached and quiet."""

    def translate_path(self, path: str) -> str:
        clean = urllib.parse.unquote(path.split("?", 1)[0].split("#", 1)[0])
        for prefix, base in MOUNTS.items():
            if not clean.startswith(prefix):
                continue
            rel = posixpath.normpath(clean[len(prefix):])
            # Resolve and confirm the result really sits inside the mount,
            # rather than trying to spot escape patterns by eye. Anything else
            # is pointed at a name that cannot exist, so it 404s instead of
            # quietly serving something from the app root.
            candidate = (base / rel).resolve()
            try:
                candidate.relative_to(base.resolve())
            except ValueError:
                return str(base / "__forbidden__")
            return str(candidate)
        return super().translate_path(path)

    def end_headers(self) -> None:
        # Never cache the app shell or its modules, so edits always take effect.
        # .js covers the worker script too, which otherwise goes stale across an
        # edit and produces a genuinely baffling debugging session.
        if self.path.endswith((".html", ".js", ".mjs", ".css", ".json")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args) -> None:  # noqa: D102 - silence per-request noise
        pass


def make_server(port: int) -> http.server.ThreadingHTTPServer:
    handler = functools.partial(Handler, directory=str(ROOT))
    return http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)


def selftest(port: int, page: str) -> int:
    """Prove the app serves: the page, its entry modules, and a real DEM tile."""
    server = make_server(port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    try:
        with urllib.request.urlopen(f"{base}/{page}", timeout=5) as r:
            shell = r.read()
    except Exception as exc:  # noqa: BLE001 - the message is the point
        print(f"SELFTEST FAILED: could not serve {page}: {exc}")
        return 1
    if b"DL-TerrainDiversity" not in shell:
        print(f"SELFTEST FAILED: {page} was served but looks wrong")
        return 1
    assets = (
        "static/selftest.js",
        "static/selftest-render.js",
        "static/lattice.js",
        "static/export/geotiff-write.js",
        "static/export/obj.js",
        "static/export/figure.js",
        "static/export/zip.js",
        "static/geotiff.js",
        "static/analysis/horn.js",
        "static/analysis/mfd.js",
        "static/analysis/indices.js",
        "static/analysis/geomorphons.js",
        "static/analysis/horizon.js",
        "static/analysis/ramps.js",
        # the worker is fetched by the browser as a module URL, not by an import
        # in the page, so a 404 here would only show up as silence at runtime
        "static/worker.js",
        "static/analysis-client.js",
        "static/stroke.js",
        "static/local.js",
        "static/style.css",
        # the mount is the part most likely to be misconfigured
        "data/orndalen/orndalen_fill_025m.tif",
    )
    for asset in assets:
        try:
            with urllib.request.urlopen(f"{base}/{asset}", timeout=10) as r:
                if not r.read(64):
                    raise ValueError("empty response")
        except Exception as exc:  # noqa: BLE001
            print(f"SELFTEST FAILED: {asset} did not serve: {exc}")
            return 1
    server.shutdown()
    print(f"SELFTEST OK: serving {page} and {len(assets)} assets on port {port}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Start DL-TerrainDiversity.")
    ap.add_argument("--port", type=int, default=None,
                    help=f"use this exact port instead of the first free one from {DEFAULT_PORT}")
    ap.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    ap.add_argument("--page", default="index.html",
                    help="page to open (default index.html; --page selftest.html for the suite)")
    ap.add_argument("--selftest", action="store_true",
                    help="start, verify the app serves, exit (for CI)")
    args = ap.parse_args()

    port = args.port if args.port is not None else free_port(DEFAULT_PORT)

    if args.selftest:
        return selftest(port, args.page)

    url = f"http://localhost:{port}/{args.page}"
    print("DL-TerrainDiversity")
    print(f"  {url}")
    if port != DEFAULT_PORT:
        print(f"  (port {DEFAULT_PORT} was busy - another copy may be running)")
    print("  close this window to stop the app")
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        make_server(port).serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
