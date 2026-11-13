from flask import Flask, request, jsonify, send_file
import os, json, re, io
from datetime import datetime
from collections import defaultdict
import xlrd

app = Flask(__name__)

DATA_DIR  = os.environ.get('DATA_DIR', '/tmp/hrms_data')
JSON_FILE = os.path.join(DATA_DIR, 'monthly_records.json')
os.makedirs(DATA_DIR, exist_ok=True)

SKIP_FOOTERS = {f'page {i} of 5' for i in range(1,6)}
SKIP_HEADERS = {'sno','ticketno','empname','date','in','lunch','time1','time2',
                'worked hrs','late','earler','daily movement register','junior processing mill'}

# ── HELPERS ───────────────────────────────────────────────────────────────

def load_db():
    if os.path.exists(JSON_FILE):
        with open(JSON_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {"records": [], "dates_processed": []}

def save_db(db):
    with open(JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(db, f, ensure_ascii=False, indent=2)

def parse_excel(file_bytes):
    wb  = xlrd.open_workbook(file_contents=file_bytes)
    ws  = wb.sheet_by_index(0)

    title_row = str(ws.row_values(4)[0]).strip()
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

        if len(non_empty) == 1:
            val = str(non_empty[0]).strip()
            if (val.lower() not in SKIP_HEADERS
                    and val.lower() not in SKIP_FOOTERS
                    and not val.replace('.','').isdigit()):
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
            })

    return report_date_iso, report_date_str, records

# ── ROUTES ────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    db = load_db()
    return jsonify({
        "status":          "JPM-HRMS API running",
        "total_records":   len(db['records']),
        "dates_processed": len(db['dates_processed']),
        "dates":           db['dates_processed'],
        "endpoints": {
            "POST /upload":        "Upload daily Excel file",
            "GET  /records":       "All records (filter: ?date=&dept=&status=late|early|ok)",
            "GET  /summary":       "Monthly summary by date & department",
            "GET  /departments":   "Department list with stats",
            "GET  /employees":     "Employee-wise monthly stats",
            "DELETE /reset":       "Clear all data (admin)",
        }
    })

@app.route('/upload', methods=['POST'])
def upload():
    if 'file' not in request.files:
        return jsonify({"error": "No file part. Send Excel as multipart/form-data key 'file'"}), 400

    f = request.files['file']
    if f.filename == '':
        return jsonify({"error": "No file selected"}), 400

    file_bytes = f.read()

    try:
        date_iso, date_str, new_records = parse_excel(file_bytes)
    except Exception as e:
        return jsonify({"error": f"Failed to parse Excel: {str(e)}"}), 422

    db = load_db()

    # Remove existing records for this date (allow re-upload)
    if date_iso in db['dates_processed']:
        db['records'] = [r for r in db['records'] if r['date'] != date_iso]
        db['dates_processed'].remove(date_iso)

    db['records'].extend(new_records)
    db['dates_processed'].append(date_iso)
    db['dates_processed'].sort()
    save_db(db)

    return jsonify({
        "status":        "success",
        "date":          date_str,
        "records_added": len(new_records),
        "total_records": len(db['records']),
        "total_days":    len(db['dates_processed']),
        "departments":   list({r['dept'] for r in new_records}),
    })

@app.route('/records', methods=['GET'])
def get_records():
    db       = load_db()
    recs     = db['records']
    date_f   = request.args.get('date', '')
    dept_f   = request.args.get('dept', '')
    status_f = request.args.get('status', '')
    search_f = request.args.get('search', '').lower()

    if date_f:   recs = [r for r in recs if r['date'] == date_f]
    if dept_f:   recs = [r for r in recs if r['dept'] == dept_f]
    if search_f: recs = [r for r in recs if search_f in r['name'].lower() or search_f in r['ticket']]
    if status_f == 'late':  recs = [r for r in recs if r['late_min']  > 0]
    if status_f == 'early': recs = [r for r in recs if r['early_min'] > 0]
    if status_f == 'ok':    recs = [r for r in recs if r['late_min'] == 0 and r['early_min'] == 0]

    return jsonify({"count": len(recs), "records": recs})

@app.route('/summary', methods=['GET'])
def get_summary():
    db   = load_db()
    recs = db['records']

    by_date = defaultdict(lambda: {'total':0,'late':0,'early':0,'on_time':0})
    by_dept = defaultdict(lambda: {'total':0,'late':0,'early':0})

    for r in recs:
        by_date[r['date']]['total'] += 1
        by_dept[r['dept']]['total'] += 1
        if r['late_min']  > 0:
            by_date[r['date']]['late']  += 1
            by_dept[r['dept']]['late']  += 1
        if r['early_min'] > 0:
            by_date[r['date']]['early'] += 1
            by_dept[r['dept']]['early'] += 1

    for d in by_date.values():
        d['on_time']  = d['total'] - d['late'] - d['early']
        d['late_pct'] = round(d['late'] / d['total'] * 100) if d['total'] else 0

    for d in by_dept.values():
        d['late_pct'] = round(d['late'] / d['total'] * 100) if d['total'] else 0

    return jsonify({
        "total_records": len(recs),
        "total_days":    len(db['dates_processed']),
        "by_date": {k: v for k, v in sorted(by_date.items())},
        "by_dept": {k: v for k, v in sorted(by_dept.items())},
    })

@app.route('/departments', methods=['GET'])
def get_departments():
    db   = load_db()
    recs = db['records']
    by_dept = defaultdict(lambda: {'total':0,'late':0,'early':0,'employees':set()})
    for r in recs:
        by_dept[r['dept']]['total'] += 1
        by_dept[r['dept']]['employees'].add(r['ticket'])
        if r['late_min']  > 0: by_dept[r['dept']]['late']  += 1
        if r['early_min'] > 0: by_dept[r['dept']]['early'] += 1

    result = []
    for dept, v in sorted(by_dept.items()):
        result.append({
            "dept":          dept,
            "total_records": v['total'],
            "unique_emp":    len(v['employees']),
            "late":          v['late'],
            "early":         v['early'],
            "late_pct":      round(v['late'] / v['total'] * 100) if v['total'] else 0,
        })
    return jsonify({"departments": result})

@app.route('/employees', methods=['GET'])
def get_employees():
    db    = load_db()
    recs  = db['records']
    dept_f = request.args.get('dept', '')
    if dept_f:
        recs = [r for r in recs if r['dept'] == dept_f]

    emp_map = {}
    for r in recs:
        key = r['ticket']
        if key not in emp_map:
            emp_map[key] = {
                'ticket': r['ticket'], 'name': r['name'], 'dept': r['dept'],
                'days': 0, 'late_days': 0, 'early_days': 0,
                'total_hrs': 0.0, 'total_late_min': 0, 'total_early_min': 0,
            }
        emp_map[key]['days']            += 1
        emp_map[key]['total_hrs']       += r['hrs_decimal']
        emp_map[key]['total_late_min']  += r['late_min']
        emp_map[key]['total_early_min'] += r['early_min']
        if r['late_min']  > 0: emp_map[key]['late_days']  += 1
        if r['early_min'] > 0: emp_map[key]['early_days'] += 1

    for e in emp_map.values():
        e['avg_hrs']  = round(e['total_hrs'] / e['days'], 2) if e['days'] else 0
        e['late_pct'] = round(e['late_days']  / e['days'] * 100) if e['days'] else 0
        e['total_hrs']= round(e['total_hrs'], 2)
        e['status']   = ('Chronic Late' if e['late_pct'] >= 75 else
                         'Often Late'   if e['late_pct'] >= 50 else
                         'Late'         if e['late_pct'] >= 25 else 'Good')

    result = sorted(emp_map.values(), key=lambda x: -x['late_pct'])
    return jsonify({"count": len(result), "employees": result})

@app.route('/reset', methods=['DELETE'])
def reset():
    if os.path.exists(JSON_FILE):
        os.remove(JSON_FILE)
    return jsonify({"status": "All data cleared"})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
