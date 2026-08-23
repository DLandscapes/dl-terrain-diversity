#!/usr/bin/env python3
"""Frame sink for the video render.

⚠️ DOWNLOADS ARE BLOCKED IN THE BROWSER PANE, which is the whole reason this
exists. The render page cannot save 1,100 PNGs itself, and pushing them back
through the JS bridge as base64 would be megabytes per frame. So the page POSTs
each frame here and this writes it to disk.

It also SERVES the app folder, because the render page imports the app's own
modules and reads the real DEM from /data/ — a capture that used a second copy
of the terrain would not be a recording of this instrument.

Not part of the app. Nothing in static/ knows it exists.

    python tools/capture-server.py [--port 8996] [--out ../output/video/frames]
"""
import argparse, base64, functools, http.server, json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent          # terraincare/
MOUNTS = {"/data/": ROOT.parent / "data"}
OUT = ROOT.parent / "output" / "video" / "frames"

class Handler(http.server.SimpleHTTPRequestHandler):
    def _mounted(self, path):
        for prefix, base in MOUNTS.items():
            if path.startswith(prefix):
                rel = path[len(prefix):].split("?")[0]
                p = (base / rel).resolve()
                if base.resolve() in p.parents or p == base.resolve():
                    return p
        return None

    def translate_path(self, path):
        m = self._mounted(path.split("?")[0])
        return str(m) if m else super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def do_POST(self):
        if self.path != "/frame":
            self.send_error(404); return
        n = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(n).decode("utf8"))
            name = re.sub(r"[^A-Za-z0-9_.-]", "", str(body["name"]))
            # ⚠️ A SUBDIRECTORY PER PASS, sanitised the same way as the filename.
            # Without it a second render silently overwrites the frames the
            # previous encode was made from, and there is no way back to it.
            sub = re.sub(r"[^A-Za-z0-9_.-]", "", str(body.get("dir", "")))
            dest = (OUT / sub) if sub else OUT
            data = body["png"].split(",", 1)[1]
            dest.mkdir(parents=True, exist_ok=True)
            (dest / name).write_bytes(base64.b64decode(data))
        except Exception as e:                       # noqa: BLE001 — report, don't die
            self.send_error(500, str(e)); return
        self.send_response(204); self.end_headers()

    def log_message(self, fmt, *a):
        # ⚠️ str(), because this is NOT only called with the request line.
        # log_error() routes through here too and passes an HTTPStatus as a[0],
        # so `"POST" not in a[0]` raised TypeError and killed the handler
        # THREAD for that request. Every 404 hit it — favicon.ico 404s on each
        # page load — turning a harmless miss into a stack trace. Found while
        # rendering poster assets, 2026-08-23.
        if "POST" not in str(a[0] if a else ""):
            super().log_message(fmt, *a)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8996)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    if a.out: OUT = pathlib.Path(a.out).resolve()
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"capture server: http://127.0.0.1:{a.port}  frames -> {OUT}", flush=True)
    h = functools.partial(Handler, directory=str(ROOT))
    http.server.ThreadingHTTPServer(("127.0.0.1", a.port), h).serve_forever()
