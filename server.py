"""BeamTime: local web server for the SSRL beam port schedule calendar.

    python server.py                 # http://localhost:8000
    python server.py --port 8080 --host 0.0.0.0   # e.g. on the VM

Endpoints:
    GET  /                  calendar UI (static/)
    GET  /api/schedule      parsed schedule as JSON (cached, refreshed hourly)
    POST /api/refresh       force a re-fetch from the SSRL page

Only the Python standard library is used.
"""

from __future__ import annotations

import argparse
import json
import logging
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import ssrl_schedule

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
CACHE_FILE = ROOT / "data" / "schedule.json"

log = logging.getLogger("beamtime")


class ScheduleCache:
    """Holds the latest parsed schedule; refreshes from the source when stale."""

    def __init__(self, cache_file: Path, max_age: float):
        self.cache_file = cache_file
        self.max_age = max_age
        self._lock = threading.Lock()
        self._data: dict | None = None
        self._loaded_at = 0.0          # monotonic time of last successful fetch
        self._last_error: str | None = None
        self._load_from_disk()

    def _load_from_disk(self):
        try:
            self._data = json.loads(self.cache_file.read_text(encoding="utf-8"))
            log.info("Loaded cached schedule from %s", self.cache_file)
        except FileNotFoundError:
            pass
        except Exception as exc:  # corrupt cache: ignore, will refetch
            log.warning("Ignoring unreadable cache %s: %s", self.cache_file, exc)

    def refresh(self) -> bool:
        with self._lock:
            try:
                log.info("Fetching %s", ssrl_schedule.SOURCE_URL)
                data = ssrl_schedule.fetch_schedule()
            except Exception as exc:
                self._last_error = f"{type(exc).__name__}: {exc}"
                log.error("Schedule fetch failed: %s", self._last_error)
                return False
            self._data = data
            self._loaded_at = time.monotonic()
            self._last_error = None
            self.cache_file.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.cache_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
            tmp.replace(self.cache_file)
            log.info("Schedule updated (source generated %s)", data.get("sourceGenerated"))
            return True

    def get(self) -> dict | None:
        if self._data is None or time.monotonic() - self._loaded_at > self.max_age:
            self.refresh()
        if self._data is None:
            return None
        return {**self._data, "lastError": self._last_error}

    def run_background(self):
        def loop():
            while True:
                time.sleep(self.max_age)
                self.refresh()
        threading.Thread(target=loop, daemon=True, name="schedule-refresh").start()


def make_handler(cache: ScheduleCache):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

        def do_GET(self):
            if self.path.split("?")[0] == "/api/schedule":
                return self._send_schedule()
            return super().do_GET()

        def do_POST(self):
            if self.path.split("?")[0] == "/api/refresh":
                cache.refresh()
                return self._send_schedule()
            self.send_error(HTTPStatus.NOT_FOUND)

        def _send_schedule(self):
            data = cache.get()
            if data is None:
                return self._send_json({"error": cache._last_error or "no data"},
                                       HTTPStatus.BAD_GATEWAY)
            self._send_json(data)

        def _send_json(self, obj, status=HTTPStatus.OK):
            body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def end_headers(self):
            # Avoid stale UI files during development.
            if not self.path.startswith("/api/"):
                self.send_header("Cache-Control", "no-cache")
            super().end_headers()

        def log_message(self, fmt, *args):
            log.debug("%s - %s", self.address_string(), fmt % args)

    return Handler


def main():
    ap = argparse.ArgumentParser(description="SSRL BeamTime calendar server")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (0.0.0.0 to expose)")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--refresh", type=float, default=3600, help="seconds between fetches")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")

    cache = ScheduleCache(CACHE_FILE, args.refresh)
    cache.refresh()           # fetch at startup; falls back to disk cache on failure
    cache.run_background()

    server = ThreadingHTTPServer((args.host, args.port), make_handler(cache))
    url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}/"
    log.info("BeamTime running at %s  (Ctrl+C to stop)", url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
