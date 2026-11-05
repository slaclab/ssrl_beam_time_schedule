"""Fetch and parse the SSRL Beam Port Schedule into a JSON-friendly structure.

Source: https://www-ssrl.slac.stanford.edu/xray_schedule.html

Page layout (generated nightly from the SSRL database):
  * one block per week (weeks start on Monday)
  * inside each week, one 7-column table per beam line:
        row: "BEAM LINE 1-5"            (+ optional "shared" note)
        row: 7 dates                    (Mon .. Sun)
        row: shift 0  "owl"   23:00 (previous evening) - 07:00
        row: shift 1  "day"   07:00 - 15:00
        row: shift 2  "swing" 15:00 - 23:00
  * a cell may contain a change during the shift, separated by "/",
    e.g. "PAAM/AP", "Xray CHECKOUT/6701", "CHANGE/6828 N.Idri".
    Cell text is truncated by the source at 18 characters.

Times are SLAC local time (America/Los_Angeles).

Usage as a script:
    python ssrl_schedule.py                 # fetch live page, print summary
    python ssrl_schedule.py page.html       # parse a saved copy
    python ssrl_schedule.py page.html -o schedule.json
"""

from __future__ import annotations

import datetime as dt
import json
import re
import sys
import urllib.request
from html.parser import HTMLParser

SOURCE_URL = "https://www-ssrl.slac.stanford.edu/xray_schedule.html"

SHIFTS = [
    {"key": "owl", "label": "Owl", "start": "23:00", "end": "07:00", "startOffsetHours": -1},
    {"key": "day", "label": "Day", "start": "07:00", "end": "15:00", "startOffsetHours": 7},
    {"key": "swing", "label": "Swing", "start": "15:00", "end": "23:00", "startOffsetHours": 15},
]

# Category -> human description. Codes not listed here fall back to "other"
# and are shown with their raw text. Extend as needed.
CATEGORIES = {
    "user": "User beam time",
    "checkout": "X-ray checkout",
    "change": "Changeover",
    "AP": "Accelerator Physics",
    "MA": "Maintenance",
    "DOWN": "Down / no beam",
    "PAAM": "PAAM",
    "FACI": "FACI",
    "COMM": "COMM",
    "RA": "RA",
    "unscheduled": "Unscheduled",
    "other": "Other",
}

_FIXED_CODES = {"AP", "MA", "DOWN", "PAAM", "FACI", "COMM", "RA"}

_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}

_DATE_RE = re.compile(r"^([A-Za-z]{3,5})\.?\s+(\d{1,2}),\s+(\d{4})$")
_BEAMLINE_RE = re.compile(r"BEAM\s*LINE\s+([0-9]+-[0-9]+[A-Za-z]?)", re.I)
_GENERATED_RE = re.compile(r"automatically created from database on\s+([^-][^>]*?)\s*-->", re.I)
# Proposal numbers are 4 characters starting with two digits: 6701, 0001, 98M8, 12G2 ...
_USER_RE = re.compile(r"^(\d{2}[0-9A-Z]{2})(?:\s+(.+))?$")


# --------------------------------------------------------------------------- HTML -> tables

class _TableCollector(HTMLParser):
    """Collect every <table> as a list of rows, each row a list of cell texts."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[str]]] = []
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._close_row()
            self.tables.append([])
        elif tag == "tr":
            self._close_row()
            self._row = []
        elif tag in ("td", "th"):
            self._close_cell()
            self._cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th"):
            self._close_cell()
        elif tag == "tr":
            self._close_row()
        elif tag == "table":
            self._close_row()

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)

    def _close_cell(self):
        if self._cell is not None and self._row is not None:
            text = "".join(self._cell).replace("\xa0", " ")
            self._row.append(re.sub(r"\s+", " ", text).strip())
        self._cell = None

    def _close_row(self):
        self._close_cell()
        if self._row is not None and self.tables:
            self.tables[-1].append(self._row)
        self._row = None


def _parse_date(text: str) -> dt.date | None:
    m = _DATE_RE.match(text)
    if not m:
        return None
    month = _MONTHS.get(m.group(1)[:3].lower())
    if not month:
        return None
    try:
        return dt.date(int(m.group(3)), month, int(m.group(2)))
    except ValueError:
        return None


# --------------------------------------------------------------------------- cell classification

def classify_part(text: str) -> dict:
    """Classify one '/'-separated piece of a cell."""
    t = text.strip()
    u = t.upper()
    m = _USER_RE.match(t)
    if m:
        part = {"c": "user", "p": m.group(1)}
        if m.group(2):
            part["n"] = m.group(2).strip()
        return part
    if "CHECKOUT" in u:
        return {"c": "checkout", "t": t}
    if u.startswith("CHANGE"):
        return {"c": "change", "t": t}
    if u in _FIXED_CODES:
        return {"c": u}
    if u == "UNSCHEDULED":
        return {"c": "unscheduled"}
    return {"c": "other", "t": t}


def classify_cell(text: str) -> list[dict]:
    if not text:
        return []
    return [classify_part(p) for p in text.split("/") if p.strip()]


# --------------------------------------------------------------------------- page -> schedule

def parse_schedule(html: str) -> dict:
    collector = _TableCollector()
    collector.feed(html)
    collector.close()

    raw: dict[str, dict[dt.date, list[str]]] = {}   # beamline -> date -> [owl, day, swing]
    shared: dict[str, bool] = {}
    order: list[str] = []
    warnings: list[str] = []

    for table in collector.tables:
        beamline = None
        dates: list[dt.date] | None = None
        shift = 0
        for row in table:
            if not row:
                continue
            joined = " ".join(row)
            m = _BEAMLINE_RE.search(joined)
            if m and len(row) == 1:
                beamline = m.group(1)
                if beamline not in raw:
                    raw[beamline] = {}
                    order.append(beamline)
                shared[beamline] = shared.get(beamline, False) or ("shared" in joined.lower())
                continue
            if len(row) != 7:
                continue
            parsed = [_parse_date(c) for c in row]
            if all(parsed):
                dates = parsed  # type: ignore[assignment]
                shift = 0
                continue
            if beamline is None or dates is None:
                continue
            if shift > 2:
                warnings.append(f"extra shift row for {beamline} week of {dates[0]}: {row}")
                continue
            for d, text in zip(dates, row):
                raw[beamline].setdefault(d, ["", "", ""])[shift] = text
            shift += 1

    all_dates = sorted({d for days in raw.values() for d in days})
    if not all_dates:
        raise ValueError("No schedule data found in page")
    start, end = all_dates[0], all_dates[-1]
    n_days = (end - start).days + 1

    # Full PI names: the source truncates cells, so keep the longest name seen per proposal.
    proposals: dict[str, str] = {}
    cells: dict[str, list[list[dict]]] = {}
    for bl in order:
        slots: list[list[dict]] = []
        for i in range(n_days):
            day = raw[bl].get(start + dt.timedelta(days=i), ["", "", ""])
            for text in day:
                parts = classify_cell(text)
                for p in parts:
                    if p["c"] == "user" and p.get("n"):
                        prev = proposals.get(p["p"], "")
                        if len(p["n"]) > len(prev):
                            proposals[p["p"]] = p["n"]
                slots.append(parts)
        cells[bl] = slots

    facility = facility_states(cells, n_days * 3)
    m = _GENERATED_RE.search(html)

    return {
        "source": SOURCE_URL,
        "sourceGenerated": m.group(1).strip() if m else None,
        "startDate": start.isoformat(),
        "days": n_days,
        "shifts": SHIFTS,
        "categories": CATEGORIES,
        "beamlines": [{"id": bl, "shared": shared.get(bl, False)} for bl in order],
        "proposals": proposals,
        "cells": cells,
        "facility": facility,
        "periods": run_periods(facility),
        "warnings": warnings,
    }


# --------------------------------------------------------------------------- facility-wide AP / DOWN

def facility_states(cells: dict[str, list[list[dict]]], n_slots: int) -> list[str]:
    """Facility state per shift slot: 'AP', 'DOWN', 'run' or 'none' (no data).

    A slot is AP (or DOWN) when at least half of the beam lines that have data
    in that slot show AP (or DOWN) somewhere in that shift.
    """
    states = []
    for s in range(n_slots):
        n = ap = down = 0
        for slots in cells.values():
            parts = slots[s] if s < len(slots) else []
            if not parts:
                continue
            n += 1
            cats = {p["c"] for p in parts}
            ap += "AP" in cats
            down += "DOWN" in cats
        if n == 0:
            states.append("none")
        elif ap * 2 >= n:
            states.append("AP")
        elif down * 2 >= n:
            states.append("DOWN")
        else:
            states.append("run")
    return states


DOWN_CONTEXT_SLOTS = 3  # show at most one day of a DOWN block at either end of a period


def run_periods(facility: list[str]) -> list[dict]:
    """Split the schedule into run periods: AP -> AP, AP -> DOWN, DOWN -> AP, ...

    Every stretch of beam time ('run') becomes one period, bracketed by the
    AP / DOWN blocks around it. AP blocks are included in full (so consecutive
    AP -> AP periods share their AP block); DOWN blocks are clipped to
    DOWN_CONTEXT_SLOTS shifts so long shutdowns don't swamp the view.

    Slots are indices into the flat shift array (day_index * 3 + shift);
    'end' is exclusive. 'runStart'/'runEnd' delimit the beam time itself.
    """
    blocks = []  # [state, start, end_exclusive]
    for i, s in enumerate(facility):
        if blocks and blocks[-1][0] == s:
            blocks[-1][2] = i + 1
        else:
            blocks.append([s, i, i + 1])

    periods = []
    for bi, (state, rstart, rend) in enumerate(blocks):
        if state != "run":
            continue
        prev = blocks[bi - 1] if bi > 0 else None
        nxt = blocks[bi + 1] if bi + 1 < len(blocks) else None

        if prev is None or prev[0] == "none":
            start, kind_from = rstart, "start"
        elif prev[0] == "AP":
            start, kind_from = prev[1], "AP"
        else:  # DOWN
            start, kind_from = max(prev[1], prev[2] - DOWN_CONTEXT_SLOTS), "DOWN"

        if nxt is None or nxt[0] == "none":
            end, kind_to = rend, "end"
        elif nxt[0] == "AP":
            end, kind_to = nxt[2], "AP"
        else:  # DOWN
            end, kind_to = min(nxt[2], nxt[1] + DOWN_CONTEXT_SLOTS), "DOWN"

        periods.append({
            "start": start, "end": end,
            "runStart": rstart, "runEnd": rend,
            "from": kind_from, "to": kind_to,
        })
    return periods


# --------------------------------------------------------------------------- fetch

def fetch_html(url: str = SOURCE_URL, timeout: float = 60) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "BeamTime-calendar/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        charset = resp.headers.get_content_charset() or "iso-8859-1"
        return resp.read().decode(charset, errors="replace")


def fetch_schedule(url: str = SOURCE_URL) -> dict:
    data = parse_schedule(fetch_html(url))
    data["fetchedAt"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    return data


# --------------------------------------------------------------------------- CLI

def _main(argv: list[str]) -> int:
    import argparse

    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("html", nargs="?", help="saved HTML file (default: fetch live page)")
    ap.add_argument("-o", "--output", help="write JSON to this file")
    args = ap.parse_args(argv)

    if args.html:
        with open(args.html, encoding="iso-8859-1") as fh:
            data = parse_schedule(fh.read())
    else:
        data = fetch_schedule()

    start = dt.date.fromisoformat(data["startDate"])

    def slot_label(i: int) -> str:
        d = start + dt.timedelta(days=i // 3)
        return f"{d:%a %b %d} {SHIFTS[i % 3]['key']}"

    print(f"Source generated: {data['sourceGenerated']}")
    print(f"Range: {data['startDate']} + {data['days']} days, {len(data['beamlines'])} beam lines")
    print("Beam lines:", ", ".join(b["id"] + ("*" if b["shared"] else "") for b in data["beamlines"]))
    print("Run periods:")
    for p in data["periods"]:
        print(f"  {p['from']:>5} {slot_label(p['start'])}  ->  {p['to']:<5} {slot_label(p['end'] - 1)}"
              f"  ({(p['end'] - p['start']) / 3:.1f} days)")
    for w in data["warnings"]:
        print("WARNING:", w)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            json.dump(data, fh, separators=(",", ":"))
        print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
