from flask import Flask, request, jsonify
from pymongo import MongoClient, ASCENDING
import os, re, uuid
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
    return _records, _metadata

# ── CONSTANTS ─────────────────────────────────────────────────────────────
SKIP_FOOTERS = {f'page {i} of 5' for i in range(1, 6)}
SKIP_HEADERS = {
    'sno', 'ticketno', 'empname', 'date', 'in', 'lunch', 'time1', 'time2',
    'worked hrs', 'late', 'earler', 'daily movement register',
    'junior processing mill'
}

# ── HELPERS ───────────────────────────────────────────────────────────────
def parse_excel(file_bytes):
    wb  = xlrd.open_workbook(file_contents=file_bytes)
    ws  = wb.sheet_by_index(0)

    title_row  = str(ws.row_values(4)[0]).strip()
    date_match = re.search(r'(\d{2}-\d{2}-\d{4})', title_row)
    if date_match:
        report_date_str = date_match.group(1)
        report_date_iso = datetime.strptime(report_date_str, '%d-%m-%Y').strftime('%Y-%m-%d')
    else:
        report_date_iso = datetime.today().strftime('%Y-%m-%d')
        report_date_str = datetime.today().strftime('%d-%m-%Y')

    records, current_dept = [], None

    for r in range(6, ws.nrows):
        row       = ws.row_values(r)
        non_empty = [v for v in row if v != '' and v is not None]
        if not non_empty:
            continue
        if len(non_empty) == 1:
            val = str(non_empty[0]).strip()
            if (val.lower() not in SKIP_HEADERS
                    and val.lower() not in SKIP_FOOTERS
                    and not val.replace('.', '').isdigit()):
                current_dept = val
                continue
        sno = row[0]
        if isinstance(sno, float) and sno > 0:
            ticket_no  = str(row[2]).strip()  if row[2]  != '' else ''
            emp_name   = str(row[3]).strip()  if row[3]  != '' else ''
            day_name   = str(row[7]).strip()  if row[7]  != '' else ''
            worked_hrs = str(row[27]).strip() if row[27] != '' else ''
            late_in    = float(row[30]) if isinstance(row[30], float) else 0.0
            early_out  = float(row[31]) if isinstance(row[31], float) else 0.0
            hrs_decimal = 0.0
            hm = re.match(r'(\d+):(\d+)\s*Hrs', worked_hrs)
            if hm:
                hrs_decimal = int(hm.group(1)) + int(hm.group(2)) / 60.0
            records.append({
                'date':        report_date_iso,
                'date_label':  report_date_str,
                'day':         day_name,
                'dept':        current_dept or 'Unknown',
                'ticket':      ticket_no,
                'name':        emp_name,
                'worked_hrs':  worked_hrs,
                'hrs_decimal': round(hrs_decimal, 2),
                'late_min':    int(late_in),
                'early_min':   int(early_out),
                'created_at':  datetime.utcnow(),
            })
    return report_date_iso, report_date_str, records

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
    except Exception as e:
        return jsonify({"error": f"Parse failed: {str(e)}"}), 422

    try:
        records_col, metadata_col = get_db()
        deleted = records_col.delete_many({'date': date_iso})
        if new_records:
            records_col.insert_many(new_records)
        metadata_col.update_one(
            {'date': date_iso},
            {'$set': {'date': date_iso, 'date_label': date_str,
                      'record_count': len(new_records),
                      'uploaded_at': datetime.utcnow()}},
            upsert=True
        )
    except Exception as e:
        return jsonify({"error": f"DB error: {str(e)}"}), 500

    return jsonify({
        "status":        "success",
        "date":          date_str,
        "records_added": len(new_records),
        "departments":   list({r['dept'] for r in new_records}),
        "total_records": records_col.count_documents({}),
    })

# ── IMPORT PREVIEW / COMMIT (used by the React frontend) ─────────────────
def _pending_col():
    get_db()
    return _db['pending_imports']

def _preview_payload(doc, status):
    rows = []
    for i, r in enumerate(doc['records'], start=1):
        worked = int(round(r.get('hrs_decimal', 0) * 60))
        rows.append({
            "sourceRow": i,
            "employeeId": r.get('ticket', ''),
            "employeeName": r.get('name', ''),
            "date": r.get('date'),
            "punches": [],
            "firstIn": None,
            "lastOut": None,
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
        "reportDates": [doc['date_iso']],
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
        records_col, metadata_col = get_db()
        records_col.delete_many({'date': doc['date_iso']})
        if doc['records']:
            records_col.insert_many([{k: v for k, v in r.items() if k != '_id'} for r in doc['records']])
        metadata_col.update_one(
            {'date': doc['date_iso']},
            {'$set': {'date': doc['date_iso'], 'date_label': doc['date_label'],
                      'record_count': len(doc['records']),
                      'uploaded_at': datetime.utcnow()}},
            upsert=True
        )
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
    dept_f   = request.args.get('dept', '')
    status_f = request.args.get('status', '')
    search_f = request.args.get('search', '')
    limit    = int(request.args.get('limit', 500))

    if date_f:   query['date'] = date_f
    if dept_f:   query['dept'] = dept_f
    if search_f:
        query['$or'] = [
            {'name':   {'$regex': search_f, '$options': 'i'}},
            {'ticket': {'$regex': search_f, '$options': 'i'}},
        ]
    if status_f == 'late':  query['late_min']  = {'$gt': 0}
    if status_f == 'early': query['early_min'] = {'$gt': 0}
    if status_f == 'ok':    query.update({'late_min': 0, 'early_min': 0})

    total = records_col.count_documents(query)
    recs  = list(records_col.find(query, {'_id': 0, 'created_at': 0})
                             .sort('date', ASCENDING).limit(limit))
    return jsonify({"count": total, "records": recs})

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

    total_recs = records_col.count_documents(match)
    late_recs  = records_col.count_documents({**match, 'late_min': {'$gt': 0}})
    early_recs = records_col.count_documents({**match, 'early_min': {'$gt': 0}})
    unique_emps = len(records_col.distinct('ticket', match)) if total_recs > 0 else 0

    return jsonify({
        "date":                    request.args.get('date', datetime.today().strftime('%Y-%m-%d')),
        "totalEmployees":          unique_emps,
        "presentEmployees":        unique_emps,
        "absentEmployees":         0,
        "lateComing":              late_recs,
        "earlyGoing":              early_recs,
        "onDuty":                  0,
        "missingPunches":          0,
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
            'dept':            e['dept'],
            'days':            e['days'],
            'late_days':       e['late_days'],
            'early_days':      e['early_days'],
            'late_pct':        late_pct,
            'avg_hrs':         round(e['total_hrs'] / days, 2),
            'total_late_min':  e['total_late_min'],
            'total_early_min': e['total_early_min'],
            'status':          status,
        })
    return jsonify({"count": len(result), "employees": result})

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
