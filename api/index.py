from flask import Flask, request, jsonify
from pymongo import MongoClient, ASCENDING
import os, re
from datetime import datetime
import xlrd

app = Flask(__name__)

# ── LAZY MONGODB CONNECTION ───────────────────────────────────────────────
_client, _records, _metadata = None, None, None

def get_db():
    global _client, _records, _metadata
    if _client is None:
        MONGO_URI = os.environ.get('MONGO_URI', '')
        if not MONGO_URI:
            raise RuntimeError("MONGO_URI not set")
        _client   = MongoClient(MONGO_URI, serverSelectionTimeoutMS=10000)
        db        = _client['jpm_hrms']
        _records  = db['attendance_records']
        _metadata = db['metadata']
        _records.create_index([('date', ASCENDING)])
        _records.create_index([('dept', ASCENDING)])
        _records.create_index([('ticket', ASCENDING)])
    return _records, _metadata

# ── CONSTANTS ─────────────────────────────────────────────────────────────
SKIP_FOOTERS = {f'page {i} of 5' for i in range(1, 6)}
SKIP_HEADERS = {
    'sno','ticketno','empname','date','in','lunch','time1','time2',
    'worked hrs','late','earler','daily movement register','junior processing mill'
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
            if val.lower() not in SKIP_HEADERS and val.lower() not in SKIP_FOOTERS and not val.replace('.','').isdigit():
                current_dept = val
                continue
        sno = row[0]
        if isinstance(sno, float) and sno > 0:
            worked_hrs  = str(row[27]).strip() if row[27] != '' else ''
            late_in     = float(row[30]) if isinstance(row[30], float) else 0.0
            early_out   = float(row[31]) if isinstance(row[31], float) else 0.0
            hrs_decimal = 0.0
            hm = re.match(r'(\d+):(\d+)\s*Hrs', worked_hrs)
            if hm:
                hrs_decimal = int(hm.group(1)) + int(hm.group(2)) / 60.0
            records.append({
                'date':        report_date_iso,
                'date_label':  report_date_str,
                'day':         str(row[7]).strip() if row[7] != '' else '',
                'dept':        current_dept or 'Unknown',
                'ticket':      str(row[2]).strip() if row[2] != '' else '',
                'name':        str(row[3]).strip() if row[3] != '' else '',
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
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    response.headers['Access-Control-Allow-Methods'] = 'GET,POST,DELETE,OPTIONS'
    return response

@app.route('/api/', defaults={'path': ''})
@app.route('/api/<path:path>', methods=['OPTIONS'])
def options_handler(path=''):
    return jsonify({}), 200

# ── ROUTES ────────────────────────────────────────────────────────────────
@app.route('/')
@app.route('/api/')
def index():
    try:
        records_col, metadata_col = get_db()
        total = records_col.count_documents({})
        dates = sorted(metadata_col.distinct('date'))
        db_ok = "connected"
    except Exception as e:
        total, dates, db_ok = 0, [], f"error: {str(e)}"
    return jsonify({
        "status":          "JPM-HRMS API ✅",
        "platform":        "Vercel + MongoDB Atlas",
        "db_status":       db_ok,
        "total_records":   total,
        "dates_processed": len(dates),
        "dates":           dates,
        "endpoints": {
            "POST   /api/upload":      "Upload daily Excel",
            "GET    /api/records":     "?date=&dept=&status=late|early|ok",
            "GET    /api/summary":     "Monthly summary",
            "GET    /api/departments": "Department stats",
            "GET    /api/employees":   "Employee stats",
            "GET    /api/health":      "Health check",
        }
    })

@app.route('/api/health')
def health():
    try:
        records_col, _ = get_db()
        _client.admin.command('ping')
        return jsonify({"status": "ok", "mongodb": "connected",
                        "records": records_col.count_documents({})})
    except Exception as e:
        return jsonify({"status": "error", "mongodb": str(e)}), 500

@app.route('/api/upload', methods=['POST'])
def upload():
    if 'file' not in request.files:
        return jsonify({"error": "Send Excel as multipart key 'file'"}), 400
    f = request.files['file']
    if not f.filename:
        return jsonify({"error": "No file"}), 400
    try:
        date_iso, date_str, new_records = parse_excel(f.read())
    except Exception as e:
        return jsonify({"error": f"Parse failed: {str(e)}"}), 422
    try:
        records_col, metadata_col = get_db()
        records_col.delete_many({'date': date_iso})
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
        "status": "success", "date": date_str,
        "records_added": len(new_records),
        "departments": list({r['dept'] for r in new_records}),
        "total_records": records_col.count_documents({}),
    })

@app.route('/api/records')
def get_records():
    try:
        records_col, _ = get_db()
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    query = {}
    if request.args.get('date'):   query['date'] = request.args.get('date')
    if request.args.get('dept'):   query['dept'] = request.args.get('dept')
    if request.args.get('search'):
        query['$or'] = [
            {'name':   {'$regex': request.args.get('search'), '$options': 'i'}},
            {'ticket': {'$regex': request.args.get('search'), '$options': 'i'}},
        ]
    if request.args.get('status') == 'late':  query['late_min']  = {'$gt': 0}
    if request.args.get('status') == 'early': query['early_min'] = {'$gt': 0}
    if request.args.get('status') == 'ok':    query.update({'late_min': 0, 'early_min': 0})
    limit = int(request.args.get('limit', 500))
    recs  = list(records_col.find(query, {'_id': 0, 'created_at': 0})
                             .sort('date', ASCENDING).limit(limit))
    return jsonify({"count": records_col.count_documents(query), "records": recs})

@app.route('/api/summary')
def get_summary():
    try:
        records_col, _ = get_db()
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    match = {}
    if request.args.get('date'): match['date'] = request.args.get('date')
    if request.args.get('dept'): match['dept'] = request.args.get('dept')
    p_date = [
        {'$match': match},
        {'$group': {'_id': '$date', 'date_label': {'$first': '$date_label'},
                    'day': {'$first': '$day'}, 'total': {'$sum': 1},
                    'late':  {'$sum': {'$cond': [{'$gt': ['$late_min',  0]}, 1, 0]}},
                    'early': {'$sum': {'$cond': [{'$gt': ['$early_min', 0]}, 1, 0]}},
                    'avg_hrs': {'$avg': '$hrs_decimal'}}},
        {'$sort': {'_id': 1}},
    ]
    p_dept = [
        {'$match': match},
        {'$group': {'_id': '$dept', 'total': {'$sum': 1},
                    'late':  {'$sum': {'$cond': [{'$gt': ['$late_min',  0]}, 1, 0]}},
                    'early': {'$sum': {'$cond': [{'$gt': ['$early_min', 0]}, 1, 0]}},
                    'avg_hrs': {'$avg': '$hrs_decimal'},
                    'unique_emps': {'$addToSet': '$ticket'}}},
        {'$sort': {'_id': 1}},
    ]
    by_date = {d['_id']: {'date_label': d.get('date_label', d['_id']),
        'day': d.get('day',''), 'total': d['total'], 'late': d['late'],
        'early': d['early'], 'on_time': d['total']-d['late']-d['early'],
        'late_pct': round(d['late']/d['total']*100) if d['total'] else 0,
        'avg_hrs': round(d.get('avg_hrs') or 0, 2)}
        for d in records_col.aggregate(p_date)}
    by_dept = {d['_id']: {'total': d['total'], 'late': d['late'], 'early': d['early'],
        'late_pct': round(d['late']/d['total']*100) if d['total'] else 0,
        'unique_emps': len(d.get('unique_emps',[])),
        'avg_hrs': round(d.get('avg_hrs') or 0, 2)}
        for d in records_col.aggregate(p_dept)}
    return jsonify({"total_records": records_col.count_documents(match),
                    "total_days": len(by_date), "by_date": by_date, "by_dept": by_dept})

@app.route('/api/departments')
def get_departments():
    try:
        records_col, _ = get_db()
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    pipeline = [
        {'$group': {'_id': '$dept', 'total': {'$sum': 1},
                    'late':  {'$sum': {'$cond': [{'$gt': ['$late_min',  0]}, 1, 0]}},
                    'early': {'$sum': {'$cond': [{'$gt': ['$early_min', 0]}, 1, 0]}},
                    'unique_emp': {'$addToSet': '$ticket'},
                    'avg_hrs': {'$avg': '$hrs_decimal'},
                    'total_late_min':  {'$sum': '$late_min'},
                    'total_early_min': {'$sum': '$early_min'}}},
        {'$sort': {'total': -1}},
    ]
    result = [{'dept': d['_id'], 'total_records': d['total'],
               'unique_emp': len(d.get('unique_emp',[])),
               'late': d['late'], 'early': d['early'],
               'late_pct': round(d['late']/d['total']*100) if d['total'] else 0,
               'avg_hrs': round(d.get('avg_hrs') or 0, 2),
               'total_late_min': d.get('total_late_min',0),
               'total_early_min': d.get('total_early_min',0)}
              for d in records_col.aggregate(pipeline)]
    return jsonify({"count": len(result), "departments": result})

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
        {'$group': {'_id': '$ticket', 'name': {'$first': '$name'},
                    'dept': {'$first': '$dept'}, 'days': {'$sum': 1},
                    'late_days':  {'$sum': {'$cond': [{'$gt': ['$late_min',  0]}, 1, 0]}},
                    'early_days': {'$sum': {'$cond': [{'$gt': ['$early_min', 0]}, 1, 0]}},
                    'total_hrs': {'$sum': '$hrs_decimal'},
                    'total_late_min':  {'$sum': '$late_min'},
                    'total_early_min': {'$sum': '$early_min'}}},
        {'$sort': {'late_days': -1}},
    ]
    result = []
    for e in records_col.aggregate(pipeline):
        days     = e['days'] or 1
        late_pct = round(e['late_days'] / days * 100)
        result.append({'ticket': e['_id'], 'name': e['name'], 'dept': e['dept'],
                       'days': e['days'], 'late_days': e['late_days'],
                       'early_days': e['early_days'], 'late_pct': late_pct,
                       'avg_hrs': round(e['total_hrs'] / days, 2),
                       'total_late_min': e['total_late_min'],
                       'total_early_min': e['total_early_min'],
                       'status': ('Chronic Late' if late_pct>=75 else
                                  'Often Late'   if late_pct>=50 else
                                  'Late'         if late_pct>=25 else 'Good')})
    return jsonify({"count": len(result), "employees": result})

@app.route('/api/reset', methods=['DELETE'])
def reset():
    try:
        records_col, metadata_col = get_db()
        r = records_col.delete_many({})
        metadata_col.delete_many({})
        return jsonify({"status": "cleared", "deleted": r.deleted_count})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# Vercel serverless handler
handler = app
