"""
process_daily.py
────────────────
Usage:  python process_daily.py  <path-to-excel.xlsx>

What it does:
  1. Reads the Daily Movement Register Excel
  2. Extracts: date, department, employee, worked-hrs, late, early
  3. Appends to  C:/HRAT/monthly_data/monthly_records.json
  4. Re-generates C:/HRAT/monthly_data/dashboard.html  (live dashboard)
"""

import sys, os, json, re
from datetime import datetime
import xlrd

# ── PATHS ──────────────────────────────────────────────────────────────────
DATA_DIR   = r'C:/HRAT/monthly_data'
JSON_FILE  = os.path.join(DATA_DIR, 'monthly_records.json')
DASH_FILE  = os.path.join(DATA_DIR, 'dashboard.html')
os.makedirs(DATA_DIR, exist_ok=True)

# ── STEP 1: load existing accumulated data ─────────────────────────────────
if os.path.exists(JSON_FILE):
    with open(JSON_FILE, 'r', encoding='utf-8') as f:
        db = json.load(f)
else:
    db = {"records": [], "dates_processed": []}

# ── STEP 2: parse excel ────────────────────────────────────────────────────
if len(sys.argv) < 2:
    print("Usage: python process_daily.py <excel_path>")
    sys.exit(1)

excel_path = sys.argv[1]
if not os.path.exists(excel_path):
    print(f"ERROR: File not found: {excel_path}")
    sys.exit(1)

print(f"Reading: {excel_path}")

wb  = xlrd.open_workbook(excel_path)
ws  = wb.sheet_by_index(0)

# Get report title / date from row 4
title_row = str(ws.row_values(4)[0]).strip()
# Extract date from title like "DAILY MOVEMENT REGISTER 02-11-2026 To 02-11-2026"
date_match = re.search(r'(\d{2}-\d{2}-\d{4})', title_row)
if date_match:
    report_date_str = date_match.group(1)          # e.g. "02-11-2026"
    report_date     = datetime.strptime(report_date_str, '%d-%m-%Y')
    report_date_iso = report_date.strftime('%Y-%m-%d')
else:
    report_date_iso = datetime.today().strftime('%Y-%m-%d')
    report_date_str = datetime.today().strftime('%d-%m-%Y')

print(f"Report date: {report_date_str}  ({report_date_iso})")

# Check for duplicate date
if report_date_iso in db['dates_processed']:
    print(f"WARNING: Date {report_date_iso} already in DB. Overwriting that date's records.")
    db['records'] = [r for r in db['records'] if r['date'] != report_date_iso]

SKIP_FOOTERS = {'page 5 of 5','page 4 of 5','page 3 of 5','page 2 of 5','page 1 of 5'}
SKIP_HEADERS = {'sno','ticketno','empname','date','in','lunch','time1','time2',
                'worked hrs','late','earler','daily movement register',
                'junior processing mill'}

new_records   = []
current_dept  = None

for r in range(6, ws.nrows):
    row = ws.row_values(r)
    non_empty = [v for v in row if v != '' and v is not None]
    if not non_empty:
        continue

    # Department name row
    if len(non_empty) == 1:
        val = str(non_empty[0]).strip()
        if (val.lower() not in SKIP_HEADERS
                and val.lower() not in SKIP_FOOTERS
                and not val.replace('.','').isdigit()):
            current_dept = val
            continue

    # Employee row
    sno = row[0]
    if isinstance(sno, float) and sno > 0:
        ticket_no  = str(row[2]).strip()  if row[2]  != '' else ''
        emp_name   = str(row[3]).strip()  if row[3]  != '' else ''
        day_name   = str(row[7]).strip()  if row[7]  != '' else ''
        time1      = str(row[9]).strip()  if row[9]  != '' else ''
        time2      = str(row[11]).strip() if row[11] != '' else ''
        worked_hrs = str(row[27]).strip() if row[27] != '' else ''
        late_in    = float(row[30]) if isinstance(row[30], float) else 0.0
        early_out  = float(row[31]) if isinstance(row[31], float) else 0.0

        # Parse worked hours to decimal
        hrs_decimal = 0.0
        hm = re.match(r'(\d+):(\d+)\s*Hrs', worked_hrs)
        if hm:
            hrs_decimal = int(hm.group(1)) + int(hm.group(2)) / 60.0

        new_records.append({
            'date':       report_date_iso,
            'date_label': report_date_str,
            'day':        day_name,
            'dept':       current_dept or 'Unknown',
            'ticket':     ticket_no,
            'name':       emp_name,
            'worked_hrs': worked_hrs,
            'hrs_decimal':round(hrs_decimal, 2),
            'late_min':   int(late_in),
            'early_min':  int(early_out),
        })

print(f"Extracted {len(new_records)} employee records for {report_date_str}")

# ── STEP 3: merge into DB ──────────────────────────────────────────────────
db['records'].extend(new_records)
if report_date_iso not in db['dates_processed']:
    db['dates_processed'].append(report_date_iso)
db['dates_processed'].sort()

with open(JSON_FILE, 'w', encoding='utf-8') as f:
    json.dump(db, f, ensure_ascii=False, indent=2)

print(f"Saved to {JSON_FILE}")
print(f"Total records in DB: {len(db['records'])} across {len(db['dates_processed'])} days")

# ── STEP 4: generate dashboard ─────────────────────────────────────────────
# (call generate_dashboard.py)
import subprocess
gen_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'generate_dashboard.py')
result = subprocess.run(
    [sys.executable, gen_script],
    capture_output=True, text=True
)
print(result.stdout)
if result.returncode != 0:
    print("Dashboard generation error:", result.stderr)
else:
    print(f"Dashboard saved: {DASH_FILE}")
