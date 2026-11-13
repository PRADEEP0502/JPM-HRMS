"""
generate_dashboard.py
─────────────────────
Reads C:/HRAT/monthly_data/monthly_records.json
Generates C:/HRAT/monthly_data/dashboard.html
"""

import json, os, sys
from collections import defaultdict
from datetime import datetime

DATA_DIR  = r'C:/HRAT/monthly_data'
JSON_FILE = os.path.join(DATA_DIR, 'monthly_records.json')
DASH_FILE = os.path.join(DATA_DIR, 'dashboard.html')

if not os.path.exists(JSON_FILE):
    print("No data yet. Run process_daily.py first.")
    sys.exit(0)

with open(JSON_FILE, 'r', encoding='utf-8') as f:
    db = json.load(f)

records = db['records']
dates   = sorted(db['dates_processed'])

if not records:
    print("No records found in DB.")
    sys.exit(0)

# ── ANALYTICS ─────────────────────────────────────────────────────────────

# 1. By date
by_date = defaultdict(list)
for r in records:
    by_date[r['date']].append(r)

# 2. By department
by_dept = defaultdict(list)
for r in records:
    by_dept[r['dept']].append(r)

# 3. All unique departments
all_depts = sorted(by_dept.keys())

# 4. All unique employees (ticket + name)
emp_map = {}
for r in records:
    key = r['ticket']
    if key not in emp_map:
        emp_map[key] = {'ticket': r['ticket'], 'name': r['name'], 'dept': r['dept'],
                        'days': 0, 'late_days': 0, 'early_days': 0,
                        'total_hrs': 0.0, 'total_late_min': 0, 'total_early_min': 0}
    emp_map[key]['days']           += 1
    emp_map[key]['total_hrs']      += r['hrs_decimal']
    emp_map[key]['total_late_min'] += r['late_min']
    emp_map[key]['total_early_min']+= r['early_min']
    if r['late_min']  > 0: emp_map[key]['late_days']  += 1
    if r['early_min'] > 0: emp_map[key]['early_days'] += 1

employees = list(emp_map.values())
for e in employees:
    e['avg_hrs']      = round(e['total_hrs'] / e['days'], 2) if e['days'] else 0
    e['late_pct']     = round(e['late_days']  / e['days'] * 100) if e['days'] else 0
    e['total_hrs']    = round(e['total_hrs'], 2)

# 5. Daily summary (for trend chart)
daily_summary = []
for d in dates:
    recs = by_date[d]
    total = len(recs)
    late  = sum(1 for r in recs if r['late_min']  > 0)
    early = sum(1 for r in recs if r['early_min'] > 0)
    dt    = datetime.strptime(d, '%Y-%m-%d')
    daily_summary.append({
        'date':      d,
        'label':     dt.strftime('%d %b'),
        'total':     total,
        'late':      late,
        'early':     early,
        'on_time':   total - late - early,
        'late_pct':  round(late/total*100) if total else 0,
    })

# 6. Dept monthly summary
dept_summary = []
for dept in all_depts:
    recs  = by_dept[dept]
    total = len(recs)
    late  = sum(1 for r in recs if r['late_min']  > 0)
    early = sum(1 for r in recs if r['early_min'] > 0)
    dept_summary.append({
        'dept':      dept,
        'total':     total,
        'late':      late,
        'early':     early,
        'late_pct':  round(late/total*100) if total else 0,
    })

# 7. KPIs
total_records  = len(records)
total_days     = len(dates)
total_late     = sum(1 for r in records if r['late_min']  > 0)
total_early    = sum(1 for r in records if r['early_min'] > 0)
avg_late_pct   = round(total_late / total_records * 100) if total_records else 0
worst_day      = max(daily_summary, key=lambda x: x['late_pct'])['label'] if daily_summary else '—'
most_late_dept = max(dept_summary, key=lambda x: x['late_pct'])['dept']   if dept_summary else '—'

# ── BUILD JS DATA ─────────────────────────────────────────────────────────
js_data = f"""
const DB_META = {{
  total_records: {total_records},
  total_days:    {total_days},
  total_late:    {total_late},
  total_early:   {total_early},
  avg_late_pct:  {avg_late_pct},
  worst_day:     "{worst_day}",
  most_late_dept:"{most_late_dept}",
  generated:     "{datetime.now().strftime('%d-%m-%Y %H:%M')}",
  dates:         {json.dumps(dates)},
}};

const DAILY   = {json.dumps(daily_summary,  ensure_ascii=False)};
const DEPTS   = {json.dumps(dept_summary,   ensure_ascii=False)};
const RECORDS = {json.dumps(records,        ensure_ascii=False)};
const EMPS    = {json.dumps(employees,      ensure_ascii=False)};
"""

# ── BUILD HTML ────────────────────────────────────────────────────────────
html = r"""<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <script src="https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js"></script>
  <style>
    * { box-sizing: border-box; }
    .bar-wrap { background: var(--border); border-radius: 999px; overflow: hidden; height: 10px; }
    .bar-fill  { height: 10px; border-radius: 999px; transition: width 0.5s ease; }
    .tab-btn   { transition: all 0.2s; border-bottom: 2px solid transparent; cursor: pointer; }
    .tab-btn.active { border-bottom-color: var(--primary); color: var(--primary); font-weight:600; }
    .badge-late  { background:#FEF3C7;color:#92400E;border-radius:4px;padding:1px 7px;font-size:12px;font-weight:600; }
    .badge-early { background:#FEE2E2;color:#991B1B;border-radius:4px;padding:1px 7px;font-size:12px;font-weight:600; }
    .badge-ok    { background:#D1FAE5;color:#065F46;border-radius:4px;padding:1px 7px;font-size:12px;font-weight:600; }
    .badge-warn  { background:#EDE9FE;color:#5B21B6;border-radius:4px;padding:1px 7px;font-size:12px;font-weight:600; }
    table { border-collapse:collapse; width:100%; }
    th { background:var(--sidebar);color:var(--muted-foreground);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:8px 12px;text-align:left;position:sticky;top:0;z-index:1; }
    td { padding:8px 12px;font-size:13px;border-bottom:1px solid var(--border);color:var(--foreground); }
    tr:last-child td { border-bottom:none; }
    tr:hover td { background:var(--accent); }
    .stat-card { background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 20px; }
    select,input { background:var(--card);border:1px solid var(--border);color:var(--foreground);border-radius:8px;padding:6px 12px;font-size:13px;outline:none; }
    select:focus,input:focus { border-color:var(--primary); }
    .chart-bar { transition: height 0.5s ease; }
    .chart-wrap { display:flex;align-items:flex-end;gap:4px;height:120px;padding-top:8px; }
    .chart-col  { display:flex;flex-direction:column;align-items:center;flex:1;min-width:0; }
    .chart-col .lbl { font-size:10px;color:var(--muted-foreground);margin-top:4px;writing-mode:vertical-lr;transform:rotate(180deg);max-height:48px;overflow:hidden;text-overflow:ellipsis; }
    .sticky-header { position:sticky;top:0;background:var(--background);z-index:10;padding-bottom:8px; }
    .scrollbox { overflow-y:auto;max-height:360px; }
  </style>
</head>
<body class="bg-[var(--background)] text-[var(--foreground)] antialiased p-4">
""" + f"<script>{js_data}</script>" + r"""

<!-- HEADER -->
<div class="sticky-header pt-2">
  <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
    <div>
      <h1 class="text-xl font-bold">📋 Daily Movement — Monthly Dashboard</h1>
      <p class="text-[var(--muted-foreground)] text-xs mt-0.5">Junior Processing Mill &nbsp;·&nbsp; <span id="date-range"></span> &nbsp;·&nbsp; Generated: <span id="gen-time"></span></p>
    </div>
    <div class="flex gap-2 items-center flex-wrap">
      <select id="month-filter" onchange="applyAll()" style="font-size:12px">
        <option value="">All Dates</option>
      </select>
      <select id="dept-filter-g" onchange="applyAll()" style="font-size:12px">
        <option value="">All Departments</option>
      </select>
    </div>
  </div>

  <!-- KPI CARDS -->
  <div class="grid gap-3 mb-3" style="grid-template-columns:repeat(5,1fr)">
    <div class="stat-card">
      <p class="text-[var(--muted-foreground)] text-xs font-semibold uppercase tracking-wider mb-1">Working Days</p>
      <p class="text-2xl font-bold" id="kpi-days"></p>
      <p class="text-xs text-[var(--muted-foreground)]">Days processed</p>
    </div>
    <div class="stat-card">
      <p class="text-[var(--muted-foreground)] text-xs font-semibold uppercase tracking-wider mb-1">Total Entries</p>
      <p class="text-2xl font-bold" id="kpi-total"></p>
      <p class="text-xs text-[var(--muted-foreground)]">Employee-day records</p>
    </div>
    <div class="stat-card">
      <p class="text-[var(--muted-foreground)] text-xs font-semibold uppercase tracking-wider mb-1">Late Arrivals</p>
      <p class="text-2xl font-bold" style="color:#D97706" id="kpi-late"></p>
      <p class="text-xs text-[var(--muted-foreground)]" id="kpi-late-pct"></p>
    </div>
    <div class="stat-card">
      <p class="text-[var(--muted-foreground)] text-xs font-semibold uppercase tracking-wider mb-1">Worst Day</p>
      <p class="text-2xl font-bold" style="color:#DC2626" id="kpi-worst"></p>
      <p class="text-xs text-[var(--muted-foreground)]">Most late arrivals</p>
    </div>
    <div class="stat-card">
      <p class="text-[var(--muted-foreground)] text-xs font-semibold uppercase tracking-wider mb-1">Top Late Dept</p>
      <p class="text-lg font-bold" style="color:#7C3AED" id="kpi-dept"></p>
      <p class="text-xs text-[var(--muted-foreground)]">Highest late %</p>
    </div>
  </div>

  <!-- TABS -->
  <div class="flex gap-5 border-b border-[var(--border)] mb-4">
    <button class="tab-btn active pb-2 text-sm" onclick="showTab('trend',this)">📈 Daily Trend</button>
    <button class="tab-btn pb-2 text-sm text-[var(--muted-foreground)]" onclick="showTab('dept',this)">🏭 Departments</button>
    <button class="tab-btn pb-2 text-sm text-[var(--muted-foreground)]" onclick="showTab('emp',this)">👥 Employees</button>
    <button class="tab-btn pb-2 text-sm text-[var(--muted-foreground)]" onclick="showTab('log',this)">📄 All Records</button>
  </div>
</div>

<!-- TAB: DAILY TREND -->
<div id="tab-trend">
  <div class="grid gap-4 mb-4" style="grid-template-columns:2fr 1fr">
    <div class="stat-card">
      <h3 class="font-semibold text-sm mb-3">Daily Attendance Overview</h3>
      <div id="trend-chart" class="chart-wrap"></div>
      <div class="flex gap-4 mt-3 text-xs text-[var(--muted-foreground)]">
        <span class="flex items-center gap-1"><span style="width:10px;height:10px;background:#34D399;border-radius:2px;display:inline-block"></span> On Time</span>
        <span class="flex items-center gap-1"><span style="width:10px;height:10px;background:#FBBF24;border-radius:2px;display:inline-block"></span> Late</span>
        <span class="flex items-center gap-1"><span style="width:10px;height:10px;background:#F87171;border-radius:2px;display:inline-block"></span> Early Out</span>
      </div>
    </div>
    <div class="stat-card">
      <h3 class="font-semibold text-sm mb-3">Late % per Day</h3>
      <div class="scrollbox space-y-2" id="late-pct-bars"></div>
    </div>
  </div>
  <div class="stat-card">
    <h3 class="font-semibold text-sm mb-2">Day-wise Summary Table</h3>
    <div class="scrollbox">
      <table>
        <thead><tr>
          <th>Date</th><th>Day</th><th style="text-align:right">Total</th>
          <th style="text-align:right">Late</th><th style="text-align:right">Early</th>
          <th style="text-align:right">On Time</th><th>Late %</th>
        </tr></thead>
        <tbody id="trend-table"></tbody>
      </table>
    </div>
  </div>
</div>

<!-- TAB: DEPARTMENTS -->
<div id="tab-dept" class="hidden">
  <div class="grid gap-4 mb-4" style="grid-template-columns:1fr 1fr">
    <div class="stat-card">
      <h3 class="font-semibold text-sm mb-3">Employee Count by Department</h3>
      <div class="space-y-2" id="dept-emp-bars"></div>
    </div>
    <div class="stat-card">
      <h3 class="font-semibold text-sm mb-3">Late % by Department</h3>
      <div class="space-y-2" id="dept-late-bars"></div>
    </div>
  </div>
  <div class="stat-card">
    <h3 class="font-semibold text-sm mb-2">Department Summary</h3>
    <div class="scrollbox">
      <table>
        <thead><tr>
          <th>Department</th><th style="text-align:right">Total Records</th>
          <th style="text-align:right">Late</th><th style="text-align:right">Early</th>
          <th style="text-align:right">Late %</th><th>Trend</th>
        </tr></thead>
        <tbody id="dept-table"></tbody>
      </table>
    </div>
  </div>
</div>

<!-- TAB: EMPLOYEES -->
<div id="tab-emp" class="hidden">
  <div class="stat-card mb-3 flex items-center gap-3 flex-wrap">
    <input type="text" id="emp-search" placeholder="Search name / ticket..." oninput="renderEmpTable()" style="width:200px">
    <select id="emp-dept-filter" onchange="renderEmpTable()">
      <option value="">All Departments</option>
    </select>
    <select id="emp-sort" onchange="renderEmpTable()">
      <option value="late_pct">Sort: Most Late %</option>
      <option value="late_days">Sort: Most Late Days</option>
      <option value="avg_hrs">Sort: Avg Hours</option>
      <option value="name">Sort: Name A-Z</option>
    </select>
    <span id="emp-count" class="ml-auto text-xs text-[var(--muted-foreground)]"></span>
  </div>
  <div class="stat-card">
    <div class="scrollbox">
      <table>
        <thead><tr>
          <th>Ticket</th><th>Employee</th><th>Department</th>
          <th style="text-align:right">Days</th><th style="text-align:right">Late Days</th>
          <th style="text-align:right">Early Days</th><th style="text-align:right">Avg Hrs</th>
          <th style="text-align:right">Late %</th><th>Status</th>
        </tr></thead>
        <tbody id="emp-table"></tbody>
      </table>
    </div>
  </div>
</div>

<!-- TAB: ALL RECORDS -->
<div id="tab-log" class="hidden">
  <div class="stat-card mb-3 flex items-center gap-3 flex-wrap">
    <select id="log-date" onchange="renderLogTable()" style="font-size:12px">
      <option value="">All Dates</option>
    </select>
    <select id="log-dept" onchange="renderLogTable()" style="font-size:12px">
      <option value="">All Departments</option>
    </select>
    <select id="log-status" onchange="renderLogTable()" style="font-size:12px">
      <option value="">All Status</option>
      <option value="late">Late</option>
      <option value="early">Early</option>
      <option value="ok">On Time</option>
    </select>
    <input type="text" id="log-search" placeholder="Name / Ticket..." oninput="renderLogTable()" style="width:160px;font-size:12px">
    <span id="log-count" class="ml-auto text-xs text-[var(--muted-foreground)]"></span>
  </div>
  <div class="stat-card">
    <div class="scrollbox">
      <table>
        <thead><tr>
          <th>Date</th><th>Ticket</th><th>Name</th><th>Dept</th>
          <th>Worked Hrs</th><th style="text-align:right">Late (min)</th>
          <th style="text-align:right">Early (min)</th><th>Status</th>
        </tr></thead>
        <tbody id="log-table"></tbody>
      </table>
    </div>
  </div>
</div>

<script>
// ── INIT ────────────────────────────────────────────────────────────────
document.getElementById('gen-time').textContent   = DB_META.generated;

function populateSelects() {
  // month-filter
  const mf = document.getElementById('month-filter');
  DB_META.dates.forEach(d => {
    const o = document.createElement('option');
    o.value = d;
    const dt = new Date(d);
    o.textContent = dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
    mf.appendChild(o);
  });

  // dept-filter-g
  const df = document.getElementById('dept-filter-g');
  DEPTS.forEach(d => {
    const o = document.createElement('option'); o.value=d.dept; o.textContent=d.dept; df.appendChild(o);
  });

  // emp-dept-filter
  const ef = document.getElementById('emp-dept-filter');
  DEPTS.forEach(d => {
    const o = document.createElement('option'); o.value=d.dept; o.textContent=d.dept; ef.appendChild(o);
  });

  // log-date
  const ld = document.getElementById('log-date');
  DB_META.dates.forEach(d => {
    const o = document.createElement('option');
    o.value = d;
    const dt = new Date(d);
    o.textContent = dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
    ld.appendChild(o);
  });

  // log-dept
  const ldp = document.getElementById('log-dept');
  DEPTS.forEach(d => {
    const o = document.createElement('option'); o.value=d.dept; o.textContent=d.dept; ldp.appendChild(o);
  });
}
populateSelects();

// ── GLOBAL FILTER ───────────────────────────────────────────────────────
function getFiltered() {
  const date = document.getElementById('month-filter').value;
  const dept = document.getElementById('dept-filter-g').value;
  return RECORDS.filter(r =>
    (!date || r.date === date) &&
    (!dept || r.dept === dept)
  );
}

function applyAll() {
  const recs = getFiltered();
  updateKPIs(recs);
  renderTrend(recs);
  renderDept(recs);
}

// ── KPIs ────────────────────────────────────────────────────────────────
function updateKPIs(recs) {
  const dates = [...new Set(recs.map(r=>r.date))];
  const late  = recs.filter(r=>r.late_min>0).length;
  const early = recs.filter(r=>r.early_min>0).length;
  const pct   = recs.length ? Math.round(late/recs.length*100) : 0;

  // date range label
  if (dates.length) {
    const sorted = [...dates].sort();
    const f = new Date(sorted[0]).toLocaleDateString('en-GB',{day:'2-digit',month:'short'});
    const l = new Date(sorted[sorted.length-1]).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
    document.getElementById('date-range').textContent = f + ' – ' + l;
  }

  document.getElementById('kpi-days').textContent    = dates.length;
  document.getElementById('kpi-total').textContent   = recs.length;
  document.getElementById('kpi-late').textContent    = late;
  document.getElementById('kpi-late-pct').textContent= pct + '% of workforce';

  // worst day
  const byDate = {};
  recs.forEach(r => { byDate[r.date] = byDate[r.date] || {l:0,t:0}; byDate[r.date].t++; if(r.late_min>0) byDate[r.date].l++; });
  let worst='—', worstPct=0;
  Object.entries(byDate).forEach(([d,v]) => { const p=v.t?Math.round(v.l/v.t*100):0; if(p>worstPct){worstPct=p;worst=new Date(d).toLocaleDateString('en-GB',{day:'2-digit',month:'short'});} });
  document.getElementById('kpi-worst').textContent = worst;

  // top late dept
  const byDept = {};
  recs.forEach(r => { byDept[r.dept]=byDept[r.dept]||{l:0,t:0}; byDept[r.dept].t++; if(r.late_min>0) byDept[r.dept].l++; });
  let topD='—', topDPct=0;
  Object.entries(byDept).forEach(([d,v]) => { const p=v.t?Math.round(v.l/v.t*100):0; if(p>topDPct){topDPct=p;topD=d;} });
  document.getElementById('kpi-dept').textContent = topD;
}

// ── TREND TAB ───────────────────────────────────────────────────────────
function renderTrend(recs) {
  const byDate = {};
  recs.forEach(r => {
    if(!byDate[r.date]) byDate[r.date]={date:r.date,label:'',total:0,late:0,early:0,day:r.day};
    byDate[r.date].total++;
    if(r.late_min>0)  byDate[r.date].late++;
    if(r.early_min>0) byDate[r.date].early++;
  });
  const days = Object.values(byDate).sort((a,b)=>a.date.localeCompare(b.date));
  days.forEach(d => { const dt=new Date(d.date); d.label=dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short'}); });

  const maxT = Math.max(...days.map(d=>d.total),1);

  // Stacked bar chart
  const chart = document.getElementById('trend-chart');
  chart.innerHTML = days.map(d => {
    const ontime = d.total - d.late - d.early;
    const hL = Math.round(d.late  /maxT*110);
    const hE = Math.round(d.early /maxT*110);
    const hO = Math.round(ontime  /maxT*110);
    const pct = d.total ? Math.round(d.late/d.total*100) : 0;
    return `<div class="chart-col" title="${d.label}: ${d.total} total, ${d.late} late, ${d.early} early">
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:110px;gap:1px">
        ${hE>0?`<div class="chart-bar" style="width:16px;height:${hE}px;background:#F87171;border-radius:2px 2px 0 0"></div>`:''}
        ${hL>0?`<div class="chart-bar" style="width:16px;height:${hL}px;background:#FBBF24"></div>`:''}
        ${hO>0?`<div class="chart-bar" style="width:16px;height:${hO}px;background:#34D399;border-radius:0 0 2px 2px"></div>`:''}
      </div>
      <div class="lbl">${d.label}</div>
    </div>`;
  }).join('');

  // Late pct bars
  const pctBars = document.getElementById('late-pct-bars');
  pctBars.innerHTML = days.map(d => {
    const pct = d.total ? Math.round(d.late/d.total*100) : 0;
    return `<div class="flex items-center gap-2">
      <span class="text-xs text-[var(--muted-foreground)] shrink-0" style="width:52px">${d.label}</span>
      <div class="bar-wrap flex-1"><div class="bar-fill" style="width:${pct}%;background:#FBBF24"></div></div>
      <span class="text-xs font-semibold shrink-0" style="width:30px;text-align:right">${pct}%</span>
    </div>`;
  }).join('');

  // Summary table
  const tbody = document.getElementById('trend-table');
  tbody.innerHTML = days.map(d => {
    const pct = d.total ? Math.round(d.late/d.total*100) : 0;
    const ontime = d.total - d.late - d.early;
    const color = pct>50?'#DC2626':pct>25?'#D97706':'#059669';
    return `<tr>
      <td class="font-medium">${d.label}</td>
      <td class="text-[var(--muted-foreground)]">${d.day||''}</td>
      <td style="text-align:right">${d.total}</td>
      <td style="text-align:right">${d.late>0?`<span class="badge-late">${d.late}</span>`:'0'}</td>
      <td style="text-align:right">${d.early>0?`<span class="badge-early">${d.early}</span>`:'0'}</td>
      <td style="text-align:right"><span class="badge-ok">${ontime}</span></td>
      <td><span style="font-weight:600;color:${color}">${pct}%</span></td>
    </tr>`;
  }).join('');
}

// ── DEPT TAB ────────────────────────────────────────────────────────────
function renderDept(recs) {
  const byDept = {};
  recs.forEach(r => {
    if(!byDept[r.dept]) byDept[r.dept]={dept:r.dept,total:0,late:0,early:0};
    byDept[r.dept].total++;
    if(r.late_min>0)  byDept[r.dept].late++;
    if(r.early_min>0) byDept[r.dept].early++;
  });
  const depts = Object.values(byDept).sort((a,b)=>b.total-a.total);
  const maxEmp  = Math.max(...depts.map(d=>d.total),1);
  const maxLate = Math.max(...depts.map(d=>d.late_pct||0),1);

  depts.forEach(d => d.late_pct = d.total ? Math.round(d.late/d.total*100) : 0);

  document.getElementById('dept-emp-bars').innerHTML = depts.map(d=>
    `<div class="flex items-center gap-2">
      <span class="text-xs text-[var(--muted-foreground)] shrink-0 truncate" style="width:100px;text-align:right">${d.dept}</span>
      <div class="bar-wrap flex-1"><div class="bar-fill bg-[var(--primary)]" style="width:${Math.round(d.total/maxEmp*100)}%"></div></div>
      <span class="text-xs font-semibold shrink-0" style="width:24px;text-align:right">${d.total}</span>
    </div>`).join('');

  const maxLatePct = Math.max(...depts.map(d=>d.late_pct),1);
  document.getElementById('dept-late-bars').innerHTML = depts.map(d=>
    `<div class="flex items-center gap-2">
      <span class="text-xs text-[var(--muted-foreground)] shrink-0 truncate" style="width:100px;text-align:right">${d.dept}</span>
      <div class="bar-wrap flex-1"><div class="bar-fill" style="width:${Math.round(d.late_pct/maxLatePct*100)}%;background:#FBBF24"></div></div>
      <span class="text-xs font-semibold shrink-0" style="width:34px;text-align:right">${d.late_pct}%</span>
    </div>`).join('');

  document.getElementById('dept-table').innerHTML = depts.map(d => {
    const c = d.late_pct>50?'#DC2626':d.late_pct>25?'#D97706':'#059669';
    const pW = Math.round(d.late_pct);
    return `<tr>
      <td class="font-medium">${d.dept}</td>
      <td style="text-align:right">${d.total}</td>
      <td style="text-align:right">${d.late>0?`<span class="badge-late">${d.late}</span>`:'—'}</td>
      <td style="text-align:right">${d.early>0?`<span class="badge-early">${d.early}</span>`:'—'}</td>
      <td style="text-align:right"><span style="font-weight:600;color:${c}">${d.late_pct}%</span></td>
      <td><div class="bar-wrap"><div class="bar-fill" style="width:${pW}%;background:${c}"></div></div></td>
    </tr>`;
  }).join('');
}

// ── EMPLOYEE TAB ────────────────────────────────────────────────────────
function renderEmpTable() {
  const search = document.getElementById('emp-search').value.toLowerCase();
  const dept   = document.getElementById('emp-dept-filter').value;
  const sort   = document.getElementById('emp-sort').value;

  let emps = EMPS.filter(e =>
    (!dept || e.dept === dept) &&
    (!search || e.name.toLowerCase().includes(search) || e.ticket.includes(search))
  );

  emps.sort((a,b) => {
    if(sort==='name')      return a.name.localeCompare(b.name);
    if(sort==='avg_hrs')   return b.avg_hrs - a.avg_hrs;
    if(sort==='late_days') return b.late_days - a.late_days;
    return b.late_pct - a.late_pct;
  });

  document.getElementById('emp-count').textContent = `${emps.length} employees`;

  document.getElementById('emp-table').innerHTML = emps.map(e => {
    let badge = '<span class="badge-ok">Good</span>';
    if(e.late_pct>=75)      badge = '<span class="badge-late">Chronic Late</span>';
    else if(e.late_pct>=50) badge = '<span class="badge-warn">Often Late</span>';
    else if(e.late_pct>=25) badge = '<span class="badge-late">Late</span>';
    if(e.early_days>0 && e.late_pct>=50) badge += ' <span class="badge-early">Early</span>';
    return `<tr>
      <td>${e.ticket}</td>
      <td class="font-medium">${e.name}</td>
      <td class="text-[var(--muted-foreground)]">${e.dept}</td>
      <td style="text-align:right">${e.days}</td>
      <td style="text-align:right">${e.late_days>0?`<span class="badge-late">${e.late_days}</span>`:'0'}</td>
      <td style="text-align:right">${e.early_days>0?`<span class="badge-early">${e.early_days}</span>`:'0'}</td>
      <td style="text-align:right">${e.avg_hrs} Hrs</td>
      <td style="text-align:right"><b>${e.late_pct}%</b></td>
      <td>${badge}</td>
    </tr>`;
  }).join('');
}

// ── LOG TAB ─────────────────────────────────────────────────────────────
function renderLogTable() {
  const date   = document.getElementById('log-date').value;
  const dept   = document.getElementById('log-dept').value;
  const status = document.getElementById('log-status').value;
  const search = document.getElementById('log-search').value.toLowerCase();

  let recs = RECORDS.filter(r =>
    (!date   || r.date === date) &&
    (!dept   || r.dept === dept) &&
    (!search || r.name.toLowerCase().includes(search) || r.ticket.includes(search)) &&
    (status === '' ||
     (status==='late'  && r.late_min>0) ||
     (status==='early' && r.early_min>0) ||
     (status==='ok'    && r.late_min===0 && r.early_min===0))
  );

  document.getElementById('log-count').textContent = `${recs.length} records`;

  document.getElementById('log-table').innerHTML = recs.length===0
    ? `<tr><td colspan="8" style="text-align:center;color:var(--muted-foreground);padding:24px">No records found</td></tr>`
    : recs.map(r => {
        let badge = '<span class="badge-ok">On Time</span>';
        if(r.late_min>0 && r.early_min>0) badge=`<span class="badge-late">Late ${r.late_min}m</span> <span class="badge-early">Early ${r.early_min}m</span>`;
        else if(r.late_min>0)  badge=`<span class="badge-late">Late ${r.late_min}m</span>`;
        else if(r.early_min>0) badge=`<span class="badge-early">Early ${r.early_min}m</span>`;
        const dt = new Date(r.date);
        const dlabel = dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
        return `<tr>
          <td class="text-[var(--muted-foreground)]">${dlabel}</td>
          <td>${r.ticket}</td>
          <td class="font-medium">${r.name}</td>
          <td class="text-[var(--muted-foreground)]">${r.dept}</td>
          <td>${r.worked_hrs||'—'}</td>
          <td style="text-align:right">${r.late_min>0?`<b style="color:#D97706">${r.late_min}</b>`:'0'}</td>
          <td style="text-align:right">${r.early_min>0?`<b style="color:#DC2626">${r.early_min}</b>`:'0'}</td>
          <td>${badge}</td>
        </tr>`;
      }).join('');
}

// ── TAB SWITCHING ───────────────────────────────────────────────────────
function showTab(id, btn) {
  ['trend','dept','emp','log'].forEach(t => {
    document.getElementById('tab-'+t).classList.toggle('hidden', t!==id);
  });
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if(id==='emp')  renderEmpTable();
  if(id==='log')  renderLogTable();
}

// ── BOOT ────────────────────────────────────────────────────────────────
applyAll();
</script>
</body>
</html>
"""

with open(DASH_FILE, 'w', encoding='utf-8') as f:
    f.write(html)

print(f"Dashboard generated: {DASH_FILE}")
print(f"Records: {len(records)} | Days: {len(dates)} | Depts: {len(all_depts)}")
