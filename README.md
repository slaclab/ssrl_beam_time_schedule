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
The ↻ button in the UI forces a re-fetch.

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
| `static/` | the UI (plain HTML / CSS / JS, no build step) |

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
