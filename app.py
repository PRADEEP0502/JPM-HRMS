from flask import Flask, request, jsonify
from pymongo import MongoClient, ASCENDING, UpdateOne
import os, re, uuid, json
from datetime import datetime
from collections import defaultdict
import xlrd

app = Flask(__name__)

# ── LAZY MONGODB CONNECTION ───────────────────────────────────────────────
# Connect only when first request comes — avoids crash at startup
_client      = None
_db          = None
_records     = None
_metadata    = None

def get_db():
    global _client, _db, _records, _metadata
    if _client is None:
        MONGO_URI = os.environ.get('MONGO_URI', '')
        if not MONGO_URI:
            raise RuntimeError("MONGO_URI environment variable not set")
        _client   = MongoClient(MONGO_URI, serverSelectionTimeoutMS=10000)
        _db       = _client['jpm_hrms']
        _records  = _db['attendance_records']
        _metadata = _db['metadata']
        # Indexes
        _records.create_index([('date',   ASCENDING)])
        _records.create_index([('dept',   ASCENDING)])
        _records.create_index([('ticket', ASCENDING)])
        _records.create_index([('date',   ASCENDING), ('dept', ASCENDING)])
        _seed_employee_master()
    return _records, _metadata

# ── EMPLOYEE MASTER (used to work out who is absent) ─────────────────────
MASTER_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'employee_master.json')

def _seed_employee_master():
    """Sync employee_master.json into Mongo on startup.
    For every employee listed in the file, the file's name, department and active flag win
    (so a department change or "active": false in the file reaches the live DB).
    Employees added from the app that are not in the file are left untouched."""
    col = _db['employee_master']
    col.create_index([('ticket', ASCENDING)], unique=True)
    if not os.path.exists(MASTER_FILE):
        return
    with open(MASTER_FILE, encoding='utf-8') as fh:
        rows = json.load(fh)
    ops = []
    for r in rows:
        ticket = str(r['ticket']).strip()
        ops.append(UpdateOne({'ticket': ticket},
                             {'$set': {'ticket': ticket, 'name': r['name'].strip(), 'dept': r['dept'].strip(),
                                       'active': r.get('active', True) is not False}},
                             upsert=True))
    if ops:
        col.bulk_write(ops, ordered=False)

def get_master():
    """Active employees from the master list, keyed by ticket number."""
    get_db()
    return {e['ticket']: e for e in _db['employee_master'].find({'active': {'$ne': False}}, {'_id': 0})}

def report_dates():
    """Dates for which an attendance report has been imported."""
    _, metadata_col = get_db()
    return set(metadata_col.distinct('date'))

def absent_records(dates, dept=None, search=None):
    """Synthetic ABSENT rows: master employees with no punch record on an imported date."""
    records_col, _ = get_db()
    master = get_master()
    if dept:
        master = {t: e for t, e in master.items() if e['dept'] == dept}
    if search:
        s = search.lower()
        master = {t: e for t, e in master.items() if s in e['name'].lower() or s in t.lower()}
    if not master:
        return []
    rows = []
    for d in sorted(dates):
        present = set(records_col.distinct('ticket', {'date': d}))
        for t, e in master.items():
            if t not in present:
                rows.append({'date': d, 'ticket': t, 'name': e['name'], 'dept': e['dept'],
                             'status': 'ABSENT', 'late_min': 0, 'early_min': 0,
                             'hrs_decimal': 0, 'worked_hrs': ''})
    return rows

# ── EXCEL PARSER (eSSL "Daily Movement Register") ───────────────────────
# Works for both layouts seen so far:
#  * original export: ~34 columns, title "DAILY MOVEMENT REGISTER dd-mm-yyyy", merged cells
#  * re-saved "DM TODAY" style: ~19 columns, header on row 0, headers shifted by one
# Columns are found by content, not fixed positions:
#  "HH:MM Hrs" cell = worked hours; the next three numbers after it are late-in,
#  lunch-late and early-going minutes; cells like "7:56 AM-I" are punches.
WORKED_RE     = re.compile(r'^\s*(\d+):(\d+)\s*Hrs\s*$', re.I)
PUNCH_RE      = re.compile(r'^\s*(\d{1,2}):(\d{2})\s*(AM|PM)?\s*-\s*(I|O)\s*$', re.I)
TITLE_DATE_RE = re.compile(r'(\d{2}-\d{2}-\d{4})')
DAY_NAMES     = {'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'}
NOT_DEPARTMENTS = {'in', 'lunch', 'late', 'earler', 'workedhrs', 'dailymovementregister', 'juniorprocessingmill'}

def _norm(v):
    return re.sub(r'[^a-z0-9]', '', str(v).lower())

def _punch_24h(cell):
    m = PUNCH_RE.match(str(cell))
    if not m:
        return None
    h, mi, ampm, kind = int(m.group(1)), int(m.group(2)), m.group(3), m.group(4).upper()
    if ampm:
        h = h % 12 + (12 if ampm.upper() == 'PM' else 0)
    return f'{h:02d}:{mi:02d}', ('IN' if kind == 'I' else 'OUT'), str(cell).strip()

def _cell_date(v, datemode):
    if isinstance(v, float) and 20000 < v < 80000:
        return xlrd.xldate_as_datetime(v, datemode).strftime('%Y-%m-%d')
    m = re.match(r'^\s*(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\s*$', str(v))
    if m:
        try:
            return datetime(int(m.group(3)), int(m.group(2)), int(m.group(1))).strftime('%Y-%m-%d')
        except ValueError:
            return None
    return None

DUPLICATE_PUNCH_MINUTES = 30

def _minute_of(p):
    return int(p['time'][11:13]) * 60 + int(p['time'][14:16])

def clean_punches(punches):
    """Drop double-taps: the same punch type again within 30 minutes (e.g. 8:32 AM-I, 8:33 AM-I)."""
    out = []
    for p in punches or []:
        if out and out[-1]['type'] == p['type'] and (_minute_of(p) - _minute_of(out[-1])) % 1440 <= DUPLICATE_PUNCH_MINUTES:
            continue
        out.append(p)
    return out

NIGHT_SHIFT_START = 17 * 60   # first IN at/after 5 PM = night shift

def punch_status(punches):
    """'INCOMPLETE' (missing punch) unless the day's punches are a clean IN→OUT sequence:
      * day shift:   IN, OUT, IN, OUT (lunch out/in) — 6 punches for a double shift is also fine
      * night shift: first IN at/after 5 PM — IN, OUT is enough (no lunch punches)
    Double-taps are ignored first (see clean_punches)."""
    punches = clean_punches(punches)
    if not punches:
        return None
    types = [p['type'] for p in punches]
    alternating = (types[0] == 'IN' and types[-1] == 'OUT'
                   and all(types[i] != types[i + 1] for i in range(len(types) - 1)))
    night_shift = types[0] == 'IN' and _minute_of(punches[0]) >= NIGHT_SHIFT_START
    needed = 2 if night_shift else 4
    return None if alternating and len(types) >= needed else 'INCOMPLETE'

def paired_minutes(punches):
    """Minutes worked across complete IN→OUT pairs (handles night shifts crossing midnight)."""
    total, pending = 0, None
    for p in clean_punches(punches):
        t = _minute_of(p)
        if p['type'] == 'IN':
            pending = t
        elif pending is not None:
            total += (t - pending) % 1440
            pending = None
    return total

def parse_excel(file_bytes):
    """Return (first_date_iso, first_date_label, records). Raises ValueError with a clear message."""
    try:
        wb = xlrd.open_workbook(file_contents=file_bytes)
    except Exception:
        raise ValueError('This is not a readable Excel (.xls) file. Export the Daily Movement Register from eSSL as .xls and try again.')
    ws = wb.sheet_by_index(0)

    # 1. Header row must contain TicketNo + EmpName (salary statements use "Emp ID", so they are rejected)
    header_idx = ticket_col = name_col = date_col = None
    for r in range(min(ws.nrows, 25)):
        cells = [_norm(v) for v in ws.row_values(r)]
        if 'ticketno' in cells and 'empname' in cells:
            header_idx, ticket_col, name_col = r, cells.index('ticketno'), cells.index('empname')
            date_col = cells.index('date') if 'date' in cells else None
            break
    if header_idx is None:
        raise ValueError('This file is not a Daily Movement Register. Upload the eSSL attendance report '
                         '(TicketNo, EmpName, Date, Time1... and Worked Hrs columns). Salary statements cannot be imported here.')

    # 2. Fallback date from a title like "DAILY MOVEMENT REGISTER 02-11-2026 To 02-11-2026"
    title_date = None
    for r in range(min(ws.nrows, 12)):
        m = TITLE_DATE_RE.search(' '.join(str(v) for v in ws.row_values(r)))
        if m:
            title_date = datetime.strptime(m.group(1), '%d-%m-%Y').strftime('%Y-%m-%d')
            break

    records, current_dept, seen = [], None, set()
    for r in range(header_idx + 1, ws.nrows):
        row = ws.row_values(r)
        non_empty = [v for v in row if v != '' and v is not None]
        if not non_empty:
            continue
        # Department heading = a row with a single text cell (skip sub-headers and "Page 1 of 5")
        if len(non_empty) == 1 and isinstance(non_empty[0], str):
            val = non_empty[0].strip()
            if val and not re.match(r'^page\b', val, re.I) and _norm(val) not in NOT_DEPARTMENTS:
                current_dept = val
            continue

        ticket = row[ticket_col] if ticket_col < len(row) else ''
        name   = row[name_col]   if name_col   < len(row) else ''
        if isinstance(ticket, float) and ticket.is_integer():
            ticket = str(int(ticket))
        ticket, name = str(ticket).strip(), str(name).strip()
        # Employee rows have a ticket and a real name (the second sub-row only holds numbers)
        if not ticket or not re.search(r'[A-Za-z]', name):
            continue

        # Date: per-row value near the Date column, else the title date
        date_iso = None
        if date_col is not None:
            for c in (date_col, date_col - 1, date_col + 1, date_col - 2, date_col + 2):
                if 0 <= c < len(row):
                    date_iso = _cell_date(row[c], wb.datemode)
                    if date_iso:
                        break
        date_iso = date_iso or title_date
        if not date_iso or (ticket, date_iso) in seen:
            continue
        seen.add((ticket, date_iso))

        worked_idx = next((i for i, v in enumerate(row) if WORKED_RE.match(str(v))), None)
        worked_hrs, hrs_decimal, late_in, lunch_late, early_out = '', 0.0, 0, 0, 0
        if worked_idx is not None:
            worked_hrs = str(row[worked_idx]).strip()
            m = WORKED_RE.match(worked_hrs)
            hrs_decimal = int(m.group(1)) + int(m.group(2)) / 60.0
            nums = [v for v in row[worked_idx + 1:] if isinstance(v, float)]
            late_in    = int(nums[0]) if len(nums) > 0 else 0
            lunch_late = int(nums[1]) if len(nums) > 1 else 0
            early_out  = int(nums[2]) if len(nums) > 2 else 0

        punches = []
        for v in row[:worked_idx if worked_idx is not None else len(row)]:
            p = _punch_24h(v)
            if p:
                punches.append({'sequence': len(punches) + 1, 'time': f'{date_iso}T{p[0]}:00',
                                'type': p[1], 'rawValue': p[2]})
        # Report shows 0 hours when a punch is missing; use the complete pairs instead
        if not hrs_decimal and punches:
            hrs_decimal = paired_minutes(punches) / 60.0
        first_in = next((p['time'][11:16] for p in punches if p['type'] == 'IN'), '')
        last_out = next((p['time'][11:16] for p in reversed(punches) if p['type'] == 'OUT'), '')
        day_name = next((str(v).strip() for v in row if str(v).strip() in DAY_NAMES), '')

        records.append({
            'date':           date_iso,
            'date_label':     datetime.strptime(date_iso, '%Y-%m-%d').strftime('%d-%m-%Y'),
            'day':            day_name,
            'dept':           current_dept or 'Unknown',
            'ticket':         ticket,
            'name':           name,
            'worked_hrs':     worked_hrs,
            'hrs_decimal':    round(hrs_decimal, 2),
            'late_min':       late_in,
            'lunch_late_min': lunch_late,
            'early_min':      early_out,
            'in':             first_in,
            'out':            last_out,
            'punches':        punches,
            **({'status': 'INCOMPLETE'} if punch_status(punches) else {}),
            'created_at':     datetime.utcnow(),
        })

    if not records:
        raise ValueError('No employee rows were found in this report. Check that it is the eSSL Daily Movement Register.')
    first = min(r['date'] for r in records)
    return first, datetime.strptime(first, '%Y-%m-%d').strftime('%d-%m-%Y'), records

# ── CORS HEADERS ─────────────────────────────────────────────────────────
@app.after_request
def add_cors(response):
    response.headers['Access-Control-Allow-Origin']  = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
    return response

@app.route('/', defaults={'path': ''}, methods=['OPTIONS'])
@app.route('/<path:path>', methods=['OPTIONS'])
def options_handler(path=''):
    return jsonify({}), 200

# ── ROUTES ────────────────────────────────────────────────────────────────

@app.route('/auth/me', methods=['GET', 'POST', 'OPTIONS'])
@app.route('/api/auth/me', methods=['GET', 'POST', 'OPTIONS'])
def auth_me():
    return jsonify({
        "username": "hradmin",
        "roles": ["ROLE_HR", "ROLE_MD"],
        "employeeId": "EMP001"
    })

@app.route('/')
@app.route('/api/')
def index():
    try:
        records_col, metadata_col = get_db()
        total  = records_col.count_documents({})
        dates  = sorted(metadata_col.distinct('date'))
        db_ok  = "connected"
    except Exception as e:
        total, dates, db_ok = 0, [], f"error: {str(e)}"

    return jsonify({
        "status":          "JPM-HRMS API ✅",
        "database":        "MongoDB Atlas",
        "db_status":       db_ok,
        "total_records":   total,
        "dates_processed": len(dates),
        "dates":           dates,
        "endpoints": {
            "POST   /upload":      "Upload daily Excel file",
            "GET    /records":     "?date=&dept=&status=late|early|ok&search=",
            "GET    /summary":     "Monthly summary",
            "GET    /departments": "Department stats",
            "GET    /employees":   "Employee stats (?dept=)",
            "GET    /health":      "DB health check",
            "DELETE /reset":       "Clear all data",
        }
    })

@app.route('/health')
@app.route('/api/health')
def health():
    try:
        records_col, _ = get_db()
        _client.admin.command('ping')
        count = records_col.count_documents({})
        return jsonify({"status": "ok", "mongodb": "connected", "records": count})
    except Exception as e:
        return jsonify({"status": "error", "mongodb": str(e)}), 500

@app.route('/upload', methods=['POST'])
@app.route('/api/upload', methods=['POST'])
def upload():
    if 'file' not in request.files:
        return jsonify({"error": "Send Excel as multipart key 'file'"}), 400
    f = request.files['file']
    if not f.filename:
        return jsonify({"error": "No file selected"}), 400

    try:
        date_iso, date_str, new_records = parse_excel(f.read())
    except ValueError as e:
        return jsonify({"error": str(e)}), 422
    except Exception as e:
        return jsonify({"error": f"Parse failed: {str(e)}"}), 422

    try:
        records_col, _ = get_db()
        save_report_records(new_records)
    except Exception as e:
        return jsonify({"error": f"DB error: {str(e)}"}), 500

    return jsonify({
        "status":        "success",
        "date":          date_str,
        "records_added": len(new_records),
        "departments":   list({r['dept'] for r in new_records}),
        "total_records": records_col.count_documents({}),
    })

def save_report_records(records):
    """Replace stored records for every date in this report and mark those dates as imported."""
    records_col, metadata_col = get_db()
    master = get_master()
    by_date = defaultdict(list)
    for r in records:
        row = {k: v for k, v in r.items() if k != '_id'}
        if row['ticket'] in master:              # master department wins
            row['report_dept'] = row['dept']
            row['dept'] = master[row['ticket']]['dept']
        by_date[r['date']].append(row)
    for d, rows in by_date.items():
        records_col.delete_many({'date': d})
        records_col.insert_many(rows)
        metadata_col.update_one(
            {'date': d},
            {'$set': {'date': d, 'date_label': rows[0]['date_label'],
                      'record_count': len(rows), 'uploaded_at': datetime.utcnow()}},
            upsert=True
        )

# ── IMPORT PREVIEW / COMMIT (used by the React frontend) ─────────────────
def _pending_col():
    get_db()
    return _db['pending_imports']

def _preview_payload(doc, status):
    rows = []
    for i, r in enumerate(doc['records'], start=1):
        worked = int(round(r.get('hrs_decimal', 0) * 60))
        punches = r.get('punches', [])
        rows.append({
            "sourceRow": i,
            "employeeId": r.get('ticket', ''),
            "employeeName": r.get('name', ''),
            "date": r.get('date'),
            "punches": punches,
            "firstIn": next((p['time'] for p in punches if p['type'] == 'IN'), None),
            "lastOut": next((p['time'] for p in reversed(punches) if p['type'] == 'OUT'), None),
            "workedMinutes": worked,
            "lateMinutes": r.get('late_min', 0),
            "earlyMinutes": r.get('early_min', 0),
            "status": "PRESENT" if worked > 0 else "ABSENT",
            "validationStatus": "VALID",
            "messages": [],
            "originalData": {"dept": r.get('dept', ''), "worked_hrs": r.get('worked_hrs', '')},
        })
    return {
        "importId": doc['_id'],
        "filename": doc['filename'],
        "fileType": "EXCEL",
        "status": status,
        "totalRows": len(rows),
        "validRows": len(rows),
        "rejectedRows": 0,
        "duplicateRows": 0,
        "reportDates": sorted({r['date'] for r in doc['records']}),
        "rows": rows,
        "messages": [],
    }

@app.route('/import/excel', methods=['POST'])
@app.route('/api/import/excel', methods=['POST'])
def import_excel_preview():
    f = request.files.get('file')
    if f is None or not f.filename:
        return jsonify({"message": "Send the Excel file as multipart field 'file'."}), 400
    try:
        date_iso, date_str, records = parse_excel(f.read())
    except ValueError as e:
        return jsonify({"message": str(e)}), 422
    except Exception as e:
        return jsonify({"message": f"Could not read the Excel report: {e}"}), 422
    try:
        doc = {
            '_id': uuid.uuid4().hex,
            'filename': f.filename,
            'date_iso': date_iso,
            'date_label': date_str,
            'records': records,
            'created_at': datetime.utcnow(),
        }
        _pending_col().insert_one(doc)
    except Exception as e:
        return jsonify({"message": f"DB error: {e}"}), 500
    return jsonify(_preview_payload(doc, "PREVIEW"))

@app.route('/import/pdf', methods=['POST'])
@app.route('/api/import/pdf', methods=['POST'])
def import_pdf_preview():
    return jsonify({"message": "PDF import is not supported on this server. Upload the Excel (.xls) report."}), 415

@app.route('/import/<import_id>/commit', methods=['POST'])
@app.route('/api/import/<import_id>/commit', methods=['POST'])
def import_commit(import_id):
    try:
        pending = _pending_col()
        doc = pending.find_one({'_id': import_id})
        if doc is None:
            return jsonify({"message": "Import preview not found or already committed. Upload the file again."}), 404
        save_report_records(doc['records'])
        pending.delete_one({'_id': import_id})
    except Exception as e:
        return jsonify({"message": f"DB error: {e}"}), 500
    return jsonify(_preview_payload(doc, "COMMITTED"))

@app.route('/records')
@app.route('/api/records')
@app.route('/attendance/records')
@app.route('/api/attendance/records')
def get_records():
    try:
        records_col, _ = get_db()
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    query    = {}
    date_f   = request.args.get('date', '')
    from_f   = request.args.get('from', '')
    to_f     = request.args.get('to', '')
    dept_f   = request.args.get('dept', '')
    status_f = request.args.get('status', '')
    search_f = request.args.get('search', '')
    limit    = int(request.args.get('limit', 50000))

    if date_f:
        query['date'] = date_f
    elif from_f or to_f:
        query['date'] = {**({'$gte': from_f} if from_f else {}), **({'$lte': to_f} if to_f else {})}
    if dept_f:   query['dept'] = dept_f
    if search_f:
        query['$or'] = [
            {'name':   {'$regex': search_f, '$options': 'i'}},
            {'ticket': {'$regex': search_f, '$options': 'i'}},
        ]
    if status_f == 'late':  query['late_min']  = {'$gt': 0}
    if status_f == 'early': query['early_min'] = {'$gt': 0}
    if status_f == 'ok':    query.update({'late_min': 0, 'early_min': 0})

    recs  = list(records_col.find(query, {'_id': 0, 'created_at': 0})
                             .sort('date', ASCENDING).limit(limit))

    # Add ABSENT rows for master employees missing from each imported report date
    if status_f in ('', 'absent'):
        dates = report_dates()
        if date_f:
            dates = {d for d in dates if d == date_f}
        else:
            dates = {d for d in dates if (not from_f or d >= from_f) and (not to_f or d <= to_f)}
        absents = absent_records(dates, dept=dept_f or None, search=search_f or None)
        recs = absents if status_f == 'absent' else recs + absents
        recs.sort(key=lambda r: r['date'])

    # Show the master department, not the one printed in the report.
    # Also flag missing punches on records imported before the status field existed.
    master = get_master()
    for r in recs:
        if r.get('ticket') in master:
            r['dept'] = master[r['ticket']]['dept']
        if not r.get('status') and punch_status(r.get('punches')):
            r['status'] = 'INCOMPLETE'
            if not r.get('hrs_decimal'):
                r['hrs_decimal'] = round(paired_minutes(r['punches']) / 60.0, 2)
    return jsonify({"count": len(recs), "records": recs})

@app.route('/summary')
@app.route('/api/summary')
@app.route('/dashboard/summary')
@app.route('/api/dashboard/summary')
def get_summary():
    try:
        records_col, _ = get_db()
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    match = {}
    if request.args.get('date'): match['date'] = request.args.get('date')
    if request.args.get('dept'): match['dept'] = request.args.get('dept')

    pipeline_date = [
        {'$match': match},
        {'$group': {
            '_id': '$date',
            'date_label': {'$first': '$date_label'},
            'day':        {'$first': '$day'},
            'total':      {'$sum': 1},
            'late':       {'$sum': {'$cond': [{'$gt': ['$late_min', 0]}, 1, 0]}},
            'early':      {'$sum': {'$cond': [{'$gt': ['$early_min', 0]}, 1, 0]}},
            'avg_hrs':    {'$avg': '$hrs_decimal'},
        }},
        {'$sort': {'_id': 1}},
    ]
    pipeline_dept = [
        {'$match': match},
        {'$group': {
            '_id':        '$dept',
            'total':      {'$sum': 1},
            'late':       {'$sum': {'$cond': [{'$gt': ['$late_min', 0]}, 1, 0]}},
            'early':      {'$sum': {'$cond': [{'$gt': ['$early_min', 0]}, 1, 0]}},
            'avg_hrs':    {'$avg': '$hrs_decimal'},
            'unique_emps':{'$addToSet': '$ticket'},
        }},
        {'$sort': {'_id': 1}},
    ]

    by_date, by_dept = {}, {}
    for d in records_col.aggregate(pipeline_date):
        pct = round(d['late'] / d['total'] * 100) if d['total'] else 0
        by_date[d['_id']] = {
            'date_label': d.get('date_label', d['_id']),
            'day': d.get('day', ''),
            'total': d['total'], 'late': d['late'], 'early': d['early'],
            'on_time': d['total'] - d['late'] - d['early'],
            'late_pct': pct, 'avg_hrs': round(d.get('avg_hrs') or 0, 2),
        }
    for d in records_col.aggregate(pipeline_dept):
        pct = round(d['late'] / d['total'] * 100) if d['total'] else 0
        by_dept[d['_id']] = {
            'total': d['total'], 'late': d['late'], 'early': d['early'],
            'late_pct': pct, 'unique_emps': len(d.get('unique_emps', [])),
            'avg_hrs': round(d.get('avg_hrs') or 0, 2),
        }

    # Totals come from the per-date aggregation above (same match) — saves 3 DB round trips
    total_recs = sum(d['total'] for d in by_date.values())
    late_recs  = sum(d['late']  for d in by_date.values())
    early_recs = sum(d['early'] for d in by_date.values())
    present_tickets = set(records_col.distinct('ticket', match)) if total_recs > 0 else set()
    unique_emps = len(present_tickets)

    # Absent = employees in the master list with no record on this (imported) date
    master = get_master()
    if match.get('dept'):
        master = {t: e for t, e in master.items() if e['dept'] == match['dept']}
    date_q = match.get('date')
    absent = None
    if master and date_q and date_q in report_dates():
        absent = len(set(master) - present_tickets)
    total_emps = len(set(master) | present_tickets) if master else unique_emps

    return jsonify({
        "date":                    request.args.get('date', datetime.today().strftime('%Y-%m-%d')),
        "totalEmployees":          total_emps,
        "presentEmployees":        unique_emps,
        "absentEmployees":         absent,
        "lateComing":              late_recs,
        "earlyGoing":              early_recs,
        "onDuty":                  0,
        "missingPunches":          sum(1 for r in records_col.find(match, {'punches': 1, '_id': 0})
                                       if punch_status(r.get('punches'))),
        "averageWorkingHours":     8.0,
        "employeeMasterAvailable": True,
        "importedReportAvailable": total_recs > 0,
        "total_records":           total_recs,
        "total_days":              len(by_date),
        "by_date":                 by_date,
        "by_dept":                 by_dept,
    })

@app.route('/departments')
@app.route('/api/departments')
@app.route('/analytics/department')
@app.route('/api/analytics/department')
def get_departments():
    try:
        records_col, _ = get_db()
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    pipeline = [
        {'$group': {
            '_id':       '$dept',
            'total':     {'$sum': 1},
            'late':      {'$sum': {'$cond': [{'$gt': ['$late_min', 0]}, 1, 0]}},
            'early':     {'$sum': {'$cond': [{'$gt': ['$early_min', 0]}, 1, 0]}},
            'unique_emp':{'$addToSet': '$ticket'},
            'avg_hrs':   {'$avg': '$hrs_decimal'},
            'total_late_min':  {'$sum': '$late_min'},
            'total_early_min': {'$sum': '$early_min'},
        }},
        {'$sort': {'total': -1}},
    ]
    result = []
    for d in records_col.aggregate(pipeline):
        result.append({
            'dept':            d['_id'],
            'total_records':   d['total'],
            'unique_emp':      len(d.get('unique_emp', [])),
            'late':            d['late'],
            'early':           d['early'],
            'late_pct':        round(d['late'] / d['total'] * 100) if d['total'] else 0,
            'avg_hrs':         round(d.get('avg_hrs') or 0, 2),
            'total_late_min':  d.get('total_late_min', 0),
            'total_early_min': d.get('total_early_min', 0),
        })
    return jsonify({"count": len(result), "departments": result})

@app.route('/alerts')
@app.route('/api/alerts')
def get_alerts():
    return jsonify([])

@app.route('/import/history')
@app.route('/api/import/history')
def get_import_history():
    return jsonify([])

@app.route('/employees')
@app.route('/api/employees')
def get_employees():
    try:
        records_col, _ = get_db()
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    master = get_master()   # master department wins over the report's department
    match = {}
    if request.args.get('dept'): match['dept'] = request.args.get('dept')

    pipeline = [
        {'$match': match},
        {'$group': {
            '_id':             '$ticket',
            'name':            {'$first': '$name'},
            'dept':            {'$first': '$dept'},
            'days':            {'$sum': 1},
            'late_days':       {'$sum': {'$cond': [{'$gt': ['$late_min', 0]}, 1, 0]}},
            'early_days':      {'$sum': {'$cond': [{'$gt': ['$early_min', 0]}, 1, 0]}},
            'total_hrs':       {'$sum': '$hrs_decimal'},
            'total_late_min':  {'$sum': '$late_min'},
            'total_early_min': {'$sum': '$early_min'},
        }},
        {'$sort': {'late_days': -1}},
    ]
    result = []
    for e in records_col.aggregate(pipeline):
        days     = e['days'] or 1
        late_pct = round(e['late_days'] / days * 100)
        status   = ('Chronic Late' if late_pct >= 75 else
                    'Often Late'   if late_pct >= 50 else
                    'Late'         if late_pct >= 25 else 'Good')
        result.append({
            'ticket':          e['_id'],
            'name':            e['name'],
            'dept':            master.get(e['_id'], {}).get('dept') or e['dept'],
            'days':            e['days'],
            'late_days':       e['late_days'],
            'early_days':      e['early_days'],
            'late_pct':        late_pct,
            'avg_hrs':         round(e['total_hrs'] / days, 2),
            'total_late_min':  e['total_late_min'],
            'total_early_min': e['total_early_min'],
            'status':          status,
        })

    # Include master employees who have no attendance records yet
    seen = {r['ticket'] for r in result}
    for t, m in master.items():
        if t in seen or (match.get('dept') and m['dept'] != match['dept']):
            continue
        result.append({'ticket': t, 'name': m['name'], 'dept': m['dept'], 'days': 0,
                       'late_days': 0, 'early_days': 0, 'late_pct': 0, 'avg_hrs': 0,
                       'total_late_min': 0, 'total_early_min': 0, 'status': 'No records'})
    return jsonify({"count": len(result), "employees": result})

@app.route('/employees', methods=['POST'])
@app.route('/api/employees', methods=['POST'])
def add_employee():
    """Add (or update) one employee in the master list."""
    body = request.get_json(silent=True) or {}
    ticket = str(body.get('employeeId') or body.get('ticket') or '').strip()
    name   = str(body.get('employeeName') or body.get('name') or '').strip()
    dept   = str(body.get('department') or body.get('dept') or '').strip() or 'Unassigned'
    if not ticket or not name:
        return jsonify({"message": "Employee ID and name are required."}), 400
    try:
        get_db()
        _db['employee_master'].update_one({'ticket': ticket},
            {'$set': {'ticket': ticket, 'name': name, 'dept': dept, 'active': True}}, upsert=True)
    except Exception as e:
        return jsonify({"message": f"DB error: {e}"}), 500
    return jsonify({"employeeId": ticket, "employeeName": name, "department": dept,
                    "designation": None, "shift": None, "joiningDate": None, "employmentStatus": "ACTIVE"})

@app.route('/reset', methods=['DELETE'])
@app.route('/api/reset', methods=['DELETE'])
def reset():
    try:
        records_col, metadata_col = get_db()
        r = records_col.delete_many({})
        metadata_col.delete_many({})
        return jsonify({"status": "cleared", "deleted": r.deleted_count})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
