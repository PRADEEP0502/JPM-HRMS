import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Activity, ArrowRight, Bell, CalendarDays, Check, ChevronDown,
  ChevronLeft, ChevronRight, Clock3, Download, FileUp, Filter, LayoutDashboard, LogOut,
  Menu, MoreHorizontal, Search, Settings, ShieldCheck, Sparkles, Users, X,
  BriefcaseBusiness, ChartNoAxesCombined, FileBarChart, Fingerprint,
  CalendarClock, CircleAlert, CircleCheck, UserPlus, KeyRound, Timer, FileSpreadsheet, SlidersHorizontal, Leaf,
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  attendanceRecords, departmentData, demoMode, employees, formatDate, getDepartments, getEmployee,
  getMonthlyTrendData, getRecordsForDate, getTrendData, getWeeklyTrendData, todayKey,
  replaceAttendanceData, resetAttendanceData, type AttendanceRecord, type AttendanceStatus, type Employee,
} from './data';
import {
  apiRequest, basicAuthorization, wakeBackend, type ApiDashboardSummary, type ApiDepartmentAnalytics,
  type ApiAlert, type ApiEmployee, type ApiIdentity, type ApiMovement, type ImportHistoryItem, type ImportPreview,
} from './api';
import { zipSync, strToU8 } from 'fflate';
import { parseMovementWorkbook, previewToData } from './excelImport';

type Role = 'HR' | 'MD' | 'Employee';
const todayAttendanceRecords = getRecordsForDate(todayKey);
const attendanceExceptionCount = todayAttendanceRecords.filter((record) =>
  record.status === 'Late' || record.status === 'Missing punch' || record.status === 'No punching' || record.status === 'Absent' || record.earlyMinutes > 0,
).length;
// Shorter names shown in the sidebar so every item fits on one line
const navShortLabel: Record<string, string> = {
  'Leave management': 'Leave',
  'Shift & schedule': 'Shifts',
  'Alerts & notifications': 'Alerts',
};

const navItems = [
  { label: 'Dashboard', icon: LayoutDashboard },
  { label: 'Attendance', icon: Fingerprint, badge: String(todayAttendanceRecords.filter((record) => record.status !== 'Present').length) },
  { label: 'Employees', icon: Users },
  { label: 'Leave management', icon: CalendarDays },
  { label: 'Reports', icon: FileBarChart },
  { label: 'Shift & schedule', icon: CalendarClock },
  { label: 'Alerts & notifications', icon: Bell, badge: String(attendanceExceptionCount) },
  { label: 'Analytics', icon: ChartNoAxesCombined },
];

const statusClass: Record<AttendanceStatus, string> = {
  Present: 'present', Late: 'late', Absent: 'absent', 'On duty': 'on-duty', 'Early out': 'early', 'Short hours': 'short', 'Missing punch': 'missing', 'No punching': 'missing',
};

const reportHeaders = [
  'Employee ID', 'Employee Name', 'Department', 'Date', 'First IN', 'Last OUT',
  'All Punch Records', 'Worked Hours', 'Late Minutes', 'Early Going Minutes', 'Attendance Status',
];

function reportRows(records: AttendanceRecord[]) {
  return records.map((record) => {
    const employee = getEmployee(record.employeeId);
    return [
      record.employeeId, employee?.name ?? '', employee?.department ?? '', record.date,
      record.firstIn, record.lastOut,
      record.punches?.map((punch) => punch.rawValue).join(' → ') ?? '',
      record.hours.toFixed(2), String(record.lateMinutes), String(record.earlyMinutes), record.status,
    ];
  });
}

function xmlEscape(value: string) {
  return value.replace(/[<>&'"]/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  })[character] ?? character);
}

function spreadsheetColumn(index: number) {
  let number = index + 1;
  let result = '';
  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }
  return result;
}

function downloadExcel(records: AttendanceRecord[], filename: string) {
  const allRows = [reportHeaders, ...reportRows(records)];
  const sheetRows = allRows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) =>
      `<c r="${spreadsheetColumn(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`,
    ).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  const files = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Attendance" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`),
  };
  const bytes = zipSync(files, { level: 6 });
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function downloadPdf(records: AttendanceRecord[], title: string) {
  const [pdfModule, tableModule] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const { jsPDF } = pdfModule;
  const autoTable = tableModule.default;
  const document = new jsPDF({ orientation: 'landscape' });
  document.setFontSize(15);
  document.text('JPM HRMS · Attendance Movement', 14, 16);
  document.setFontSize(9);
  document.text(title, 14, 23);
  autoTable(document, {
    startY: 28,
    head: [reportHeaders],
    body: reportRows(records).map((row) => row.map((value) => value.length > 58 ? `${value.slice(0, 55)}…` : value)),
    styles: { fontSize: 6.5, cellPadding: 2, overflow: 'linebreak' },
    headStyles: { fillColor: [22, 163, 74] },
    margin: { left: 10, right: 10 },
  });
  document.save(`jpm-attendance-${todayKey}.pdf`);
}

function App() {
  const [activeNav, setActiveNav] = useState('Dashboard');
  const [selectedDate, setSelectedDate] = useState(todayKey);
  const [department, setDepartment] = useState('All departments');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [role, setRole] = useState<Role>('HR');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [notice, setNotice] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [stagedFile, setStagedFile] = useState('');
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importError, setImportError] = useState('');
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState('');
  const [localImport, setLocalImport] = useState('');
  const [authOpen, setAuthOpen] = useState(!demoMode);
  const [authHeader, setAuthHeader] = useState<string | null>(null);
  const [authIdentity, setAuthIdentity] = useState<ApiIdentity | null>(null);
  const [authError, setAuthError] = useState('');
  const [apiError, setApiError] = useState('');
  const [dataVersion, setDataVersion] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [apiSummary, setApiSummary] = useState<ApiDashboardSummary | null>(null);
  const [departmentAnalytics, setDepartmentAnalytics] = useState<ApiDepartmentAnalytics[]>([]);
  const [apiAlerts, setApiAlerts] = useState<ApiAlert[]>([]);
  const [importHistory, setImportHistory] = useState<ImportHistoryItem[]>([]);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<string | null>(null);
  const [kpiDetail, setKpiDetail] = useState<string | null>(null);
  const [deptDetail, setDeptDetail] = useState<string | null>(null);
  const [shiftName, setShiftName] = useState('');
  const [shiftStart, setShiftStart] = useState('08:30');
  const [shiftEnd, setShiftEnd] = useState('17:30');
  const [shiftGrace, setShiftGrace] = useState('5');
  const [shiftEarlyGrace, setShiftEarlyGrace] = useState('5');
  const [shiftError, setShiftError] = useState('');
  const [shiftSuccess, setShiftSuccess] = useState('');
  const [employeeForm, setEmployeeForm] = useState({
    employeeId: '', employeeName: '', department: '', designation: '', shift: '', joiningDate: '', employmentStatus: 'ACTIVE',
  });
  const [employeeError, setEmployeeError] = useState('');
  const [employeeBusy, setEmployeeBusy] = useState(false);
  const [employeeImportResult, setEmployeeImportResult] = useState('');
  const pageSize = 6;
  const departments = getDepartments();

  // Wake the (sleeping) backend as soon as the app opens
  useEffect(() => { wakeBackend(); }, []);

  useEffect(() => {
    if (!authHeader) {
      resetAttendanceData();
      setDataVersion((version) => version + 1);
      return;
    }
    if (!authHeader) return;
    let active = true;
    const load = async () => {
      try {
        const from = new Date();
        from.setDate(from.getDate() - 364);
        const start = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;
        const [employeeRows, movementRows] = await Promise.all([
          apiRequest<ApiEmployee[]>('/api/employees', authHeader),
          apiRequest<ApiMovement[]>(`/api/attendance/records?from=${start}&to=${todayKey}`, authHeader),
        ]);
        if (!active) return;
        replaceAttendanceData(employeeRows, movementRows);
        setDataVersion((version) => version + 1);
        setApiError('');
      } catch (error) {
        if (active) setApiError(error instanceof Error ? error.message : 'Attendance data could not be loaded from the backend.');
      }
    };
    void load();
    return () => { active = false; };
  }, [authHeader, refreshKey]);

  useEffect(() => {
    if (!authHeader) {
      setApiSummary(null);
      setDepartmentAnalytics([]);
      setApiAlerts([]);
      setImportHistory([]);
      return;
    }
    let active = true;
    void Promise.all([
      apiRequest<ApiDashboardSummary>(`/api/dashboard/summary?date=${selectedDate}`, authHeader),
      apiRequest<ApiAlert[]>(`/api/alerts?date=${selectedDate}`, authHeader),
      authIdentity?.roles.some((item) => item === 'ROLE_HR' || item === 'ROLE_MD')
        ? apiRequest<ApiDepartmentAnalytics[]>(`/api/analytics/department?date=${selectedDate}`, authHeader)
        : Promise.resolve([] as ApiDepartmentAnalytics[]),
      authIdentity?.roles.some((item) => item === 'ROLE_HR' || item === 'ROLE_MD')
        ? apiRequest<ImportHistoryItem[]>('/api/import/history?limit=50', authHeader)
        : Promise.resolve([] as ImportHistoryItem[]),
    ]).then(([summary, alerts, analytics, history]) => {
      if (!active) return;
      setApiSummary(summary && typeof summary === 'object' && !Array.isArray(summary) ? summary : null);
      setApiAlerts(Array.isArray(alerts) ? alerts : (Array.isArray((alerts as any)?.alerts) ? (alerts as any).alerts : []));
      setDepartmentAnalytics(Array.isArray(analytics) ? analytics : (Array.isArray((analytics as any)?.departments) ? (analytics as any).departments : []));
      setImportHistory(Array.isArray(history) ? history : (Array.isArray((history as any)?.history) ? (history as any).history : []));
      setApiError('');
    }).catch((error: unknown) => {
      if (active) setApiError(error instanceof Error ? error.message : 'Dashboard summary could not be loaded.');
    });
    return () => { active = false; };
  }, [authHeader, authIdentity, selectedDate, refreshKey]);

  const selectedRecords = getRecordsForDate(selectedDate);
  const visibleRecords = role === 'Employee'
    ? selectedRecords.filter((record) => record.employeeId === (authIdentity?.employeeId || employees[0]?.id))
    : selectedRecords;
  const hasAttendanceData = apiSummary
    ? apiSummary.importedReportAvailable || visibleRecords.length > 0
    : visibleRecords.length > 0;
  const total = apiSummary?.totalEmployees ?? (role === 'Employee' ? Number(employees.length > 0) : employees.length);
  const present = hasAttendanceData
    ? (apiSummary?.presentEmployees ?? visibleRecords.filter((record) => record.status !== 'Absent' && record.status !== 'No punching').length)
    : null;
  const absent = apiSummary ? (apiSummary.absentEmployees ?? null) : visibleRecords.filter((record) => record.status === 'Absent').length;
  const late = hasAttendanceData ? (apiSummary?.lateComing ?? visibleRecords.filter((record) => record.lateMinutes > 0).length) : null;
  const early = hasAttendanceData ? (apiSummary?.earlyGoing ?? visibleRecords.filter((record) => record.earlyMinutes > 0).length) : null;
  const shortHoursCount = hasAttendanceData ? visibleRecords.filter((record) => (record.shortMinutes ?? 0) > 0).length : null;
  const missingPunchCount = hasAttendanceData ? (apiSummary?.missingPunches ?? visibleRecords.filter((record) => record.status === 'Missing punch' || record.status === 'No punching').length) : null;
  const workedRecords = visibleRecords.filter((record) => record.hours > 0);
  const averageHours = hasAttendanceData
    ? (apiSummary?.averageWorkingHours ?? (workedRecords.length
      ? Number((workedRecords.reduce((sum, record) => sum + record.hours, 0) / workedRecords.length).toFixed(2))
      : null))
    : null;
  const attendanceRate = hasAttendanceData && total && present !== null ? Math.round((present / total) * 100) : null;

  const filteredRecords = useMemo(() => {
    const query = search.trim().toLowerCase();
    return visibleRecords.filter((record) => {
      const employee = getEmployee(record.employeeId);
      if (!employee) return false;
      const matchesDepartment = department === 'All departments' || employee.department === department;
      const matchesQuery = !query || [employee.name, employee.id, employee.department].some((value) => value.toLowerCase().includes(query));
      return matchesDepartment && matchesQuery;
    }).sort((a, b) => {
      const employeeA = getEmployee(a.employeeId)?.name ?? '';
      const employeeB = getEmployee(b.employeeId)?.name ?? '';
      return employeeA.localeCompare(employeeB);
    });
  }, [department, search, selectedDate, role, dataVersion]);
  const pageCount = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
  const pageRecords = filteredRecords.slice((page - 1) * pageSize, page * pageSize);
  const scopeEmployeeId = role === 'Employee' ? authIdentity?.employeeId || employees[0]?.id : undefined;
  const trendData = getTrendData(7, scopeEmployeeId);
  const comparisonTrend = getTrendData(14, scopeEmployeeId);
  const monthlyTrendData = getMonthlyTrendData(6, scopeEmployeeId);
  const departmentsToday = hasAttendanceData ? departmentData(selectedDate) : [];
  const lateByDay = trendData.map((item, index) => {
    const offset = 7 - index - 1;
    const date = new Date();
    date.setDate(date.getDate() - offset);
    const dateString = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const records = getRecordsForDate(dateString).filter((record) => !scopeEmployeeId || record.employeeId === scopeEmployeeId);
    return { day: item.date, late: item.records ? records.filter((record) => record.lateMinutes > 0).length : null };
  });
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
  const thirtyDayKey = `${thirtyDaysAgo.getFullYear()}-${String(thirtyDaysAgo.getMonth() + 1).padStart(2, '0')}-${String(thirtyDaysAgo.getDate()).padStart(2, '0')}`;
  const performanceData = employees.map((employee) => {
    const records = attendanceRecords.filter((record) => record.employeeId === employee.id && record.date >= thirtyDayKey);
    if (!records.length) return null;
    const attended = records.filter((record) => record.status !== 'Absent' && record.status !== 'No punching').length;
    return { name: employee.name.split(' ')[0], rate: Math.round((attended / records.length) * 100) };
  }).filter((item): item is { name: string; rate: number } => item !== null).slice(0, 6);
  const lateFrequency = employees.map((employee) => ({
    employee,
    count: attendanceRecords.filter((record) => record.employeeId === employee.id && record.date >= thirtyDayKey && record.lateMinutes > 0).length,
    records: attendanceRecords.filter((record) => record.employeeId === employee.id && record.date >= thirtyDayKey).length,
  })).filter((item) => item.records > 0).sort((a, b) => b.count - a.count);
  const repeatedLate = lateFrequency.filter((item) => item.count > 0).slice(0, 2);
  const missingPunches = missingPunchCount;
  const recentWeek = comparisonTrend.slice(-7);
  const previousWeek = comparisonTrend.slice(0, 7);
  const hasTrendHistory = comparisonTrend.every((item) => item.records > 0);
  const weeklyChange = hasTrendHistory
    ? Math.round(recentWeek.reduce((sum, item) => sum + (item.attendance ?? 0), 0) / recentWeek.length - previousWeek.reduce((sum, item) => sum + (item.attendance ?? 0), 0) / previousWeek.length)
    : null;
  const latestMonth = monthlyTrendData[monthlyTrendData.length - 1];
  const usingDemoData = demoMode && !authHeader && !localImport;
  const backToDemo = () => {
    resetAttendanceData();
    setLocalImport('');
    setDataVersion((version) => version + 1);
    setDate(todayKey);
  };

  const kpiViews: Record<string, { title: string; note: string; match: (record: AttendanceRecord) => boolean }> = {
    total: { title: role === 'Employee' ? 'My employee record' : 'Total employees', note: 'Employees with an attendance record on this date', match: () => true },
    present: { title: 'Present', note: 'Recorded as present, late, early out or on duty', match: (record) => record.status !== 'Absent' && record.status !== 'No punching' },
    absent: { title: 'Absent', note: 'Marked absent for this date', match: (record) => record.status === 'Absent' },
    late: { title: 'Late arrivals', note: 'Arrived after the scheduled start', match: (record) => record.lateMinutes > 0 },
    early: { title: 'Early departures', note: 'Left before the scheduled end', match: (record) => record.earlyMinutes > 0 },
    short: { title: 'Short hours', note: 'Worked less than the 12-hour shift (all departments except Office)', match: (record) => (record.shortMinutes ?? 0) > 0 },
    onDuty: { title: 'On duty', note: 'Marked on duty in the report', match: (record) => record.status === 'On duty' },
    missing: { title: 'Missing punches', note: 'Incomplete or no-punch records', match: (record) => record.status === 'Missing punch' || record.status === 'No punching' },
    hours: { title: 'Working hours', note: 'Employees with valid punch pairs, longest first', match: (record) => record.hours > 0 },
  };
  const kpiView = kpiDetail ? kpiViews[kpiDetail] : null;
  const kpiRecords = kpiView
    ? visibleRecords.filter(kpiView.match).sort((a, b) => kpiDetail === 'hours'
      ? b.hours - a.hours
      : (getEmployee(a.employeeId)?.name ?? '').localeCompare(getEmployee(b.employeeId)?.name ?? ''))
    : [];

  const setDate = (date: string) => {
    setSelectedDate(date);
    setPage(1);
  };
  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 3500);
  };
  const moveDate = (days: number) => {
    const date = new Date(`${selectedDate}T00:00:00`);
    date.setDate(date.getDate() + days);
    setDate(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
  };
  const downloadCsv = () => {
    const rows = [
      reportHeaders,
      ...filteredRecords.map((record) => {
        const employee = getEmployee(record.employeeId);
        return [
          record.employeeId, employee?.name ?? '', employee?.department ?? '', record.date, record.firstIn, record.lastOut,
          record.punches?.map((punch) => punch.rawValue).join(' → ') ?? '', record.hours.toFixed(2),
          String(record.lateMinutes), String(record.earlyMinutes), record.status,
        ];
      }),
    ];
    const csv = rows.map((row) => row.map((field) => {
      const safe = /^[=+\-@]/.test(field) ? `'${field}` : field;
      return `"${safe.replace(/"/g, '""')}"`;
    }).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `jpm-attendance-${selectedDate}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    showNotice('Attendance CSV downloaded.');
  };
  const exportPdf = async (records: AttendanceRecord[], title: string) => {
    try {
      await downloadPdf(records, title);
      showNotice('Attendance PDF downloaded.');
    } catch (error) {
      showNotice(`PDF export failed: ${error instanceof Error ? error.message : 'Unexpected export error.'}`);
    }
  };

  const beginImport = () => {
    setStagedFile('');
    setImportPreview(null);
    setImportError('');
    setImportResult('');
    setImportOpen(true);
    wakeBackend();
    if (!authHeader && !demoMode) setAuthOpen(true);
  };
  const previewReport = async (file?: File) => {
    if (!file) return;
    setStagedFile(file.name);
    setImportPreview(null);
    setImportError('');
    if (!authHeader && demoMode) {
      if (!/.xlsx?$/i.test(file.name)) {
        setImportError('Browser import reads Excel files (.xlsx or .xls) only. Sign in to use the server import for PDF.');
        return;
      }
      setImportLoading(true);
      try {
        setImportPreview(parseMovementWorkbook(new Uint8Array(await file.arrayBuffer()), file.name));
      } catch (error) {
        setImportError(error instanceof Error ? error.message : 'The report could not be read.');
      } finally {
        setImportLoading(false);
      }
      return;
    }
    if (!authHeader) {
      setImportError('Sign in with an HR account to upload and preview attendance reports.');
      setAuthOpen(true);
      return;
    }
    if (!authIdentity?.roles.includes('ROLE_HR')) {
      setImportError('Only an HR account can upload attendance reports.');
      return;
    }
    const formData = new FormData();
    formData.append('file', file);
    setImportLoading(true);
    try {
      const endpoint = file.name.toLowerCase().endsWith('.pdf') ? '/api/import/pdf' : '/api/import/excel';
      const preview = await apiRequest<ImportPreview>(endpoint, authHeader, { method: 'POST', body: formData });
      setImportPreview(preview);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'The report could not be previewed.');
    } finally {
      setImportLoading(false);
    }
  };
  const commitReport = async () => {
    if (importPreview?.importId === 'local') {
      const { employees: importedEmployees, movements } = previewToData(importPreview);
      replaceAttendanceData(importedEmployees, movements);
      setDataVersion((version) => version + 1);
      setLocalImport(importPreview.filename);
      setDate(importPreview.reportDates[importPreview.reportDates.length - 1] ?? todayKey);
      setImportPreview({ ...importPreview, status: 'COMMITTED' });
      setImportResult(`Loaded ${importPreview.validRows} records from ${importPreview.filename} into this browser session.`);
      showNotice(`${importPreview.filename} loaded · ${importPreview.validRows} records`);
      return;
    }
    if (!authHeader || !importPreview) {
      setImportError('Select and preview a report before committing.');
      return;
    }
    setImportLoading(true);
    setImportError('');
    try {
      const result = await apiRequest<ImportPreview>(`/api/import/${importPreview.importId}/commit`, authHeader, { method: 'POST' });
      setImportPreview(result);
      setImportResult(`Import ${result.status.toLowerCase()}: ${result.validRows} saved, ${result.rejectedRows} rejected, ${result.duplicateRows} duplicates.`);
      setRefreshKey((key) => key + 1);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'The attendance report could not be committed.');
    } finally {
      setImportLoading(false);
    }
  };
  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError('');
    const form = new FormData(event.currentTarget);
    const username = String(form.get('username') ?? '').trim();
    const password = String(form.get('password') ?? '');
    if (!username || !password) {
      setAuthError('Enter your username and password.');
      return;
    }
    const authorization = basicAuthorization(username, password);
    try {
      const identity = await apiRequest<ApiIdentity>('/api/auth/me', authorization);
      setAuthHeader(authorization);
      setAuthIdentity(identity);
      const authorizedRole = identity.roles.includes('ROLE_HR') ? 'HR' : identity.roles.includes('ROLE_MD') ? 'MD' : 'Employee';
      setRole(authorizedRole);
      setAuthOpen(false);
      setAuthError('');
      setApiError('');
      setRefreshKey((key) => key + 1);
      showNotice(`Signed in as ${identity.username} · ${authorizedRole}`);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Sign-in failed. Check your credentials and API connection.');
    }
  };
  const continueInDemoMode = () => {
    if (!demoMode) return;
    setAuthHeader(null);
    setAuthIdentity(null);
    setRole('HR');
    resetAttendanceData();
    setDataVersion((version) => version + 1);
    setAuthError('');
    setAuthOpen(false);
    showNotice('Demo mode · sample data only. Real attendance data still requires sign-in.');
  };
  const signOut = () => {
    setAuthHeader(null);
    setAuthIdentity(null);
    setApiSummary(null);
    if (demoMode) {
      resetAttendanceData();
      setDataVersion((version) => version + 1);
      setRole('HR');
    }
    setAuthError('');
    setNotice('Signed out. API credentials were cleared from this session.');
  };
  const saveEmployee = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authHeader) { setAuthOpen(true); setEmployeeError('Sign in with an HR account to add employees.'); return; }
    setEmployeeBusy(true);
    setEmployeeError('');
    try {
      const employee = await apiRequest<ApiEmployee>('/api/employees', authHeader, {
        method: 'POST',
        body: JSON.stringify({ ...employeeForm, joiningDate: employeeForm.joiningDate || null }),
      });
      setRegisterOpen(false);
      setEmployeeForm({ employeeId: '', employeeName: '', department: '', designation: '', shift: '', joiningDate: '', employmentStatus: 'ACTIVE' });
      setRefreshKey((key) => key + 1);
      showNotice(`${employee.employeeName} added to the employee master.`);
    } catch (error) {
      setEmployeeError(error instanceof Error ? error.message : 'Employee could not be saved.');
    } finally {
      setEmployeeBusy(false);
    }
  };
  const importEmployeeFile = async (file?: File) => {
    if (!file) return;
    if (!authHeader) { setAuthOpen(true); setEmployeeImportResult('Sign in with an HR account to import employee masters.'); return; }
    const formData = new FormData();
    formData.append('file', file);
    setEmployeeImportResult('Validating employee master…');
    try {
      const result = await apiRequest<{ importedCount: number; rejectedCount: number; rejected: string[] }>(
        '/api/employees/import/excel', authHeader, { method: 'POST', body: formData },
      );
      setEmployeeImportResult(`Employee import complete: ${result.importedCount} added, ${result.rejectedCount} rejected.${result.rejected.length ? ` ${result.rejected.slice(0, 3).join(' ')}` : ''}`);
      setRefreshKey((key) => key + 1);
    } catch (error) {
      setEmployeeImportResult(error instanceof Error ? error.message : 'Employee master import failed.');
    }
  };
  const saveShift = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authHeader) { setAuthOpen(true); setShiftError('Sign in with an HR account to configure shifts.'); return; }
    setShiftError('');
    setShiftSuccess('');
    try {
      await apiRequest<Record<string, unknown>>('/api/shifts', authHeader, {
        method: 'POST',
        body: JSON.stringify({
          name: shiftName, startTime: shiftStart, endTime: shiftEnd,
          graceMinutes: Number(shiftGrace), earlyGraceMinutes: Number(shiftEarlyGrace),
          workDays: [1, 2, 3, 4, 5, 6],
        }),
      });
      setShiftSuccess('Shift saved. Assign it to employees in the employee master.');
      setShiftName('');
      setRefreshKey((key) => key + 1);
    } catch (error) {
      setShiftError(error instanceof Error ? error.message : 'Shift could not be saved.');
    }
  };

  const recentAttendanceRecords = attendanceRecords.filter((record) => record.date >= thirtyDayKey);
  const personalRecords = scopeEmployeeId ? recentAttendanceRecords.filter((record) => record.employeeId === scopeEmployeeId) : [];
  const personalLateCount = personalRecords.filter((record) => record.lateMinutes > 0).length;
  const hasSelectedRecords = visibleRecords.length > 0;
  const personalPerformance = performanceData.find((item) =>
    item.name === getEmployee(scopeEmployeeId ?? '')?.name.split(' ')[0],
  );
  const topDepartment = departmentsToday.filter((item) => item.present > 0).sort((a, b) => b.rate - a.rate)[0];
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  type Insight = { icon: typeof Users; color: string; title: string; value: string; body: string; empty?: boolean };
  const noData = (title: string, icon: typeof Users, color: string, body: string): Insight => ({ icon, color, title, value: 'No data yet', body, empty: true });

  const lateCard: Insight = role === 'Employee'
    ? personalRecords.length
      ? { icon: Clock3, color: 'amber', title: 'Your late arrivals', value: plural(personalLateCount, 'day'), body: 'Late in the last 30 days.' }
      : noData('Your late arrivals', Clock3, 'amber', 'No records for you in the last 30 days.')
    : !recentAttendanceRecords.length
      ? noData('Late arrivals', Clock3, 'amber', 'No records in the last 30 days.')
      : role === 'MD'
        ? { icon: Clock3, color: 'amber', title: 'Late arrivals', value: plural(lateFrequency.filter((item) => item.count >= 3).length, 'employee'), body: 'Late 3 or more times in the last 30 days.' }
        : repeatedLate.length
          ? { icon: Clock3, color: 'amber', title: 'Most often late', value: repeatedLate[0].employee.name, body: `Late on ${plural(repeatedLate[0].count, 'day')} in the last 30 days.` }
          : { icon: Clock3, color: 'amber', title: 'Late arrivals', value: 'None', body: 'Nobody was late in the last 30 days.' };

  const departmentCard: Insight = role === 'Employee'
    ? personalPerformance
      ? { icon: ChartNoAxesCombined, color: 'green', title: 'Your attendance', value: `${personalPerformance.rate}%`, body: 'Attendance rate over the last 30 days.' }
      : noData('Your attendance', ChartNoAxesCombined, 'green', 'No records for you in the last 30 days.')
    : !hasSelectedRecords
      ? noData('Top department', ChartNoAxesCombined, 'green', `No records for ${formatDate(selectedDate)}.`)
      : topDepartment
        ? { icon: ChartNoAxesCombined, color: 'green', title: 'Top department', value: `${topDepartment.rate}%`, body: `${topDepartment.department} has the best attendance today.` }
        : { icon: ChartNoAxesCombined, color: 'green', title: 'Top department', value: '0%', body: 'No one is marked present today.' };

  // ---- Company-wide insights (HR / MD) ----
  // Use the selected date if a report exists for it, otherwise the latest report on or before it.
  const reportDateList = [...new Set(attendanceRecords.map((record) => record.date))].sort();
  const insightDate = reportDateList.includes(selectedDate)
    ? selectedDate
    : [...reportDateList].reverse().find((date) => date <= selectedDate) ?? reportDateList[reportDateList.length - 1];
  const insightRecords = insightDate ? getRecordsForDate(insightDate) : [];
  const isPresent = (record: { status: string }) => record.status !== 'Absent' && record.status !== 'No punching';
  const rateOf = (records: typeof insightRecords) => records.length ? Math.round((records.filter(isPresent).length / records.length) * 100) : null;
  const insightPresent = insightRecords.filter(isPresent).length;
  const insightAbsent = insightRecords.filter((record) => record.status === 'Absent').length;
  const insightLate = insightRecords.filter((record) => record.lateMinutes > 0).length;
  const insightMissing = insightRecords.filter((record) => record.status === 'Missing punch' || record.status === 'No punching').length;
  const insightShort = insightRecords.filter((record) => (record.shortMinutes ?? 0) > 0).length;
  const insightRate = rateOf(insightRecords);
  const previousReportDate = insightDate ? reportDateList[reportDateList.indexOf(insightDate) - 1] : undefined;
  const previousRate = previousReportDate ? rateOf(getRecordsForDate(previousReportDate)) : null;
  const insightDepartments = insightDate ? departmentData(insightDate).filter((item) => item.total > 0) : [];
  const bestDepartment = insightDepartments[0];
  const weakestDepartment = insightDepartments[insightDepartments.length - 1];
  const insightDateLabel = insightDate ? formatDate(insightDate) : '';
  const shortDate = insightDate ? new Date(`${insightDate}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '';
  const rateChange = insightRate !== null && previousRate !== null ? insightRate - previousRate : null;

  const companyInsights: Insight[] = [
    insightRate === null
      ? noData('Attendance', CircleCheck, 'green', 'Import an attendance report to see who came in.')
      : { icon: CircleCheck, color: 'green', title: `Attendance · ${shortDate}`, value: `${insightRate}%`, body: `${insightPresent} of ${insightRecords.length} employees came in on ${insightDateLabel}.` },
    !insightRecords.length
      ? noData('Needs attention', CircleAlert, 'rose', 'Absent and missing punches appear after a report is imported.')
      : { icon: CircleAlert, color: insightAbsent ? 'rose' : 'green', title: `Needs attention · ${shortDate}`, value: insightAbsent ? `${insightAbsent} absent` : 'Nobody absent', body: `${plural(insightLate, 'late arrival')} · ${insightMissing} missing punch${insightMissing === 1 ? '' : 'es'} · ${insightShort} short of 12h.` },
    lateCard,
    !bestDepartment
      ? noData('Department attendance', ChartNoAxesCombined, 'green', 'Department figures appear after a report is imported.')
      : { icon: ChartNoAxesCombined, color: 'green', title: `Best department · ${shortDate}`, value: bestDepartment.department, body: `${bestDepartment.rate}% present (${bestDepartment.present}/${bestDepartment.total}).${weakestDepartment && weakestDepartment !== bestDepartment ? ` Lowest: ${weakestDepartment.department} ${weakestDepartment.rate}%.` : ''}` },
    rateChange === null
      ? noData('Change vs last report', Activity, 'blue', 'Needs at least two imported reports to compare.')
      : { icon: Activity, color: rateChange > 0 ? 'green' : rateChange < 0 ? 'rose' : 'blue', title: 'Change vs last report', value: rateChange === 0 ? 'No change' : `${rateChange > 0 ? '+' : '−'}${Math.abs(rateChange)}%`, body: `${insightRate}% on ${shortDate} vs ${previousRate}% on ${formatDate(previousReportDate!)}.` },
    latestMonth?.records
      ? { icon: CalendarDays, color: 'green', title: `${latestMonth.date} attendance`, value: `${latestMonth.attendance}%`, body: `Average across ${plural(latestMonth.records, 'record')} this month.` }
      : noData('This month', CalendarDays, 'green', 'No records for this month yet.'),
  ];

  const insights: Insight[] = role !== 'Employee' ? companyInsights : [
    lateCard,
    departmentCard,
    weeklyChange === null
      ? noData('Weekly change', Activity, 'blue', 'Needs 14 days of data to compare weeks.')
      : weeklyChange === 0
        ? { icon: Activity, color: 'blue', title: 'Weekly change', value: 'Steady', body: 'Same attendance as the previous 7 days.' }
        : { icon: Activity, color: weeklyChange > 0 ? 'green' : 'rose', title: 'Weekly change', value: `${weeklyChange > 0 ? '+' : '−'}${Math.abs(weeklyChange)}%`, body: `Attendance ${weeklyChange > 0 ? 'up' : 'down'} compared with the previous 7 days.` },
    missingPunches === null
      ? noData('Missing punches', Fingerprint, 'rose', 'Import a report to check punches.')
      : missingPunches
        ? { icon: Fingerprint, color: 'rose', title: 'Missing punches', value: plural(missingPunches, 'record'), body: 'May be missing an in or out punch today.' }
        : { icon: Fingerprint, color: 'green', title: 'Missing punches', value: 'All complete', body: 'Every record has its punches today.' },
    latestMonth?.records
      ? { icon: CalendarDays, color: 'green', title: `${latestMonth.date} attendance`, value: `${latestMonth.attendance}%`, body: `Based on ${plural(latestMonth.records, 'record')} this month.` }
      : noData('This month', CalendarDays, 'green', 'No records for this month yet.'),
  ];
  const accessibleNavItems = role === 'Employee'
    ? navItems.filter((item) => ['Dashboard', 'Attendance'].includes(item.label))
    : role === 'MD'
      ? navItems.filter((item) => ['Dashboard', 'Reports', 'Analytics'].includes(item.label))
      : navItems;
  const allowedNavItems = role === 'HR'
    ? [...accessibleNavItems, { label: 'Settings', icon: Settings }]
    : accessibleNavItems;

  return (
    <div className="app-shell">
      {mobileMenu && <button className="mobile-backdrop" onClick={() => setMobileMenu(false)} aria-label="Close navigation" />}
      <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}>
        <div className="brand-lockup">
          <div className="brand-mark"><Leaf size={16} strokeWidth={2.2} /></div>
          <div><div className="brand-name">JPM HRMS</div><div className="brand-caption">People &amp; attendance</div></div>
          <button className="sidebar-close" onClick={() => setMobileMenu(false)} aria-label="Close navigation"><X size={18} /></button>
        </div>
        <div className="workspace-switcher">
          <div className="workspace-icon">JM</div>
          <div className="workspace-copy"><strong>Junior Processing</strong><span>Company workspace</span></div>
        </div>
        <div className="sidebar-label">Menu</div>
        <nav className="nav-list" aria-label="Main navigation">
          {allowedNavItems.map(({ label, icon: Icon, badge }) => {
            const dynamicBadge = label === 'Attendance'
              ? String(visibleRecords.filter((record) => record.status !== 'Present').length)
              : label === 'Alerts & notifications'
                ? String(visibleRecords.filter((record) => record.status !== 'Present' || record.earlyMinutes > 0).length)
                : badge;
            return <button key={label} onClick={() => { setActiveNav(label); setMobileMenu(false); }} className={`nav-item ${activeNav === label ? 'nav-active' : ''}`}>
              <Icon size={18} strokeWidth={1.8} /><span>{navShortLabel[label] ?? label}</span>{dynamicBadge !== undefined && dynamicBadge !== '0' && <span className="nav-badge">{dynamicBadge}</span>}
            </button>;
          })}
        </nav>
        <div className="sidebar-spacer" />
        <button className="profile-button" onClick={() => authIdentity ? showNotice(`Signed in as ${authIdentity.username} · ${role}`) : showNotice(demoMode ? 'Demo role preview; production access requires authentication.' : 'Sign in to access your JPM account.')}>
          <div className="profile-avatar">{authIdentity?.username.slice(0, 2).toUpperCase() ?? (demoMode ? 'DM' : '—')}<span /></div>
          <div className="profile-copy"><strong>{authIdentity?.username ?? (demoMode ? 'Demo account' : 'Not signed in')}</strong><span>{authIdentity ? `${role} account` : demoMode ? `${role} role preview` : 'JPM attendance'}</span></div>
          <MoreHorizontal size={19} className="muted-icon" />
        </button>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <button className="mobile-menu-button icon-button" onClick={() => setMobileMenu(true)} aria-label="Open navigation"><Menu size={20} /></button>
          <div className="breadcrumb"><span>Workspace</span><ChevronRight size={14} /><strong>{activeNav}</strong></div>
          <div className="topbar-actions">
            <div className="global-search"><Search size={16} /><input value={search} placeholder="Search employees..." aria-label="Search employees" onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></div>
            <span className="topbar-divider" />
            <button className="icon-button notification-button" aria-label="Notifications" onClick={() => role === 'HR' ? setActiveNav('Alerts & notifications') : showNotice('Attendance alerts are managed by HR.')}><Bell size={18} />{role === 'HR' && visibleRecords.some((record) => record.status !== 'Present') && <i />}</button>
            {demoMode && !authHeader && <div className="role-select-wrap" title="Demo role preview; production access is enforced by the backend.">
              <ShieldCheck size={15} />
              <select aria-label="Preview user role" value={role} onChange={(event) => { setRole(event.target.value as Role); setPage(1); }}>
                <option>HR</option><option>MD</option><option>Employee</option>
              </select>
              <ChevronDown size={13} />
            </div>}
            <button className="auth-button" onClick={() => authHeader ? signOut() : setAuthOpen(true)} title={authHeader ? 'Sign out' : 'Sign in'}>
              {authHeader ? <><span className="auth-avatar">{authIdentity?.username.slice(0, 1).toUpperCase() ?? 'U'}</span><span className="auth-button-label">Sign out</span></> : <><KeyRound size={14} /><span className="auth-button-label">Sign in</span></>}
            </button>
          </div>
        </header>

        <div className="content-wrap">
          {!demoMode && !authIdentity ? <div className="workspace-empty access-required">          <div className="workspace-empty-icon"><KeyRound size={20} /></div><strong>Sign in to access JPM HRMS</strong><p>Production attendance data is only available to authenticated, role-authorized accounts.</p><button className="button-primary" onClick={() => setAuthOpen(true)}>Sign in securely</button><button className="button-secondary" onClick={() => { setActiveNav('Settings'); setAuthOpen(false); }}>View configuration guidance</button></div>
          : activeNav === 'Dashboard' ? <>
          <section className="hero" aria-label="Attendance overview">
            <div className="hero-copy">
              <div className="hero-chip">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}</div>
              <h1>Your team’s attendance, at a glance</h1>
              <p>Who came in, who is late and who needs attention — everything for {formatDate(selectedDate)} in one place.</p>
            </div>
            <ul className="hero-stats">
              <li><span>Present</span><strong>{present ?? '—'}</strong></li>
              <li><span>Absent</span><strong>{absent ?? '—'}</strong></li>
              <li><span>Late arrivals</span><strong>{late ?? '—'}</strong></li>
              <li><span>Early departures</span><strong>{early ?? '—'}</strong></li>
              <li><span>Missing punches</span><strong>{missingPunchCount ?? '—'}</strong></li>
            </ul>
            <div className="hero-bar">
              <div className="hero-field">
                <span>Date</span>
                <div className="date-nav">
                  <button aria-label="Previous day" onClick={() => moveDate(-1)}><ChevronLeft size={16} /></button>
                  <input type="date" value={selectedDate} onChange={(event) => setDate(event.target.value)} aria-label="Select attendance date" />
                  <button aria-label="Next day" onClick={() => moveDate(1)}><ChevronRight size={16} /></button>
                </div>
              </div>
              <div className="hero-field">
                <span>Data source</span>
                <div className={`data-mode ${usingDemoData || localImport || authHeader && !apiError ? '' : 'disconnected'}`}><span className="live-dot" />{usingDemoData ? 'Demo data' : localImport ? 'Imported file' : authHeader && !apiError ? 'Connected' : 'Not connected'}</div>
              </div>
              <div className="hero-bar-actions">
                {role === 'HR' && <button className="button-secondary" onClick={beginImport}><FileUp size={16} /> Import report</button>}
                <button className="button-primary" onClick={downloadCsv}><Download size={16} /> {role === 'Employee' ? 'Export my report' : 'Export report'}</button>
              </div>
            </div>
          </section>

          {localImport && !apiError ? <div className="demo-banner"><div className="demo-banner-icon"><FileSpreadsheet size={15} /></div><span><strong>Imported report</strong> &nbsp;Showing {localImport}. It is held in this browser only and clears on refresh.</span><button onClick={backToDemo}>Back to demo data <ArrowRight size={13} /></button></div> : (usingDemoData || !authHeader || apiError) && <div className={`demo-banner ${apiError ? 'demo-banner-error' : ''}`}><div className="demo-banner-icon"><CircleAlert size={15} /></div><span><strong>{apiError ? 'Attendance API unavailable' : usingDemoData ? 'Demo workspace' : 'No data source connected'}</strong> &nbsp;{apiError || (usingDemoData ? 'You’re viewing development sample records.' : 'No attendance records are loaded. Connect an authorized HRMS or eSSL source to view live attendance.')}</span>{!apiError && <button onClick={() => showNotice('No HRMS or eSSL connection is configured. Contact your administrator to set up an authorized integration.')}>Integration setup <ArrowRight size={13} /></button>}</div>}

          <section className="section-block" aria-label="Attendance overview">
            <div className="section-heading">
              <div><span className="section-chip">Today</span><h2>Daily summary</h2><p>Tap any card to see the employees behind the number.</p></div>
            </div>
            <div className="kpi-grid">
              <KpiCard icon={Users} label={role === 'Employee' ? 'My employee record' : 'Total employees'} value={total} foot={role === 'Employee' ? 'Personal attendance view' : 'In your workforce'} tone="green" onClick={() => setKpiDetail('total')} />
              <KpiCard icon={CircleCheck} label="Present today" value={present} foot={attendanceRate === null ? 'No imported report for this date' : `${attendanceRate}% of workforce`} tone="green" onClick={() => setKpiDetail('present')} />
              <KpiCard icon={CircleAlert} label="Absent today" value={absent} foot={absent === null ? 'Requires employee master, shift & imported date' : `${total ? Math.round((absent / total) * 100) : 0}% of workforce`} tone="rose" onClick={() => setKpiDetail('absent')} />
              <KpiCard icon={Clock3} label="Late arrivals" value={late} foot={late === null ? 'No imported report for this date' : 'After scheduled start'} tone="amber" onClick={() => setKpiDetail('late')} />
              <KpiCard icon={LogOut} label="Early departures" value={early} foot={early === null ? 'No imported report for this date' : 'Before scheduled end'} tone="blue" onClick={() => setKpiDetail('early')} />
              <KpiCard icon={Timer} label="Short hours" value={shortHoursCount} foot={shortHoursCount === null ? 'No imported report for this date' : 'Under 12h shift (except Office)'} tone="amber" onClick={() => setKpiDetail('short')} />
              <KpiCard icon={Fingerprint} label="Missing punches" value={missingPunchCount} foot={missingPunchCount === null ? 'No imported report for this date' : 'Incomplete or no-punch records'} tone="rose" onClick={() => setKpiDetail('missing')} />
              <KpiCard icon={Timer} label="Average working hours" value={averageHours} foot="From valid punch pairs" tone="blue" suffix="h" onClick={() => setKpiDetail('hours')} />
            </div>
          </section>

          <section className="analytics-section section-block">
            <div className="section-heading charts-heading">
              <div><span className="section-chip">Trends</span><h2>Attendance analytics</h2><p>How attendance is changing over days, months and departments.</p></div>
              <button className="text-button" onClick={() => { setActiveNav('Analytics'); showNotice('Analytics workspace selected.'); }}>View analytics <ArrowRight size={14} /></button>
            </div>
            <div className={`chart-grid chart-grid-${role.toLowerCase()}`}>
              <div className="panel trend-panel">
                <div className="panel-heading">
                  <div><h3>Last 7 days attendance trend</h3><p>{role === 'Employee' ? 'Daily presence from your records' : 'Daily presence across your workforce'}</p></div>
                </div>
                <div className="chart-legend"><span><i className="legend-dot green-dot" /> Attendance</span><span><i className="legend-dot mint-dot" /> On time</span></div>
                <div className="chart-area trend-chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={trendData} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
                      <CartesianGrid stroke="#edf1ee" vertical={false} />
                      <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: '#616d65', fontSize: 12 }} dy={10} />
                      <YAxis domain={[0, 100]} axisLine={false} tickLine={false} tick={{ fill: '#616d65', fontSize: 12 }} tickFormatter={(value: number) => `${value}%`} ticks={[0, 25, 50, 75, 100]} />
                      <Tooltip content={<ChartTooltip suffix="%" />} />
                      <Line type="monotone" dataKey="attendance" name="Attendance" stroke="#2f6b4f" strokeWidth={2.5} dot={{ r: 3, fill: '#2f6b4f', strokeWidth: 2, stroke: '#fff' }} activeDot={{ r: 5 }} />
                      <Line type="monotone" dataKey="onTime" name="On time" stroke="#a9cdb8" strokeWidth={2} strokeDasharray="4 5" dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
              {role !== 'Employee' && <div className="panel dept-panel">
                <div className="panel-heading">
                  <div><h3>Department attendance</h3><p>How many came in, out of each department’s employees · click a department to see who</p></div>
                  <div className="chart-legend dept-legend"><span><i className="legend-dot" style={{ background: '#3f8a66' }} /> 90%+</span><span><i className="legend-dot" style={{ background: '#d9a441' }} /> 75–89%</span><span><i className="legend-dot" style={{ background: '#c2553f' }} /> Below 75%</span></div>
                </div>
                <div className="department-chart" style={{ height: Math.max(120, departmentsToday.length * 30 + 10) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={departmentsToday.map((item) => ({ ...item, label: `${item.rate}%  ·  ${item.present}/${item.total}` }))} layout="vertical" margin={{ top: 2, right: 96, bottom: 0, left: 0 }} style={{ cursor: 'pointer' }} onClick={(state) => { if (state?.activeLabel) setDeptDetail(String(state.activeLabel)); }}>
                      <CartesianGrid stroke="#edf1ee" horizontal={false} />
                      <XAxis type="number" domain={[0, 100]} hide />
                      <YAxis type="category" dataKey="department" width={124} interval={0} axisLine={false} tickLine={false} tick={{ fill: '#3c4a42', fontSize: 12.5 }} />
                      <Tooltip content={<ChartTooltip suffix="%" />} />
                      <Bar dataKey="rate" name="Attendance" radius={[0, 6, 6, 0]} barSize={16} background={{ fill: '#f1f5f2', radius: 6 }} isAnimationActive={false}>
                        {departmentsToday.map((item) => <Cell key={item.department} fill={item.rate >= 90 ? '#3f8a66' : item.rate >= 75 ? '#d9a441' : '#c2553f'} />)}
                        <LabelList dataKey="label" position="right" style={{ fill: '#3c4a42', fontSize: 12, fontWeight: 600 }} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="chart-footnote">All {departmentsToday.length} departments <span className="footnote-divider" /> Based on {formatDate(selectedDate)}</div>
              </div>}
              <div className="panel mini-chart-panel">
                <div className="panel-heading">
                  <div><h3>Monthly attendance trend</h3><p>{role === 'Employee' ? 'Monthly presence from your records' : 'Monthly presence across your workforce'}</p></div>
                  <span className="mini-metric"><Activity size={13} /> 6 months</span>
                </div>
                <div className="chart-legend mini-legend"><span><i className="legend-dot green-dot" /> Attendance</span><span><i className="legend-dot mint-dot" /> On time</span></div>
                <div className="chart-area compact-chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={monthlyTrendData} margin={{ top: 8, right: 9, bottom: 0, left: -22 }}>
                      <CartesianGrid stroke="#edf1ee" vertical={false} />
                      <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: '#616d65', fontSize: 12 }} dy={7} />
                      <YAxis domain={[0, 100]} axisLine={false} tickLine={false} tick={{ fill: '#616d65', fontSize: 12 }} tickFormatter={(value: number) => `${value}%`} />
                      <Tooltip content={<ChartTooltip suffix="%" />} />
                      <Line type="monotone" dataKey="attendance" name="Attendance" stroke="#2f6b4f" strokeWidth={2.25} dot={{ r: 3, fill: '#2f6b4f', strokeWidth: 2, stroke: '#fff' }} activeDot={{ r: 5 }} />
                      <Line type="monotone" dataKey="onTime" name="On time" stroke="#a9cdb8" strokeWidth={2} strokeDasharray="4 5" dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="panel mini-chart-panel">
                <div className="panel-heading">
                  <div><h3>Late arrival analysis</h3><p>Employees arriving after shift start</p></div>
                  <span className="mini-metric"><Clock3 size={13} /> {late ?? '—'} today</span>
                </div>
                <div className="chart-legend mini-legend"><span><i className="legend-dot amber-dot" /> Late arrivals</span></div>
                <div className="chart-area compact-chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={lateByDay} margin={{ top: 8, right: 9, bottom: 0, left: -25 }}>
                      <CartesianGrid stroke="#edf1ee" vertical={false} />
                      <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: '#616d65', fontSize: 12 }} dy={7} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: '#616d65', fontSize: 12 }} allowDecimals={false} />
                      <Tooltip content={<ChartTooltip suffix=" employees" />} />
                      <Bar dataKey="late" name="Late arrivals" fill="#d9a441" radius={[4, 4, 0, 0]} barSize={22} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
              {role === 'HR' && <div className="panel mini-chart-panel">
                <div className="panel-heading">
                  <div><h3>Employee performance</h3><p>30-day attendance rate</p></div>
                  <button className="more-button" aria-label="Employee performance options" onClick={() => showNotice('Performance is calculated from available 30-day demo records.')}><MoreHorizontal size={19} /></button>
                </div>
                <div className="chart-legend mini-legend"><span><i className="legend-dot green-dot" /> Attendance rate</span></div>
                <div className="chart-area compact-chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={performanceData} margin={{ top: 8, right: 7, bottom: 0, left: -14 }} barCategoryGap={12}>
                      <CartesianGrid stroke="#edf1ee" vertical={false} />
                      <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#616d65', fontSize: 12 }} dy={7} />
                      <YAxis domain={[0, 100]} axisLine={false} tickLine={false} tick={{ fill: '#616d65', fontSize: 12 }} tickFormatter={(value: number) => `${value}%`} />
                      <Tooltip content={<ChartTooltip suffix="%" />} />
                      <ReferenceLine y={90} stroke="#c6d9cc" strokeDasharray="3 4" />
                      <Bar dataKey="rate" name="Attendance rate" fill="#3f8a66" radius={[4, 4, 0, 0]} barSize={20} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>}
            </div>
          </section>

          <section className="lower-grid section-block">
            {role !== 'MD' && <div className="panel movement-panel">
              <div className="panel-heading movement-heading">
                <div><h3>Daily movement</h3><p>Individual employee punch and attendance records</p></div>
                <button className="button-tertiary" onClick={downloadCsv}><Download size={14} /> Export</button>
              </div>
              <div className="table-toolbar">
                <label className="table-search"><Search size={15} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search name or employee ID" /></label>
                <label className="filter-select"><Filter size={14} /><select value={department} onChange={(event) => { setDepartment(event.target.value); setPage(1); }}><option>All departments</option>{departments.map((item) => <option key={item}>{item}</option>)}</select><ChevronDown size={13} /></label>
                <label className="filter-date"><CalendarDays size={14} /><input type="date" value={selectedDate} onChange={(event) => setDate(event.target.value)} aria-label="Filter by date" /></label>
              </div>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>EMPLOYEE</th><th>DEPARTMENT</th><th>DATE</th><th>FIRST IN</th><th>LAST OUT</th><th>PUNCH SEQUENCE</th><th>HOURS</th><th>LATE</th><th>EARLY GOING</th><th>STATUS</th></tr></thead>
                  <tbody>
                    {pageRecords.map((record) => <MovementRow key={record.employeeId} record={record} onClick={() => setSelectedEmployee(record.employeeId)} />)}
                    {pageRecords.length === 0 && <tr><td className="empty-table" colSpan={10}>No attendance records match these filters.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="table-footer">
                <span>Showing <strong>{filteredRecords.length ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, filteredRecords.length)}</strong> of <strong>{filteredRecords.length}</strong> records</span>
                <div className="pagination">
                  <button disabled={page <= 1} aria-label="Previous page" onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft size={15} /></button>
                  <span>Page <strong>{page}</strong> of <strong>{pageCount}</strong></span>
                  <button disabled={page >= pageCount} aria-label="Next page" onClick={() => setPage((current) => Math.min(pageCount, current + 1))}><ChevronRight size={15} /></button>
                </div>
              </div>
            </div>}
            <div className={`panel insights-panel ${role === 'MD' ? 'insights-management' : ''}`}>
              <div className="panel-heading insights-heading">
                <div className="insights-title"><div className="sparkle-icon"><Sparkles size={16} /></div><div><h3>Workforce insights</h3><p>Patterns in your attendance data</p></div></div>
              </div>
              <div className="insight-list">
                {insights.map(({ icon: Icon, color, title, value, body, empty }) => <div className={`insight-item ${empty ? 'insight-empty' : ''}`} key={title}>
                  <div className="insight-head"><div className={`insight-icon ${empty ? 'muted' : color}`}><Icon size={15} /></div><span className="insight-item-title">{title}</span></div>
                  <div className="insight-value" title={value}>{value}</div>
                  <p className="insight-body">{body}</p>
                </div>)}
              </div>
              <div className="insight-footer"><span><span className="insight-status-dot" /> {insightDate ? <>Based on the report for <strong>{insightDateLabel}</strong>{insightDate !== selectedDate ? ' (latest available)' : ''} · {attendanceRecords.length} {usingDemoData ? 'demo' : ''} records in total</> : 'No attendance report imported yet'}</span><button onClick={() => showNotice('Insights are generated from the currently available attendance data.')}>How it works <ArrowRight size={12} /></button></div>
            </div>
          </section>
          <footer className="page-footer"><span>© {new Date().getFullYear()} JPM HRMS · Junior Processing Mills</span><span><span className="secure-dot" /> Secure workforce workspace</span><button onClick={() => showNotice('Integration layer prepared for future authorized HRMS and eSSL connectivity.')}>Integration status <span className="footer-demo">{demoMode ? 'Demo mode' : 'Not connected'}</span></button></footer>
          </> : <WorkspaceView
            view={activeNav}
            role={role}
            selectedDate={selectedDate}
            search={search}
            records={visibleRecords}
            employees={employees}
            allRecords={attendanceRecords}
            departmentAnalytics={departmentAnalytics}
            apiAlerts={apiAlerts}
            liveData={Boolean(authHeader)}
            importHistory={importHistory}
            onDateChange={setDate}
            onSearchChange={(value) => { setSearch(value); setPage(1); }}
            onExport={downloadCsv}
            onExportExcel={() => downloadExcel(filteredRecords, `jpm-attendance-${selectedDate}.xlsx`)}
            onExportPdf={(records) => { void exportPdf(records, `Attendance for ${formatDate(selectedDate)}`); }}
            onImport={beginImport}
            onRegisterEmployee={() => { setEmployeeError(''); setRegisterOpen(true); }}
            onImportEmployees={importEmployeeFile}
            onEmployeeClick={setSelectedEmployee}
            onCreateShift={saveShift}
            shiftForm={{ name: shiftName, start: shiftStart, end: shiftEnd, grace: shiftGrace, earlyGrace: shiftEarlyGrace }}
            onShiftFormChange={(field, value) => {
              if (field === 'name') setShiftName(value);
              if (field === 'start') setShiftStart(value);
              if (field === 'end') setShiftEnd(value);
              if (field === 'grace') setShiftGrace(value);
              if (field === 'earlyGrace') setShiftEarlyGrace(value);
            }}
            shiftError={shiftError}
            shiftSuccess={shiftSuccess}
            employeeImportResult={employeeImportResult}
            onNotice={showNotice}
          />}
        </div>
      </main>

      {notice && <div className="toast-message" role="status"><Check size={16} />{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notification"><X size={14} /></button></div>}
      {importOpen && <div className="modal-backdrop" onClick={() => setImportOpen(false)}>
        <div className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title" onClick={(event) => event.stopPropagation()}>
          <div className="modal-top"><div className="modal-icon"><FileUp size={19} /></div><button className="icon-button" onClick={() => setImportOpen(false)} aria-label="Close import dialog"><X size={18} /></button></div>
          <h2 id="import-title">Import attendance report</h2>
          <p className="modal-description">Upload the eSSL movement report for validation. Review the parsed records before saving them.</p>
          <label className="upload-zone">
            <input type="file" accept=".xlsx,.xls,.pdf" onChange={(event) => { void previewReport(event.target.files?.[0]); }} />
            <div className="upload-icon"><FileUp size={21} /></div>
            <strong>{stagedFile || 'Choose a report to get started'}</strong>
            <span>{demoMode && !authHeader ? 'Excel (.xlsx or .xls) eSSL movement report' : 'Excel or text-based PDF · maximum size enforced by the API'}</span>
            <span className="upload-link">{stagedFile ? 'Choose a different file' : 'Browse files'}</span>
          </label>
          {demoMode && !authHeader && <p className="form-hint">Browser mode: the Excel file is read on this device and nothing is uploaded or saved.</p>}
          {importLoading && <p className="form-hint">Uploading and validating report… If the server was idle it can take up to a minute to wake up — please keep this window open.</p>}
          {importError && <p className="form-error" role="alert">{importError}</p>}
          {importResult && <p className="form-success" role="status">{importResult}</p>}
          {importPreview && <div className="import-preview">
            <div className="import-preview-stats"><span>{importPreview.validRows} valid</span><span>{importPreview.rejectedRows} rejected</span><span>{importPreview.duplicateRows} duplicates</span></div>
            <p className="form-hint">Report dates: {importPreview.reportDates.length ? importPreview.reportDates.map(formatDate).join(', ') : 'None detected'}</p>
            {importPreview.messages.map((message) => <p className="form-hint" key={message}>{message}</p>)}
            <div className="import-preview-table"><table><thead><tr><th>ROW</th><th>EMPLOYEE</th><th>DATE</th><th>PUNCHES</th><th>HOURS</th><th>VALIDATION</th></tr></thead><tbody>
              {importPreview.rows.slice(0, 100).map((row) => <tr key={row.sourceRow}><td>{row.sourceRow}</td><td>{row.employeeId}<small>{row.employeeName}</small></td><td>{row.date ?? '—'}</td><td>{row.punches.map((punch) => punch.rawValue).join(' → ') || '—'}</td><td>{(row.workedMinutes / 60).toFixed(2)}</td><td><span className={`import-validation ${row.validationStatus.toLowerCase()}`}>{row.validationStatus}</span>{row.messages.length > 0 && <small>{row.messages.join(' ')}</small>}</td></tr>)}
            </tbody></table></div>
          </div>}
          <div className="import-notice"><ShieldCheck size={16} /><span><strong>Validated import</strong><br />Employee IDs, dates, duplicate records and punch direction are checked before data is committed. The source file is retained for audit.</span></div>
          <div className="modal-actions"><button className="button-secondary" onClick={() => setImportOpen(false)}>Close</button><button className="button-primary" disabled={importLoading || !importPreview || importPreview.validRows === 0 || importPreview.status === 'COMMITTED'} onClick={() => void commitReport()}>{importPreview?.status === 'COMMITTED' ? 'Loaded' : importPreview?.importId === 'local' ? 'Load valid records' : 'Commit valid records'}</button></div>
        </div>
      </div>}
      {authOpen && <div className="modal-backdrop" onClick={() => setAuthOpen(false)}>
        <form className="import-modal auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title" onSubmit={signIn} onClick={(event) => event.stopPropagation()}>
          <div className="modal-top"><div className="modal-icon"><KeyRound size={19} /></div><button className="icon-button" type="button" onClick={() => setAuthOpen(false)} aria-label="Close sign in"><X size={18} /></button></div>
          <h2 id="auth-title">Sign in to JPM HRMS</h2><p className="modal-description">Use your authorized JPM attendance account. Credentials are sent only to the configured backend.</p>
          <label className="form-field">Username<input name="username" autoComplete="username" required /></label>
          <label className="form-field">Password<input name="password" type="password" autoComplete="current-password" required /></label>
          {authError && <p className="form-error" role="alert">{authError}</p>}
          {demoMode && <div className="demo-login-option"><p>Just exploring? Continue without a password using sample data only. This does not access real company records.</p><button className="button-secondary" type="button" onClick={continueInDemoMode}>Continue in demo mode</button></div>}
          <div className="modal-actions"><button className="button-secondary" type="button" onClick={() => setAuthOpen(false)}>Cancel</button><button className="button-primary" type="submit">Sign in</button></div>
        </form>
      </div>}
      {registerOpen && <div className="modal-backdrop" onClick={() => setRegisterOpen(false)}>
        <form className="import-modal employee-modal" role="dialog" aria-modal="true" aria-labelledby="employee-title" onSubmit={saveEmployee} onClick={(event) => event.stopPropagation()}>
          <div className="modal-top"><div className="modal-icon"><UserPlus size={19} /></div><button className="icon-button" type="button" onClick={() => setRegisterOpen(false)} aria-label="Close employee form"><X size={18} /></button></div>
          <h2 id="employee-title">Register employee</h2><p className="modal-description">Add a master record to validate attendance imports and calculate workforce totals.</p>
          <div className="employee-form-grid">
            <label className="form-field">Employee ID<input required maxLength={80} value={employeeForm.employeeId} onChange={(event) => setEmployeeForm({ ...employeeForm, employeeId: event.target.value })} /></label>
            <label className="form-field">Employee name<input required maxLength={160} value={employeeForm.employeeName} onChange={(event) => setEmployeeForm({ ...employeeForm, employeeName: event.target.value })} /></label>
            <label className="form-field">Department<input maxLength={120} value={employeeForm.department} onChange={(event) => setEmployeeForm({ ...employeeForm, department: event.target.value })} /></label>
            <label className="form-field">Designation<input maxLength={120} value={employeeForm.designation} onChange={(event) => setEmployeeForm({ ...employeeForm, designation: event.target.value })} /></label>
            <label className="form-field">Shift name<input maxLength={120} value={employeeForm.shift} onChange={(event) => setEmployeeForm({ ...employeeForm, shift: event.target.value })} /></label>
            <label className="form-field">Joining date<input type="date" value={employeeForm.joiningDate} onChange={(event) => setEmployeeForm({ ...employeeForm, joiningDate: event.target.value })} /></label>
            <label className="form-field">Employment status<select value={employeeForm.employmentStatus} onChange={(event) => setEmployeeForm({ ...employeeForm, employmentStatus: event.target.value })}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></label>
          </div>
          {employeeError && <p className="form-error" role="alert">{employeeError}</p>}
          <div className="modal-actions"><button className="button-secondary" type="button" onClick={() => setRegisterOpen(false)}>Cancel</button><button className="button-primary" type="submit" disabled={employeeBusy}>{employeeBusy ? 'Saving…' : 'Save employee'}</button></div>
        </form>
      </div>}
      {kpiView && <div className="modal-backdrop" onClick={() => setKpiDetail(null)}>
        <section className="import-modal kpi-modal" role="dialog" aria-modal="true" aria-labelledby="kpi-title" onClick={(event) => event.stopPropagation()}>
          <div className="modal-top"><div><h2 id="kpi-title">{kpiView.title} · {kpiRecords.length}</h2><p className="modal-description">{kpiView.note} · {formatDate(selectedDate)}</p></div><button className="icon-button" onClick={() => setKpiDetail(null)} aria-label="Close details"><X size={18} /></button></div>
          <div className="table-scroll kpi-table"><table><thead><tr><th>EMPLOYEE</th><th>DEPARTMENT</th><th>DATE</th><th>FIRST IN</th><th>LAST OUT</th><th>PUNCH SEQUENCE</th><th>HOURS</th><th>LATE</th><th>EARLY GOING</th><th>STATUS</th></tr></thead><tbody>
            {kpiRecords.map((record) => <MovementRow key={record.employeeId} record={record} onClick={() => { setKpiDetail(null); setSelectedEmployee(record.employeeId); }} />)}
            {!kpiRecords.length && <tr><td className="empty-table" colSpan={10}>No employees in this group for the selected date.</td></tr>}
          </tbody></table></div>
          {kpiDetail === 'total' && employees.length > kpiRecords.length && <p className="form-hint">{employees.length - kpiRecords.length} more employees are in the employee master but have no record on this date.</p>}
          <div className="modal-actions"><button className="button-secondary" onClick={() => setKpiDetail(null)}>Close</button></div>
        </section>
      </div>}
      {deptDetail && (() => {
        const team = employees.filter((employee) => employee.department === deptDetail);
        const dayRecords = new Map(getRecordsForDate(selectedDate).map((record) => [record.employeeId, record]));
        const rows = team.map((employee) => ({ employee, record: dayRecords.get(employee.id) }));
        const came = rows.filter(({ record }) => record && record.status !== 'Absent' && record.status !== 'No punching')
          .sort((a, b) => (a.record!.firstIn || '99').localeCompare(b.record!.firstIn || '99'));
        const absentRows = rows.filter(({ record }) => !record || record.status === 'Absent' || record.status === 'No punching')
          .sort((a, b) => a.employee.name.localeCompare(b.employee.name));
        const lateCount = came.filter(({ record }) => record!.lateMinutes > 0).length;
        const openEmployee = (id: string) => { setDeptDetail(null); setSelectedEmployee(id); };
        return <div className="modal-backdrop" onClick={() => setDeptDetail(null)}>
          <section className="import-modal dept-modal" role="dialog" aria-modal="true" aria-labelledby="dept-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-top"><div><h2 id="dept-title">{deptDetail}</h2><p className="modal-description">Attendance on {formatDate(selectedDate)} · {team.length} employees</p></div><button className="icon-button" onClick={() => setDeptDetail(null)} aria-label="Close department details"><X size={18} /></button></div>
            <div className="dept-stats">
              <span className="dept-stat present"><strong>{came.length}</strong> Present</span>
              <span className="dept-stat absent"><strong>{absentRows.length}</strong> Absent</span>
              <span className="dept-stat late"><strong>{lateCount}</strong> Late</span>
            </div>
            <div className="dept-columns">
              <div className="dept-column">
                <h3 className="dept-column-title absent"><CircleAlert size={15} /> Absent ({absentRows.length})</h3>
                {absentRows.length ? <ul className="dept-list">{absentRows.map(({ employee }) => <li key={employee.id}>
                  <button onClick={() => openEmployee(employee.id)}><span className="dept-person"><strong>{employee.name}</strong><small>ID {employee.id}</small></span><span className="status-pill absent"><i />Absent</span></button>
                </li>)}</ul> : <p className="dept-empty">Everyone came in. 🎉</p>}
              </div>
              <div className="dept-column">
                <h3 className="dept-column-title present"><CircleCheck size={15} /> Present ({came.length})</h3>
                {came.length ? <ul className="dept-list">{came.map(({ employee, record }) => <li key={employee.id}>
                  <button onClick={() => openEmployee(employee.id)}>
                    <span className="dept-person"><strong>{employee.name}</strong><small>ID {employee.id} · In {record!.firstIn || '—'} · Out {record!.lastOut || '—'} · {record!.hours}h</small></span>
                    {record!.status === 'Missing punch' ? <span className="status-pill missing"><i />Missing punch</span>
                      : record!.lateMinutes > 0 ? <span className="status-pill late"><i />{record!.lateMinutes}m late</span>
                      : (record!.shortMinutes ?? 0) > 0 ? <span className="status-pill short"><i />{formatMinutes(record!.shortMinutes!)} short</span>
                      : <span className="status-pill present"><i />On time</span>}
                  </button>
                </li>)}</ul> : <p className="dept-empty">Nobody from this department came in.</p>}
              </div>
            </div>
            <p className="form-hint">Tap a name to see that employee’s last 30 days.</p>
            <div className="modal-actions"><button className="button-secondary" onClick={() => setDeptDetail(null)}>Close</button></div>
          </section>
        </div>;
      })()}
      {selectedEmployee && <EmployeeTimeline employee={employees.find((employee) => employee.id === selectedEmployee)} records={attendanceRecords.filter((record) => record.employeeId === selectedEmployee).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30)} onClose={() => setSelectedEmployee(null)} />}
    </div>
  );
}

function WorkspaceView({
  view, role, selectedDate, search, records, employees, allRecords, departmentAnalytics, apiAlerts, importHistory, liveData,
  onDateChange, onSearchChange, onExport, onExportExcel, onExportPdf, onImport,
  onRegisterEmployee, onImportEmployees, onEmployeeClick, onCreateShift, shiftForm, onShiftFormChange,
  shiftError, shiftSuccess, employeeImportResult, onNotice,
}: {
  view: string;
  role: Role;
  selectedDate: string;
  search: string;
  records: AttendanceRecord[];
  employees: Employee[];
  allRecords: AttendanceRecord[];
  departmentAnalytics: ApiDepartmentAnalytics[];
  apiAlerts: ApiAlert[];
  importHistory: ImportHistoryItem[];
  liveData: boolean;
  onDateChange: (date: string) => void;
  onSearchChange: (value: string) => void;
  onExport: (records?: AttendanceRecord[]) => void;
  onExportExcel: (records: AttendanceRecord[]) => void;
  onExportPdf: (records: AttendanceRecord[]) => void;
  onImport: () => void;
  onRegisterEmployee: () => void;
  onImportEmployees: (file?: File) => void;
  onEmployeeClick: (employeeId: string | null) => void;
  onCreateShift: (event: FormEvent<HTMLFormElement>) => void;
  shiftForm: { name: string; start: string; end: string; grace: string; earlyGrace: string };
  onShiftFormChange: (field: 'name' | 'start' | 'end' | 'grace' | 'earlyGrace', value: string) => void;
  shiftError: string;
  shiftSuccess: string;
  employeeImportResult: string;
  onNotice: (message: string) => void;
}) {
  const [departmentFilter, setDepartmentFilter] = useState('All departments');
  const [statusFilter, setStatusFilter] = useState('All statuses');
  const [tablePage, setTablePage] = useState(1);
  const [historyEmployee, setHistoryEmployee] = useState(employees[0]?.id ?? '');
  const workspacePageSize = 10;
  const query = search.trim().toLowerCase();
  const departmentOptions = [...new Set(employees.map((employee) => employee.department))].sort();
  const filteredEmployees = employees.filter((employee) =>
    [employee.name, employee.id, employee.department, employee.title].some((value) => value.toLowerCase().includes(query)),
  );
  const filteredRecords = records.filter((record) => {
    const employee = getEmployee(record.employeeId);
    const matchesText = employee && [employee.name, employee.id, employee.department].some((value) => value.toLowerCase().includes(query));
    const matchesDepartment = departmentFilter === 'All departments' || employee?.department === departmentFilter;
    const matchesStatus = statusFilter === 'All statuses' || record.status.toLowerCase() === statusFilter.toLowerCase();
    return matchesText && matchesDepartment && matchesStatus;
  });
  const tablePages = Math.max(1, Math.ceil(filteredRecords.length / workspacePageSize));
  const pageRecords = filteredRecords.slice((tablePage - 1) * workspacePageSize, tablePage * workspacePageSize);
  const lateRecords = records.filter((record) => record.status === 'Late' || record.lateMinutes > 0);
  const absentRecords = records.filter((record) => record.status === 'Absent');
  const missingRecords = records.filter((record) => record.status === 'Missing punch' || record.status === 'No punching' || (record.status !== 'Absent' && (!record.firstIn || !record.lastOut)));
  const earlyRecords = records.filter((record) => record.earlyMinutes > 0);
  const alertItems = (liveData && Array.isArray(apiAlerts)) ? apiAlerts.filter((item) => item && [item.employeeName, item.employeeId, item.type].some((value) => (value || '').toLowerCase().includes(query))).map((item) => ({
    employeeId: item.employeeId || '',
    employeeName: item.employeeName || item.employeeId || '',
    department: item.department || '',
    label: (item.type || 'Alert').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (letter: string) => letter.toUpperCase()),
    detail: item.message || '',
    date: item.date || selectedDate,
    tone: item.severity === 'HIGH' ? 'rose' : item.severity === 'MEDIUM' ? 'amber' : 'blue',
    icon: (item.type || '').includes('PUNCH') ? Fingerprint : (item.type || '').includes('LATE') ? Clock3 : (item.type || '').includes('EARLY') ? LogOut : CircleAlert,
  })) : [
    ...missingRecords.map((record) => ({ employeeId: record.employeeId, employeeName: getEmployee(record.employeeId)?.name ?? record.employeeId, department: getEmployee(record.employeeId)?.department ?? '', date: record.date, label: record.status === 'No punching' ? 'No punch record' : 'Missing punch', detail: record.status === 'No punching' ? 'No punch values were supplied; verify the shift and attendance before marking absent.' : 'Punch in or punch out is unavailable.', tone: 'rose', icon: Fingerprint })),
    ...absentRecords.map((record) => ({ employeeId: record.employeeId, employeeName: getEmployee(record.employeeId)?.name ?? record.employeeId, department: getEmployee(record.employeeId)?.department ?? '', date: record.date, label: 'Absent', detail: 'No attendance was recorded for this employee.', tone: 'rose', icon: CircleAlert })),
    ...lateRecords.map((record) => ({ employeeId: record.employeeId, employeeName: getEmployee(record.employeeId)?.name ?? record.employeeId, department: getEmployee(record.employeeId)?.department ?? '', date: record.date, label: 'Late arrival', detail: `${record.lateMinutes} minutes after the scheduled start recorded in the source data.`, tone: 'amber', icon: Clock3 })),
    ...earlyRecords.map((record) => ({ employeeId: record.employeeId, employeeName: getEmployee(record.employeeId)?.name ?? record.employeeId, department: getEmployee(record.employeeId)?.department ?? '', date: record.date, label: 'Early departure', detail: `${record.earlyMinutes} minutes before scheduled end recorded in the source data.`, tone: 'blue', icon: LogOut })),
  ].filter((item) => [item.employeeName, item.employeeId, item.label].some((value) => value.toLowerCase().includes(query)));
  const trend = getTrendData(7, role === 'Employee' ? employees[0]?.id : undefined);
  const weekly = getWeeklyTrendData(12, role === 'Employee' ? employees[0]?.id : undefined);
  const monthlyTrend = getMonthlyTrendData(6, role === 'Employee' ? employees[0]?.id : undefined);
  const departments = departmentData(selectedDate);
  const departmentRows = Array.isArray(departmentAnalytics) && departmentAnalytics.length ? departmentAnalytics.map((item) => ({
    department: item.department,
    employeeCount: item.employeeCount,
    presentCount: item.presentCount,
    absentCount: item.absentCount,
    lateArrivals: item.lateArrivals,
    earlyDepartures: item.earlyDepartures,
    averageWorkingHours: item.averageWorkingHours,
    rate: item.employeeCount ? Math.round((item.presentCount / item.employeeCount) * 100) : 0,
  })) : departments.map((item) => ({
    department: item.department,
    employeeCount: item.total,
    presentCount: item.present,
    absentCount: null as number | null,
    lateArrivals: 0,
    earlyDepartures: 0,
    averageWorkingHours: 0,
    rate: item.rate,
  }));
  const employeeWorkHours = employees.slice(0, 8).map((employee) => {
    const employeeRows = allRecords.filter((record) => record.employeeId === employee.id && record.date >= `${new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10)}`);
    return employeeRows.length
      ? { name: employee.name.split(' ')[0], hours: Number((employeeRows.reduce((total, record) => total + record.hours, 0) / employeeRows.length).toFixed(1)) }
      : null;
  }).filter((item): item is { name: string; hours: number } => item !== null);
  const employeeHistoryChart = allRecords.filter((record) => record.employeeId === historyEmployee)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30)
    .map((record) => ({ date: new Date(`${record.date}T00:00:00`).toLocaleDateString('en', { day: 'numeric', month: 'short' }), hours: record.hours, late: record.lateMinutes }));
  const sectionName = view === 'Leave management' ? 'Leave management' : view;
  const sectionDescription: Record<string, string> = {
    Attendance: role === 'Employee' ? 'Review your punch history and working hours.' : `Review employee movement for ${formatDate(selectedDate)}.`,
    Employees: 'Browse the employee directory and department assignments.',
    'Leave management': 'Leave requests will appear here when an authorized leave data source is connected.',
    Reports: 'Review attendance summaries and export records for the selected date.',
    'Shift & schedule': 'Configure work times and grace periods used for attendance exceptions.',
    'Alerts & notifications': `Attendance exceptions identified from records for ${formatDate(selectedDate)}.`,
    Analytics: 'Explore attendance performance from the available records.',
    Settings: 'Workspace connection and access configuration.',
  };
  const showEmpty = (title: string, detail: string) => (
    <div className="workspace-empty">
      <div className="workspace-empty-icon"><CircleAlert size={20} /></div>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );

  return <>
    <div className="workspace-page-heading">
      <div>
        <div className="eyebrow">{role} view</div>
        <h1>{sectionName}</h1>
        <p className="page-subtitle">{sectionDescription[view]}</p>
      </div>
      <div className="heading-actions">
        <div className={`data-mode ${liveData || demoMode ? '' : 'disconnected'}`}><span className="live-dot" />{liveData ? 'Connected' : demoMode ? 'Demo data' : 'Not connected'}</div>
        {view === 'Employees' && role === 'HR' && <><label className="button-secondary employee-import-button"><FileUp size={14} /> Import Excel<input type="file" accept=".xls,.xlsx" onChange={(event) => onImportEmployees(event.target.files?.[0])} /></label><button className="button-primary" onClick={onRegisterEmployee}><UserPlus size={15} /> Add employee</button></>}
        {view === 'Attendance' && role === 'HR' && <button className="button-secondary" onClick={onImport}><FileUp size={15} /> Import report</button>}
      </div>
    </div>
    {!['Settings', 'Leave management', 'Shift & schedule'].includes(view) && <div className="workspace-date-toolbar">
      <div className="date-nav"><CalendarDays size={15} /><input type="date" value={selectedDate} aria-label="Workspace attendance date" onChange={(event) => onDateChange(event.target.value)} /></div>
      {['Attendance', 'Employees', 'Alerts & notifications'].includes(view) && <label className="table-search workspace-search"><Search size={15} /><input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder={view === 'Employees' ? 'Search employee directory' : 'Search attendance records'} /></label>}
      {view === 'Attendance' && <label className="filter-select"><Filter size={14} /><select value={departmentFilter} onChange={(event) => { setDepartmentFilter(event.target.value); setTablePage(1); }}><option>All departments</option>{departmentOptions.map((item) => <option key={item}>{item}</option>)}</select><ChevronDown size={13} /></label>}
      {view === 'Attendance' && <label className="filter-select status-filter"><SlidersHorizontal size={14} /><select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setTablePage(1); }}><option>All statuses</option>{['Present', 'Late', 'Absent', 'On duty', 'Early out', 'Short hours', 'Missing punch', 'No punching'].map((status) => <option key={status}>{status}</option>)}</select><ChevronDown size={13} /></label>}
      <span className="workspace-date-label">{view === 'Employees' ? `${filteredEmployees.length} employees` : `${records.length} records · ${formatDate(selectedDate)}`}</span>
    </div>}

    {view === 'Attendance' && <section className="panel workspace-panel">
      <div className="workspace-panel-heading"><div><h2>Attendance movement</h2><p>First punch, last punch and attendance exceptions</p></div><span className="workspace-count">{filteredRecords.length} records</span></div>
      <div className="table-scroll"><table><thead><tr><th>EMPLOYEE</th><th>DEPARTMENT</th><th>DATE</th><th>FIRST IN</th><th>LAST OUT</th><th>PUNCH SEQUENCE</th><th>HOURS</th><th>LATE</th><th>EARLY GOING</th><th>STATUS</th></tr></thead><tbody>
        {pageRecords.map((record) => <MovementRow key={record.employeeId} record={record} onClick={() => onEmployeeClick(record.employeeId)} />)}
        {!filteredRecords.length && <tr><td className="empty-table" colSpan={10}>No attendance records match this date and search.</td></tr>}
      </tbody></table></div>
      <div className="table-footer"><span>Showing <strong>{filteredRecords.length ? (tablePage - 1) * workspacePageSize + 1 : 0}–{Math.min(tablePage * workspacePageSize, filteredRecords.length)}</strong> of <strong>{filteredRecords.length}</strong></span><div className="pagination"><button aria-label="Previous attendance page" disabled={tablePage <= 1} onClick={() => setTablePage((value) => Math.max(1, value - 1))}><ChevronLeft size={15} /></button><span>Page <strong>{tablePage}</strong> of <strong>{tablePages}</strong></span><button aria-label="Next attendance page" disabled={tablePage >= tablePages} onClick={() => setTablePage((value) => Math.min(tablePages, value + 1))}><ChevronRight size={15} /></button></div></div>
    </section>}

    {view === 'Employees' && <section className="panel workspace-panel">
      <div className="workspace-panel-heading"><div><h2>Employee directory</h2><p>Employee master, department and shift assignments</p></div><span className="workspace-count">{filteredEmployees.length} employees</span></div>
      {employeeImportResult && <div className="inline-result">{employeeImportResult}</div>}
      <div className="employee-directory">
        {filteredEmployees.map((employee) => {
          const record = records.find((item) => item.employeeId === employee.id);
          return <button className="directory-card directory-button" key={employee.id} onClick={() => onEmployeeClick(employee.id)}>
            <div className={`employee-avatar ${employee.color}`}>{employee.initials}</div>
            <div className="directory-main"><strong>{employee.name}</strong><span>{employee.title}</span><small>{employee.id} · {employee.employmentStatus ?? 'ACTIVE'}</small></div>
            <span className="directory-department">{employee.department}</span>
            <span className="directory-shift">{employee.shift || 'No shift'}</span>
            {record ? <span className={`status-pill ${statusClass[record.status]}`}><i />{record.status}</span> : <span className="directory-no-record">No record</span>}
          </button>;
        })}
        {!filteredEmployees.length && showEmpty('No employees found', 'Try another name, employee ID or department.')}
      </div>
    </section>}

    {view === 'Leave management' && <section className="panel workspace-panel">
      <div className="workspace-panel-heading"><div><h2>Leave requests</h2><p>Leave records are separate from attendance data.</p></div><span className="workspace-count">No leave source</span></div>
      {showEmpty('No leave records available', 'Connect an authorized HRMS leave service to view balances, requests and approvals. No leave statistics are being assumed or generated.')}
    </section>}

    {view === 'Shift & schedule' && <div className="shift-layout">
      <section className="panel workspace-panel"><div className="workspace-panel-heading"><div><h2>Configure a shift</h2><p>Shift schedules provide the basis for late and early departure checks.</p></div><span className="workspace-count">HR access</span></div>
        <form className="shift-form" onSubmit={onCreateShift}>
          <label>Shift name<input required maxLength={120} value={shiftForm.name} onChange={(event) => onShiftFormChange('name', event.target.value)} placeholder="e.g. General shift" /></label>
          <div className="shift-time-fields">
            <label>Start time<input required type="time" value={shiftForm.start} onChange={(event) => onShiftFormChange('start', event.target.value)} /></label>
            <label>End time<input required type="time" value={shiftForm.end} onChange={(event) => onShiftFormChange('end', event.target.value)} /></label>
          </div>
          <div className="shift-time-fields">
            <label>Late grace (minutes)<input required type="number" min="0" max="240" value={shiftForm.grace} onChange={(event) => onShiftFormChange('grace', event.target.value)} /></label>
            <label>Early grace (minutes)<input required type="number" min="0" max="240" value={shiftForm.earlyGrace} onChange={(event) => onShiftFormChange('earlyGrace', event.target.value)} /></label>
          </div>
          <div className="weekday-note">Default work days: Monday–Saturday. Configure holidays and exceptions in the authorized schedule source.</div>
          {shiftError && <p className="form-error">{shiftError}</p>}{shiftSuccess && <p className="form-success">{shiftSuccess}</p>}
          <button className="button-primary" type="submit"><CalendarClock size={15} /> Save shift</button>
        </form>
      </section>
      <section className="panel workspace-panel"><div className="workspace-panel-heading"><div><h2>Employee shift assignments</h2><p>Assignments from the employee master</p></div><span className="workspace-count">{employees.filter((employee) => employee.shift).length} assigned</span></div>
        <div className="table-scroll"><table><thead><tr><th>EMPLOYEE</th><th>DEPARTMENT</th><th>SHIFT</th><th>STATUS</th></tr></thead><tbody>
          {employees.map((employee) => <tr key={employee.id}><td><button className="table-employee-link" onClick={() => onEmployeeClick(employee.id)}>{employee.name}<small>{employee.id}</small></button></td><td>{employee.department}</td><td>{employee.shift || 'Not assigned'}</td><td>{employee.employmentStatus || 'ACTIVE'}</td></tr>)}
          {!employees.length && <tr><td className="empty-table" colSpan={4}>No employee master records available.</td></tr>}
        </tbody></table></div>
      </section>
    </div>}

    {view === 'Reports' && <>
      <div className="workspace-stats">
        <KpiCard icon={Users} label="Employees in scope" value={employees.length} foot="Employee master records" tone="green" />
        <KpiCard icon={CircleCheck} label="Present" value={records.filter((record) => record.status !== 'Absent' && record.status !== 'No punching').length} foot="Includes on-duty records" tone="green" />
        <KpiCard icon={CircleAlert} label="Absent" value={Array.isArray(departmentAnalytics) && departmentAnalytics.length && departmentAnalytics.every((item) => item?.absentCount !== null && item?.absentCount !== undefined) ? departmentAnalytics.reduce((sum, item) => sum + (item?.absentCount ?? 0), 0) : null} foot="Requires schedule and imported date" tone="rose" />
        <KpiCard icon={Clock3} label="Late arrivals" value={lateRecords.length} foot="Flagged in attendance data" tone="amber" />
      </div>
      <section className="panel workspace-panel">
        <div className="workspace-panel-heading"><div><h2>Daily attendance report</h2><p>Source records for the selected date</p></div><div className="heading-actions"><button className="button-secondary" onClick={() => onExportExcel(records)}><FileSpreadsheet size={14} /> Excel</button><button className="button-secondary" onClick={() => onExportPdf(records)}><Download size={14} /> PDF</button><button className="button-tertiary" onClick={() => onExport(records)}>CSV</button></div></div>
        <div className="table-scroll"><table><thead><tr><th>EMPLOYEE</th><th>DEPARTMENT</th><th>DATE</th><th>FIRST IN</th><th>LAST OUT</th><th>PUNCH SEQUENCE</th><th>HOURS</th><th>LATE</th><th>EARLY GOING</th><th>STATUS</th></tr></thead><tbody>
          {records.map((record) => <MovementRow key={record.employeeId} record={record} onClick={() => onEmployeeClick(record.employeeId)} />)}
          {!records.length && <tr><td className="empty-table" colSpan={10}>No records available for this date.</td></tr>}
        </tbody></table></div>
      </section>
      <section className="panel workspace-panel import-history-panel">
        <div className="workspace-panel-heading"><div><h2>Import history</h2><p>Source file, result and validation totals</p></div><span className="workspace-count">{importHistory.length} imports</span></div>
        <div className="table-scroll"><table><thead><tr><th>FILE</th><th>TYPE</th><th>IMPORTED BY</th><th>DATE</th><th>VALID</th><th>REJECTED</th><th>DUPLICATES</th><th>STATUS</th></tr></thead><tbody>
          {importHistory.map((item) => <tr key={item.id}><td>{item.filename}</td><td>{item.fileType}</td><td>{item.uploadedBy}</td><td>{item.createdAt ? new Date(item.createdAt).toLocaleString() : '—'}</td><td>{item.validRows}</td><td>{item.rejectedRows}</td><td>{item.duplicateRows}</td><td><span className={`status-pill ${item.status === 'COMMITTED' ? 'present' : item.status === 'PARTIAL' ? 'late' : 'absent'}`}><i />{item.status}</span></td></tr>)}
          {!importHistory.length && <tr><td className="empty-table" colSpan={8}>No report imports have been recorded.</td></tr>}
        </tbody></table></div>
      </section>
    </>}

    {view === 'Alerts & notifications' && <section className="panel workspace-panel">
      <div className="workspace-panel-heading"><div><h2>Attendance alerts</h2><p>Exceptions derived from the selected date's attendance records and configured shifts</p></div><span className="workspace-count">{alertItems.length} findings</span></div>
      <div className="alert-list">
        {alertItems.map(({ employeeId, employeeName, department: employeeDepartment, date, label, detail, tone, icon: Icon }) => {
          return <article className="alert-row" key={`${employeeId}-${label}-${date}`}><div className={`alert-icon ${tone}`}><Icon size={16} /></div><div className="alert-copy"><strong>{label} · {employeeName}</strong><span>{employeeId} · {employeeDepartment} · {detail}</span></div><span className="alert-date">{formatDate(date)}</span></article>;
        })}
        {!alertItems.length && showEmpty('No matching alerts', query ? 'Try another employee name or alert type.' : 'No late arrival, absence, missing punch or early departure flags were found for this date.')}
      </div>
      <div className="alert-note"><CircleAlert size={14} /> {liveData ? 'No alerts are automatically sent; resolve and verify exceptions with HR.' : 'Shift-based comparisons require a configured schedule; no live notifications are sent from this demo.'}</div>
    </section>}

    {view === 'Analytics' && <>
      <div className="workspace-stats">
        <KpiCard icon={Activity} label="7-day attendance" value={trend[trend.length - 1]?.attendance ?? null} foot="Latest available day · %" tone="green" />
        <KpiCard icon={ChartNoAxesCombined} label="Monthly attendance" value={monthlyTrend[monthlyTrend.length - 1]?.attendance ?? null} foot="Current month · %" tone="blue" />
        <KpiCard icon={Fingerprint} label="Missing punches" value={missingRecords.length} foot={`On ${formatDate(selectedDate)}`} tone="amber" />
        <KpiCard icon={BriefcaseBusiness} label="Departments" value={departments.length} foot="With attendance records" tone="violet" />
      </div>
      <div className="workspace-analytics-grid">
        <div className="panel workspace-chart-panel"><div className="workspace-panel-heading"><div><h2>Daily attendance trend</h2><p>Attendance and on-time rate · last 7 days</p></div></div><div className="workspace-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={trend} margin={{ top: 10, right: 12, bottom: 0, left: -14 }}><CartesianGrid stroke="#edf1ee" vertical={false} /><XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: '#616d65', fontSize: 12 }} /><YAxis domain={[0, 100]} axisLine={false} tickLine={false} tickFormatter={(value: number) => `${value}%`} tick={{ fill: '#616d65', fontSize: 12 }} /><Tooltip content={<ChartTooltip suffix="%" />} /><Line type="monotone" dataKey="attendance" name="Attendance" stroke="#2f6b4f" strokeWidth={2.5} dot={{ r: 3 }} /><Line type="monotone" dataKey="onTime" name="On time" stroke="#a9cdb8" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer></div></div>
        {role !== 'Employee' && <div className="panel workspace-chart-panel"><div className="workspace-panel-heading"><div><h2>Department attendance</h2><p>Rates use the employee master and imported movements</p></div></div><div className="workspace-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={departmentRows} layout="vertical" margin={{ top: 4, right: 15, bottom: 0, left: 0 }}><CartesianGrid stroke="#edf1ee" horizontal={false} /><XAxis type="number" domain={[0, 100]} tickFormatter={(value: number) => `${value}%`} axisLine={false} tickLine={false} tick={{ fill: '#616d65', fontSize: 12 }} /><YAxis type="category" dataKey="department" width={115} axisLine={false} tickLine={false} tick={{ fill: '#616d65', fontSize: 12 }} /><Tooltip content={<ChartTooltip suffix="%" />} /><Bar dataKey="rate" name="Attendance" fill="#3f8a66" radius={[0, 5, 5, 0]} barSize={15} /></BarChart></ResponsiveContainer></div></div>}
        <div className="panel workspace-chart-panel"><div className="workspace-panel-heading"><div><h2>Weekly attendance trend</h2><p>Presence by calendar week</p></div></div><div className="workspace-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={weekly} margin={{ top: 10, right: 12, bottom: 0, left: -14 }}><CartesianGrid stroke="#edf1ee" vertical={false} /><XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: '#616d65', fontSize: 12 }} /><YAxis domain={[0, 100]} axisLine={false} tickLine={false} tickFormatter={(value: number) => `${value}%`} tick={{ fill: '#616d65', fontSize: 12 }} /><Tooltip content={<ChartTooltip suffix="%" />} /><Line type="monotone" dataKey="attendance" name="Attendance" stroke="#2f6b4f" strokeWidth={2.5} dot={{ r: 3 }} /></LineChart></ResponsiveContainer></div></div>
        <div className="panel workspace-chart-panel"><div className="workspace-panel-heading"><div><h2>Monthly attendance trend</h2><p>Monthly attendance rate from imported records</p></div></div><div className="workspace-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={monthlyTrend} margin={{ top: 10, right: 12, bottom: 0, left: -14 }}><CartesianGrid stroke="#edf1ee" vertical={false} /><XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: '#616d65', fontSize: 12 }} /><YAxis domain={[0, 100]} axisLine={false} tickLine={false} tickFormatter={(value: number) => `${value}%`} tick={{ fill: '#616d65', fontSize: 12 }} /><Tooltip content={<ChartTooltip suffix="%" />} /><Line type="monotone" dataKey="attendance" name="Attendance" stroke="#2f6b4f" strokeWidth={2.5} dot={{ r: 3 }} /></LineChart></ResponsiveContainer></div></div>
        {role === 'HR' && <div className="panel workspace-chart-panel"><div className="workspace-panel-heading"><div><h2>Working hours analysis</h2><p>Average paired-punch hours by employee · last 30 days</p></div></div><div className="workspace-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={employeeWorkHours} margin={{ top: 10, right: 15, bottom: 0, left: -14 }}><CartesianGrid stroke="#edf1ee" vertical={false} /><XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#616d65', fontSize: 12 }} /><YAxis axisLine={false} tickLine={false} tickFormatter={(value: number) => `${value}h`} tick={{ fill: '#616d65', fontSize: 12 }} /><Tooltip content={<ChartTooltip suffix="h" />} /><Bar dataKey="hours" name="Average hours" fill="#3f8a66" radius={[4, 4, 0, 0]} barSize={23} /></BarChart></ResponsiveContainer></div></div>}
        <div className="panel workspace-chart-panel"><div className="workspace-panel-heading"><div><h2>Employee attendance history</h2><p>Daily working time and late minutes</p></div><select className="employee-chart-select" aria-label="Select employee attendance history" value={historyEmployee} onChange={(event) => setHistoryEmployee(event.target.value)}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></div><div className="workspace-chart"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={employeeHistoryChart} margin={{ top: 10, right: 15, bottom: 0, left: -14 }}><CartesianGrid stroke="#edf1ee" vertical={false} /><XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: '#616d65', fontSize: 12 }} /><YAxis yAxisId="hours" axisLine={false} tickLine={false} tickFormatter={(value: number) => `${value}h`} tick={{ fill: '#616d65', fontSize: 12 }} /><YAxis yAxisId="late" orientation="right" width={40} axisLine={false} tickLine={false} allowDecimals={false} tickFormatter={(value: number) => `${value}m`} tick={{ fill: '#616d65', fontSize: 12 }} /><Tooltip /><Bar yAxisId="hours" dataKey="hours" name="Worked hours" fill="#3f8a66" radius={[4, 4, 0, 0]} barSize={18} /><Line yAxisId="late" type="monotone" dataKey="late" name="Late minutes" stroke="#e8aa4e" strokeWidth={2} dot={false} /></ComposedChart></ResponsiveContainer></div></div>
      </div>
      {role !== 'Employee' && <section className="panel workspace-panel department-breakdown"><div className="workspace-panel-heading"><div><h2>Department performance</h2><p>Employee counts and measured attendance indicators</p></div></div><div className="table-scroll"><table><thead><tr><th>DEPARTMENT</th><th>EMPLOYEES</th><th>PRESENT</th><th>ABSENT</th><th>LATE</th><th>EARLY</th><th>AVG HOURS</th></tr></thead><tbody>
        {departmentRows.map((item) => <tr key={item.department}><td>{item.department}</td><td>{item.employeeCount}</td><td>{item.presentCount}</td><td>{item.absentCount ?? '—'}</td><td>{item.lateArrivals}</td><td>{item.earlyDepartures}</td><td>{item.averageWorkingHours ? `${item.averageWorkingHours.toFixed(2)}h` : '—'}</td></tr>)}
        {!departmentRows.length && <tr><td className="empty-table" colSpan={7}>Department analytics require employee master data and imported movement records.</td></tr>}
      </tbody></table></div></section>}
    </>}

    {view === 'Settings' && <div className="settings-grid">
      <section className="panel settings-card"><div className="settings-card-icon"><Fingerprint size={18} /></div><h2>Attendance data source</h2><p>{liveData ? 'Attendance records are loaded from the authorized JPM API. Direct HRMS/eSSL connectivity is not assumed.' : demoMode ? 'Clearly marked development sample records are active. No company HRMS or biometric connection is configured.' : 'Sign in and configure an authorized data source to load company attendance.'}</p><div className="settings-status"><i /> {liveData ? 'JPM API connected' : demoMode ? 'Demo only · not a live feed' : 'Not connected'}</div><button className="button-secondary" onClick={() => onNotice('Automatic HRMS/eSSL integration requires authorized connectivity credentials. Attendance report imports are available through the configured backend.')}>Integration details</button></section>
      <section className="panel settings-card"><div className="settings-card-icon"><ShieldCheck size={18} /></div><h2>Access & permissions</h2><p>{liveData ? 'This session is authenticated and page permissions are based on the backend role.' : 'Demo role switching only changes the development interface; it does not grant production permissions.'}</p><div className="settings-status"><i /> {liveData ? `${role} · authenticated` : `${role} role preview`}</div><button className="button-secondary" onClick={() => onNotice('Production authentication and role authorization are enforced by the Spring Security API.')}>Security details</button></section>
      <section className="panel settings-card"><div className="settings-card-icon"><FileBarChart size={18} /></div><h2>Report imports</h2><p>Excel and text-based PDF reports are parsed by the API, validated against the employee master and retained in import history.</p><div className={`settings-status ${liveData ? '' : 'settings-unavailable'}`}><i /> {liveData ? 'Import history available to HR' : 'Sign in with an HR account to import'}</div><button className="button-secondary" onClick={onImport}>Open import dialog</button></section>
    </div>}

    <footer className="page-footer"><span>© {new Date().getFullYear()} JPM HRMS · Junior Processing Mills</span><span><span className="secure-dot" /> {liveData ? 'Authenticated API session' : demoMode ? 'Demo workspace' : 'No live source connected'}</span><button onClick={() => onNotice('Integration layer is ready for future authorized HRMS and eSSL connectivity.')}>Integration status <span className="footer-demo">{liveData ? 'Connected' : demoMode ? 'Demo mode' : 'Not connected'}</span></button></footer>
  </>;
}

function KpiCard({ icon: Icon, label, value, foot, tone, suffix = '', onClick }: {
  icon: typeof Users; label: string; value: number | null | undefined; foot: string; tone: string; suffix?: string; onClick?: () => void;
}) {
  const displayValue = (value === null || value === undefined || isNaN(Number(value)))
    ? '—'
    : `${Number(value).toLocaleString('en-IN')}${suffix}`;
  const body = <>
    <div className="kpi-top"><div className="kpi-label">{label}</div><span className={`kpi-icon ${tone}`}><Icon size={17} strokeWidth={1.9} /></span></div>
    <div className="kpi-value">{displayValue}</div>
    <div className="kpi-foot">{foot}</div>
  </>;
  return onClick
    ? <button type="button" className="kpi-card kpi-card-link" onClick={onClick} aria-label={`${label}: view employees`}>{body}</button>
    : <article className="kpi-card">{body}</article>;
}

const formatMinutes = (minutes: number) => minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;

function MovementRow({ record, onClick }: { record: AttendanceRecord; onClick?: () => void }) {
  const employee = getEmployee(record.employeeId);
  if (!employee) return null;
  return <tr>
    <td><div className="employee-cell"><div className={`employee-avatar ${employee.color}`}>{employee.initials}</div><div><button className="table-employee-link" onClick={onClick} disabled={!onClick}>{employee.name}<small>{employee.id}</small></button></div></div></td>
    <td className="department-cell">{employee.department}</td>
    <td className="time-cell">{formatDate(record.date)}</td>
    <td className="time-cell">{record.firstIn || '—'}</td>
    <td className="time-cell">{record.lastOut || '—'}</td>
    <td className="punch-sequence" title={record.punches?.map((punch) => punch.rawValue).join(' → ') || 'No punch events'}>{record.punches?.length ? record.punches.map((punch) => punch.rawValue).join(' · ') : '—'}</td>
    <td className="hours-cell">{record.hours ? `${record.hours.toFixed(1)}h` : '—'}{record.shortMinutes ? <small className="short-note">−{formatMinutes(record.shortMinutes)} of 12h</small> : null}</td>
    <td className={record.lateMinutes ? 'late-cell' : 'time-cell'}>{record.lateMinutes ? `+${record.lateMinutes}m` : '—'}</td>
    <td className="time-cell">{record.earlyMinutes ? `${record.earlyMinutes}m` : '—'}</td>
    <td><span className={`status-pill ${statusClass[record.status]}`}><i />{record.status}</span></td>
  </tr>;
}

function EmployeeTimeline({ employee, records, onClose }: {
  employee?: Employee;
  records: AttendanceRecord[];
  onClose: () => void;
}) {
  if (!employee) return null;
  return <div className="modal-backdrop" onClick={onClose}>
    <section className="import-modal timeline-modal" role="dialog" aria-modal="true" aria-labelledby="timeline-title" onClick={(event) => event.stopPropagation()}>
      <div className="modal-top"><div className="modal-icon"><Fingerprint size={19} /></div><button className="icon-button" onClick={onClose} aria-label="Close employee timeline"><X size={18} /></button></div>
      <h2 id="timeline-title">{employee.name}</h2>
      <p className="modal-description">{employee.id} · {employee.department} · {employee.title}</p>
      <div className="timeline-records">
        {!records.length && <div className="workspace-empty"><strong>No punch history</strong><p>No attendance movements are available for this employee.</p></div>}
        {records.map((record) => <article className="timeline-day" key={`${record.employeeId}-${record.date}`}>
          <div className="timeline-day-heading"><strong>{formatDate(record.date)}</strong><span className={`status-pill ${statusClass[record.status]}`}><i />{record.status}</span></div>
          <div className="timeline-day-summary"><span>{record.hours.toFixed(2)} working hours</span><span>{record.lateMinutes ? `${record.lateMinutes}m late` : 'No late arrival'}</span><span>{record.earlyMinutes ? `${record.earlyMinutes}m early` : 'No early departure'}</span>{record.shortMinutes ? <span className="short-chip">{formatMinutes(record.shortMinutes)} short of 12h shift</span> : null}</div>
          {record.punches?.length ? <ol className="punch-timeline">{record.punches.map((punch) => <li key={`${punch.sequence}-${punch.time}-${punch.type}`}><span className={`punch-type ${punch.type.toLowerCase()}`}>{punch.type}</span><time>{new Date(punch.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</time><code>{punch.rawValue}</code></li>)}</ol> : <p className="form-hint">No individual punch events are available for this record.</p>}
        </article>)}
      </div>
      <div className="modal-actions"><button className="button-secondary" onClick={onClose}>Close</button></div>
    </section>
  </div>;
}

function ChartTooltip({ active, payload, label, suffix = '' }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string; suffix?: string }) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tooltip"><strong>{label}</strong>{payload.map((item) => <span key={item.name}><i style={{ background: item.color }} />{item.name}<b>{item.value}{suffix}</b></span>)}</div>;
}

export default App;
