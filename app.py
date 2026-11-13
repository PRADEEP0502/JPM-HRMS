from flask import Flask, request, jsonify
from pymongo import MongoClient, ASCENDING, DESCENDING
from pymongo.errors import DuplicateKeyError
import os, re, io
from datetime import datetime
from collections import defaultdict
import xlrd

app = Flask(__name__)

# ── MONGODB CONNECTION ─────────────────────────────────────────────────────
MONGO_URI = os.environ.get('MONGO_URI', 'mongodb://localhost:27017/')
client    = MongoClient(MONGO_URI)
db_mongo  = client['jpm_hrms']

# Collections
records_col  = db_mongo['attendance_records']   # daily employee records
metadata_col = db_mongo['metadata']             # processed dates tracker

# Indexes for fast querying
records_col.create_index([('date', ASCENDING)])
records_col.create_index([('dept', ASCENDING)])
records_col.create_index([('ticket', ASCENDING)])
records_col.create_index([('date', ASCENDING), ('dept', ASCENDING)])

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

    # Extract report date from row 4
    title_row  = str(ws.row_values(4)[0]).strip()
    date_match = re.search(r'(\d{2}-\d{2}-\d{4})', title_row)
    if date_match:
        report_date_str = date_match.group(1)
        report_date     = datetime.strptime(report_date_str, '%d-%m-%Y')
        report_date_iso = report_date.strftime('%Y-%m-%d')
    else:
        report_date_iso = datetime.today().strftime('%Y-%m-%d')
        report_date_str = datetime.today().strftime('%d-%m-%Y')

    records      = []
    current_dept = None

    for r in range(6, ws.nrows):
        row       = ws.row_values(r)
        non_empty = [v for v in row if v != '' and v is not None]
        if not non_empty:
            continue

        # Department name row
        if len(non_empty) == 1:
            val = str(non_empty[0]).strip()
            if (val.lower() not in SKIP_HEADERS
                    and val.lower() not in SKIP_FOOTERS
                    and not val.replace('.', '').isdigit()):
                current_dept = val
                continue

        # Employee row
        sno = row[0]
        if isinstance(sno, float) and sno > 0:
            ticket_no  = str(row[2]).strip()  if row[2]  != '' else ''
            emp_name   = str(row[3]).strip()  if row[3]  != '' else ''
            day_name   = str(row[7]).strip()  if row[7]  != '' else ''
            worked_hrs = str(row[27]).strip() if row[27] != '' else ''
            late_in    = float(row[30]) if isinstance(row[30], float) else 0.0
            early_out  = float(row[31]) if isinstance(row[31], float) else 0.0

            # Parse hours to decimal
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

def clean_doc(doc):
    """Remove MongoDB _id from response"""
    if doc and '_id' in doc:
        doc['_id'] = str(doc['_id'])
    return doc

# ── ROUTES ────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    total_records = records_col.count_documents({})
    dates = metadata_col.distinct('date')
    dates.sort()
    return jsonify({
        "status":          "JPM-HRMS API running ✅",
        "database":        "MongoDB Atlas",
        "total_records":   total_records,
        "dates_processed": len(dates),
        "dates":           dates,
        "endpoints": {
            "POST   /upload":      "Upload daily Excel file",
            "GET    /records":     "All records (?date=&dept=&status=late|early|ok&search=)",
            "GET    /summary":     "Monthly summary by date & department",
            "GET    /departments": "Department-wise stats",
            "GET    /employees":   "Employee-wise monthly stats (?dept=)",
            "DELETE /reset":       "Clear all data (admin)",
        }
    })

# ── UPLOAD ────────────────────────────────────────────────────────────────
@app.route('/upload', methods=['POST'])
def upload():
    if 'file' not in request.files:
        return jsonify({"error": "Send Excel as multipart/form-data key 'file'"}), 400

    f = request.files['file']
    if f.filename == '':
        return jsonify({"error": "No file selected"}), 400

    file_bytes = f.read()

    try:
        date_iso, date_str, new_records = parse_excel(file_bytes)
    except Exception as e:
        return jsonify({"error": f"Failed to parse Excel: {str(e)}"}), 422

    # Remove existing records for this date (allow re-upload)
    deleted = records_col.delete_many({'date': date_iso})

    # Insert new records
    if new_records:
        records_col.insert_many(new_records)

    # Update metadata
    metadata_col.update_one(
        {'date': date_iso},
        {'$set': {
            'date':        date_iso,
            'date_label':  date_str,
            'record_count': len(new_records),
            'uploaded_at': datetime.utcnow(),
        }},
        upsert=True
    )

    depts = list({r['dept'] for r in new_records})

    return jsonify({
        "status":          "success",
        "date":            date_str,
        "records_added":   len(new_records),
        "records_replaced": deleted.deleted_count,
        "departments":     depts,
        "total_records":   records_col.count_documents({}),
    })

# ── RECORDS ───────────────────────────────────────────────────────────────
@app.route('/records', methods=['GET'])
def get_records():
    query    = {}
    date_f   = request.args.get('date', '')
    dept_f   = request.args.get('dept', '')
    status_f = request.args.get('status', '')
    search_f = request.args.get('search', '')
    limit    = int(request.args.get('limit', 500))
    skip     = int(request.args.get('skip', 0))

    if date_f:   query['date'] = date_f
    if dept_f:   query['dept'] = dept_f
    if search_f:
        query['$or'] = [
            {'name':   {'$regex': search_f, '$options': 'i'}},
            {'ticket': {'$regex': search_f, '$options': 'i'}},
        ]
    if status_f == 'late':  query['late_min']  = {'$gt': 0}
    if status_f == 'early': query['early_min'] = {'$gt': 0}
    if status_f == 'ok':    query['late_min']  = 0; query['early_min'] = 0

    total = records_col.count_documents(query)
    recs  = list(records_col.find(query, {'_id': 0, 'created_at': 0})
                             .sort('date', ASCENDING)
                             .skip(skip)
                             .limit(limit))

    return jsonify({"count": total, "returned": len(recs), "records": recs})

# ── SUMMARY ───────────────────────────────────────────────────────────────
@app.route('/summary', methods=['GET'])
def get_summary():
    date_f = request.args.get('date', '')
    dept_f = request.args.get('dept', '')
    match  = {}
    if date_f: match['date'] = date_f
    if dept_f: match['dept'] = dept_f

    # Aggregate by date
    pipeline_date = [
        {'$match': match} if match else {'$match': {}},
        {'$group': {
            '_id':         '$date',
            'date_label':  {'$first': '$date_label'},
            'day':         {'$first': '$day'},
            'total':       {'$sum': 1},
            'late':        {'$sum': {'$cond': [{'$gt': ['$late_min', 0]}, 1, 0]}},
            'early':       {'$sum': {'$cond': [{'$gt': ['$early_min', 0]}, 1, 0]}},
            'avg_hrs':     {'$avg': '$hrs_decimal'},
        }},
        {'$sort': {'_id': 1}},
    ]

    # Aggregate by dept
    pipeline_dept = [
        {'$match': match} if match else {'$match': {}},
        {'$group': {
            '_id':         '$dept',
            'total':       {'$sum': 1},
            'late':        {'$sum': {'$cond': [{'$gt': ['$late_min', 0]}, 1, 0]}},
            'early':       {'$sum': {'$cond': [{'$gt': ['$early_min', 0]}, 1, 0]}},
            'avg_hrs':     {'$avg': '$hrs_decimal'},
            'unique_emps': {'$addToSet': '$ticket'},
        }},
        {'$sort': {'_id': 1}},
    ]

    by_date_raw = list(records_col.aggregate(pipeline_date))
    by_dept_raw = list(records_col.aggregate(pipeline_dept))

    by_date = {}
    for d in by_date_raw:
        late_pct = round(d['late'] / d['total'] * 100) if d['total'] else 0
        by_date[d['_id']] = {
            'date_label': d.get('date_label', d['_id']),
            'day':        d.get('day', ''),
            'total':      d['total'],
            'late':       d['late'],
            'early':      d['early'],
            'on_time':    d['total'] - d['late'] - d['early'],
            'late_pct':   late_pct,
            'avg_hrs':    round(d.get('avg_hrs') or 0, 2),
        }

    by_dept = {}
    for d in by_dept_raw:
        late_pct = round(d['late'] / d['total'] * 100) if d['total'] else 0
        by_dept[d['_id']] = {
            'total':       d['total'],
            'late':        d['late'],
            'early':       d['early'],
            'late_pct':    late_pct,
            'unique_emps': len(d.get('unique_emps', [])),
            'avg_hrs':     round(d.get('avg_hrs') or 0, 2),
        }

    total_records = records_col.count_documents(match)
    total_days    = len(by_date)

    return jsonify({
        "total_records": total_records,
        "total_days":    total_days,
        "by_date":       by_date,
        "by_dept":       by_dept,
    })

# ── DEPARTMENTS ───────────────────────────────────────────────────────────
@app.route('/departments', methods=['GET'])
def get_departments():
    pipeline = [
        {'$group': {
            '_id':        '$dept',
            'total':      {'$sum': 1},
            'late':       {'$sum': {'$cond': [{'$gt': ['$late_min', 0]}, 1, 0]}},
            'early':      {'$sum': {'$cond': [{'$gt': ['$early_min', 0]}, 1, 0]}},
            'unique_emp': {'$addToSet': '$ticket'},
            'avg_hrs':    {'$avg': '$hrs_decimal'},
            'total_late_min':  {'$sum': '$late_min'},
            'total_early_min': {'$sum': '$early_min'},
        }},
        {'$sort': {'total': -1}},
    ]
    result = []
    for d in records_col.aggregate(pipeline):
        late_pct = round(d['late'] / d['total'] * 100) if d['total'] else 0
        result.append({
            'dept':            d['_id'],
            'total_records':   d['total'],
            'unique_emp':      len(d.get('unique_emp', [])),
            'late':            d['late'],
            'early':           d['early'],
            'late_pct':        late_pct,
            'avg_hrs':         round(d.get('avg_hrs') or 0, 2),
            'total_late_min':  d.get('total_late_min', 0),
            'total_early_min': d.get('total_early_min', 0),
        })
    return jsonify({"count": len(result), "departments": result})

# ── EMPLOYEES ─────────────────────────────────────────────────────────────
@app.route('/employees', methods=['GET'])
def get_employees():
    dept_f  = request.args.get('dept', '')
    match   = {'dept': dept_f} if dept_f else {}

    pipeline = [
        {'$match': match} if match else {'$match': {}},
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
        {'$sort': {'late_days': -1, 'name': 1}},
    ]

    result = []
    for e in records_col.aggregate(pipeline):
        days      = e['days'] or 1
        late_pct  = round(e['late_days']  / days * 100)
        early_pct = round(e['early_days'] / days * 100)
        status    = ('Chronic Late' if late_pct >= 75 else
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
            'early_pct':       early_pct,
            'avg_hrs':         round(e['total_hrs'] / days, 2),
            'total_late_min':  e['total_late_min'],
            'total_early_min': e['total_early_min'],
            'status':          status,
        })

    return jsonify({"count": len(result), "employees": result})

# ── RESET ─────────────────────────────────────────────────────────────────
@app.route('/reset', methods=['DELETE'])
def reset():
    r = records_col.delete_many({})
    metadata_col.delete_many({})
    return jsonify({"status": "cleared", "deleted": r.deleted_count})

# ── HEALTH ────────────────────────────────────────────────────────────────
@app.route('/health', methods=['GET'])
def health():
    try:
        client.admin.command('ping')
        mongo_status = "connected"
    except Exception as e:
        mongo_status = f"error: {e}"
    return jsonify({"status": "ok", "mongodb": mongo_status})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
