# SSRL Beam Time

A calendar view of the [SSRL Beam Port Schedule](https://www-ssrl.slac.stanford.edu/xray_schedule.html),
with a beam line filter, a Monday-start week view and an AP → AP / AP → DOWN run-period view.

## Run it

Requires Python 3.9+ (standard library only, nothing to install).

```
python server.py            # then open http://localhost:8000
```

or double-click `start.bat` (Windows). Options:

| flag | default | |
|---|---|---|
| `--port` | 8000 | |
| `--host` | 127.0.0.1 | use `0.0.0.0` on the VM to serve other machines |
| `--refresh` | 3600 | seconds between fetches of the SSRL page |

The server fetches the SSRL page at start-up and every hour, and caches the parsed
result in `data/schedule.json` (used as a fallback if SSRL is unreachable).
The ↻ button in the UI forces a re-fetch (at most once a minute).

## Deploying on the VM (Rocky Linux 9 + nginx)

Served at `/mail-in-xas/xray_schedule/`: nginx proxies that prefix to the Python server,
which runs as the systemd service `ssrl-beamtime` on `127.0.0.1:8010` under the
unprivileged user `beamtime`, from `/opt/ssrl_beam_time_schedule`.

SLAC's reverse proxy already forwards `https://www-ssrl.slac.stanford.edu/mail-in-xas/*`
to the VM (TLS ends there), so the page is public at
`https://www-ssrl.slac.stanford.edu/mail-in-xas/xray_schedule/` as soon as nginx serves it.

nginx belongs to the mail-in XAS portal: its single `server` block
(`/etc/nginx/conf.d/mail-in-xas.conf`) contains `include /etc/nginx/mail-in-xas.d/*.conf;`
and already sets `absolute_redirect off;`. This project only drops its location snippet
into that directory and never edits the portal's config.

First install, and every update afterwards (the script is idempotent):

```
curl -fsSLO https://raw.githubusercontent.com/slaclab/ssrl_beam_time_schedule/main/deploy/install.sh
sudo bash install.sh
# later updates:  sudo bash /opt/ssrl_beam_time_schedule/deploy/install.sh
```

[`deploy/install.sh`](deploy/install.sh):

1. preflight – `git`, `python3` (≥ 3.9; Rocky 9 ships 3.9), `curl`, `nginx`; outbound HTTPS
   to the SSRL schedule page
2. creates the system user `beamtime`; clones / fast-forwards the repo; `py_compile` check
3. installs and restarts the `ssrl-beamtime` service, checks `127.0.0.1:8010` answers
4. copies [`deploy/nginx-xray_schedule.conf`](deploy/nginx-xray_schedule.conf) to
   `/etc/nginx/mail-in-xas.d/xray_schedule.conf`, runs `nginx -t` and reloads nginx;
   if the test fails the previous snippet is restored and the script stops
5. checks that SELinux allows nginx → port 8010, and runs the checks below

**SELinux (enforcing)** – one-time, label only this port (preferred over the global
`httpd_can_network_connect` boolean; the portal does the same for its ports):

```
sudo semanage port -a -t http_port_t -p tcp 8010    # use -m instead of -a if already defined
```

**Checks** (run by the script; to repeat by hand on the VM):

```
curl -sI https://www-ssrl.slac.stanford.edu/xray_schedule.html                          # outbound HTTPS works
curl -s -o /dev/null -w "%{http_code}\n" http://localhost/mail-in-xas/xray_schedule    # 301
curl -s http://localhost/mail-in-xas/xray_schedule/api/schedule | head -c 200          # JSON
curl -s -o /dev/null -w "%{http_code}\n" http://localhost/mail-in-xas/                 # 200, portal unaffected
```

Useful commands: `systemctl status ssrl-beamtime`, `journalctl -u ssrl-beamtime -f`.

Because the page is public, `POST /api/refresh` (the ↻ button) re-fetches at most once a minute.
Don't commit the VM's hostname or IP addresses, or the proxy's address, to this (public) repository.

## Using it

* **Beam lines** – tick the beam lines to show; families with several end stations
  (6-2 a/b/c, 14-3 a/b) have a group checkbox. The selection is remembered in the browser.
* **Week** – Monday–Sunday, three shifts per day (Owl 23:00 the evening before – 07:00,
  Day 07:00–15:00, Swing 15:00–23:00). Consecutive shifts of the same proposal are merged.
* **Run period** – from the start of a facility-wide AP (or the last day of a DOWN) to the
  next AP / DOWN, as detected from the schedule. Pick a period from the drop-down.
* **Facility** row – facility-wide AP / DOWN (a shift counts when ≥ half the beam lines show it).
* Hover a block for details; hovering a user block highlights that proposal everywhere.
* Keys: `←` / `→` previous / next, `T` today, `W` week view, `R` run view.
  `#week` / `#run` in the URL select the view.

## Files

| file | |
|---|---|
| `ssrl_schedule.py` | fetch + parse the SSRL HTML into JSON, classify cells, detect run periods. Run it directly to print a summary: `python ssrl_schedule.py [saved.html] [-o out.json]` |
| `server.py` | small HTTP server: serves `static/`, `GET /api/schedule`, `POST /api/refresh` |
| `static/` | the UI (plain HTML / CSS / JS, no build step; all URLs relative so it works under any path prefix) |
| `deploy/` | systemd unit, nginx location snippet, `install.sh` for the Rocky 9 VM |

## Notes on the source data

* Cell text is truncated at 18 characters by SSRL; PI names are completed from the
  longest version seen for the same proposal number.
* A `/` in a cell means a change during the shift (`PAAM/AP`, `Xray CHECKOUT/6701`);
  each part is drawn as an equal fraction of the shift, so those times are approximate (≈).
* Category descriptions live in `CATEGORIES` in `ssrl_schedule.py` (PAAM, FACI, COMM, RA
  are currently shown by code only); colours are in `static/styles.css`.

## Planned

* `.ics` export / subscription per beam line
* per-user settings (would move preferences from browser storage to the server, with login)
