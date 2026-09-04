"""
Read Jason's Time Tracker spreadsheet into JSON — ledger row 507, step one.

    python scripts/read-timesheet.py "C:\\path\\to\\Time Tracker.xlsx" > timesheet.json

WHY PYTHON, AND WHY A SEPARATE STEP. The meaning of this file lives in CELL
COLOUR — green on the Hours cell means those hours were already paid, no fill
means still owed, yellow on the Date cell marks the first day of a new pay
rate. Nothing else in the sheet records any of it, so a CSV export would
silently turn a year of settled history into a year of outstanding wages.

Reading colour out of an .xlsx needs a real xlsx library. openpyxl is already
available here; the node side would need a new dependency in package.json for
one throwaway script, on a SHARED file. So the parsing lives here and the
importing lives in scripts/import-timesheet.ts, which drives the app's own
functions against the JSON this emits.

The JSON is also the point at which a human can check what was read before
anything is written: it is a plain, diffable record of how every row of the
spreadsheet was interpreted.
"""

import json
import sys
from datetime import datetime, timedelta

import openpyxl

SHEET = "Time Log"
PAID_FILL = "FF92D050"      # green  -> these hours were already paid
BOUNDARY_FILL = "FFFFFF00"  # yellow -> first day of a new pay rate
FIRST_DATA_ROW = 4          # rows 1-3 are the title, the tip and the headers


def argb(cell):
    """The cell's solid fill colour as AARRGGBB, or None if it has no fill."""
    fill = cell.fill
    if fill is None or fill.patternType is None:
        return None
    fg = fill.fgColor
    if fg is None or fg.type != "rgb" or not fg.rgb:
        return None
    return fg.rgb


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: read-timesheet.py <workbook.xlsx>", file=sys.stderr)
        return 2
    path = sys.argv[1]

    # Two loads on purpose: values gives the computed Hours, the default load
    # keeps the styling that carries the paid/unpaid meaning.
    wb_values = openpyxl.load_workbook(path, data_only=True)
    wb_style = openpyxl.load_workbook(path)
    if SHEET not in wb_values.sheetnames:
        print(f"workbook has no sheet named {SHEET!r}", file=sys.stderr)
        return 1
    ws_v, ws_s = wb_values[SHEET], wb_style[SHEET]

    rows = []
    for r in range(FIRST_DATA_ROW, ws_v.max_row + 1):
        date_cell = ws_v.cell(r, 1)
        if not isinstance(date_cell.value, datetime):
            continue

        duration = ws_v.cell(r, 2).value
        seconds = int(round(duration.total_seconds())) if isinstance(duration, timedelta) else 0

        rows.append(
            {
                "sheetRow": r,
                "day": date_cell.value.date().isoformat(),
                "durationSeconds": seconds,
                "paid": argb(ws_s.cell(r, 3)) == PAID_FILL,
                "rateBoundary": argb(ws_s.cell(r, 1)) == BOUNDARY_FILL,
            }
        )

    # A sheet that yields no rows is a changed file or a wrong path, not an
    # empty history — fail rather than emit an empty import.
    if not rows:
        print(f"no dated rows found in {SHEET!r} from row {FIRST_DATA_ROW}", file=sys.stderr)
        return 1

    json.dump(
        {
            "source": path,
            "sheet": SHEET,
            "readAt": datetime.now().astimezone().isoformat(),
            "rows": rows,
        },
        sys.stdout,
        indent=2,
    )
    print(file=sys.stdout)
    print(
        f"read {len(rows)} dated rows: "
        f"{sum(1 for x in rows if x['paid'])} paid, "
        f"{sum(1 for x in rows if not x['paid'])} unpaid, "
        f"{sum(1 for x in rows if x['rateBoundary'])} rate boundaries",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
