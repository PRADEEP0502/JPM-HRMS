export type AttendanceStatus = 'Present' | 'Late' | 'Absent' | 'On duty' | 'Early out' | 'Missing punch' | 'No punching';
export type Employee = {
  id: string;
  name: string;
  department: string;
  title: string;
  initials: string;
  color: string;
  shift?: string | null;
  joiningDate?: string | null;
  employmentStatus?: string;
};
export type AttendanceRecord = {
  employeeId: string;
  date: string;
  firstIn: string;
  lastOut: string;
  hours: number;
  lateMinutes: number;
  earlyMinutes: number;
  status: AttendanceStatus;
  punches?: Array<{ sequence: number; time: string; type: 'IN' | 'OUT'; rawValue: string }>;
  originalData?: Record<string, string>;
};

export const demoMode = import.meta.env.DEV;

const demoEmployees: Employee[] = [
  { id: 'JPM-1042', name: 'Arjun Kumar', department: 'Production', title: 'Line Supervisor', initials: 'AK', color: 'mint' },
  { id: 'JPM-1088', name: 'Priya Sharma', department: 'Human Resources', title: 'HR Executive', initials: 'PS', color: 'lavender' },
  { id: 'JPM-1125', name: 'Rahul Nair', department: 'Quality Control', title: 'Quality Analyst', initials: 'RN', color: 'peach' },
  { id: 'JPM-1156', name: 'Meena Iyer', department: 'Finance', title: 'Accounts Officer', initials: 'MI', color: 'blue' },
  { id: 'JPM-1193', name: 'Sanjay Patel', department: 'Production', title: 'Machine Operator', initials: 'SP', color: 'pink' },
  { id: 'JPM-1210', name: 'Kavitha Reddy', department: 'Logistics', title: 'Dispatch Coordinator', initials: 'KR', color: 'yellow' },
  { id: 'JPM-1254', name: 'Vikram Singh', department: 'Maintenance', title: 'Maintenance Lead', initials: 'VS', color: 'mint' },
  { id: 'JPM-1291', name: 'Ananya Das', department: 'Production', title: 'Production Associate', initials: 'AD', color: 'lavender' },
  { id: 'JPM-1307', name: 'Karthik Rao', department: 'Quality Control', title: 'QC Technician', initials: 'KR', color: 'peach' },
  { id: 'JPM-1346', name: 'Divya Menon', department: 'Human Resources', title: 'Talent Partner', initials: 'DM', color: 'blue' },
  { id: 'JPM-1372', name: 'Mohammed Faiz', department: 'Production', title: 'Machine Operator', initials: 'MF', color: 'pink' },
  { id: 'JPM-1401', name: 'Sneha Joshi', department: 'Logistics', title: 'Inventory Associate', initials: 'SJ', color: 'yellow' },
  { id: 'JPM-1438', name: 'Rohit Verma', department: 'Finance', title: 'Finance Analyst', initials: 'RV', color: 'mint' },
  { id: 'JPM-1479', name: 'Lakshmi Pillai', department: 'Production', title: 'Production Associate', initials: 'LP', color: 'lavender' },
  { id: 'JPM-1514', name: 'Aditya Bose', department: 'Maintenance', title: 'Electrical Technician', initials: 'AB', color: 'peach' },
  { id: 'JPM-1548', name: 'Nisha Gupta', department: 'Quality Control', title: 'Quality Analyst', initials: 'NG', color: 'blue' },
];
export let employees: Employee[] = demoMode ? demoEmployees : [];

const today = new Date();
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const todayKey = dateKey(today);
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const makeRecord = (employee: Employee, daysAgo: number): AttendanceRecord => {
  const date = new Date(today);
  date.setDate(today.getDate() - daysAgo);
  const seed = employees.indexOf(employee) + daysAgo * 7;
  const absent = seed % 19 === 0;
  const onDuty = seed % 17 === 0;
  const missingPunch = !absent && !onDuty && seed % 23 === 0;
  const lateMinutes = seed % 5 === 0 ? 8 + (seed * 7) % 29 : 0;
  const earlyMinutes = seed % 13 === 0 ? 12 + (seed * 3) % 26 : 0;
  const firstInMinutes = 8 * 60 + 30 + lateMinutes + (seed % 4) * 2;
  const lunchOutMinutes = 12 * 60;
  const lunchInMinutes = 12 * 60 + 45;
  const lastOutMinutes = 17 * 60 + 30 - earlyMinutes;
  const missingFirstIn = missingPunch && seed % 2 === 0;
  const missingLastOut = missingPunch && !missingFirstIn;
  const firstPair = missingFirstIn || absent ? 0 : Math.max(0, lunchOutMinutes - firstInMinutes);
  const secondPair = missingLastOut || absent ? 0 : Math.max(0, lastOutMinutes - lunchInMinutes);
  const hours = (firstPair + secondPair) / 60;
  const punch = (minutes: number, type: 'IN' | 'OUT') => {
    const dateString = dateKey(date);
    return {
      sequence: 0,
      time: `${dateString}T${clock(minutes)}:00`,
      type,
      rawValue: `${clock(minutes)}-${type === 'IN' ? 'I' : 'O'}`,
    };
  };
  const punches = [
    ...(absent || missingFirstIn ? [] : [punch(firstInMinutes, 'IN')]),
    ...(absent ? [] : [punch(lunchOutMinutes, 'OUT')]),
    ...(absent ? [] : [punch(lunchInMinutes, 'IN')]),
    ...(absent || missingLastOut ? [] : [punch(lastOutMinutes, 'OUT')]),
  ].map((item, index) => ({ ...item, sequence: index + 1 }));
  return {
    employeeId: employee.id,
    date: dateKey(date),
    firstIn: absent || missingFirstIn ? '' : clock(firstInMinutes),
    lastOut: absent || missingLastOut ? '' : clock(lastOutMinutes),
    hours: Number(hours.toFixed(1)),
    lateMinutes: absent || missingFirstIn ? 0 : lateMinutes,
    earlyMinutes: absent || missingLastOut ? 0 : earlyMinutes,
    status: absent ? 'Absent' : onDuty ? 'On duty' : missingPunch ? 'Missing punch' : lateMinutes > 0 ? 'Late' : earlyMinutes > 0 ? 'Early out' : 'Present',
    punches,
  };
};

const demoAttendanceRecords = demoMode
  ? Array.from({ length: 180 }, (_, daysAgo) => employees.map((employee) => makeRecord(employee, daysAgo))).flat()
  : [];
export let attendanceRecords = demoAttendanceRecords;

export const resetAttendanceData = () => {
  employees = demoMode ? demoEmployees : [];
  attendanceRecords = demoAttendanceRecords;
};

const avatarColors = ['mint', 'lavender', 'peach', 'blue', 'pink', 'yellow'];
export const replaceAttendanceData = (
  rawEmployeeRows: any,
  rawMovementRows: any,
) => {
  const employeeRows: any[] = Array.isArray(rawEmployeeRows)
    ? rawEmployeeRows
    : (Array.isArray(rawEmployeeRows?.employees) ? rawEmployeeRows.employees : []);

  const movementRows: any[] = Array.isArray(rawMovementRows)
    ? rawMovementRows
    : (Array.isArray(rawMovementRows?.records) ? rawMovementRows.records : []);

  const mappedEmployees = employeeRows.map((emp, index) => {
    const id = String(emp.employeeId || emp.ticket || emp.id || `EMP-${index}`);
    const name = String(emp.employeeName || emp.name || id).trim();
    const initials = name.split(/\s+/).slice(0, 2).map((part: string) => part[0] ?? '').join('').toUpperCase() || 'EM';
    return {
      id,
      name,
      department: emp.department?.trim() || emp.dept || 'Unassigned',
      title: emp.designation?.trim() || emp.title || 'Employee',
      initials,
      color: avatarColors[index % avatarColors.length],
      shift: emp.shift || 'General',
      joiningDate: emp.joiningDate || null,
      employmentStatus: emp.employmentStatus ?? 'ACTIVE',
    };
  });
  if (mappedEmployees.length > 0) {
    employees = mappedEmployees;
  }
  attendanceRecords = movementRows.map((movement) => {
    const empId = String(movement.employeeId || movement.ticket || movement.id || '');
    const firstIn = movement.firstIn ? movement.firstIn.slice(11, 16) : (movement.in || '');
    const lastOut = movement.lastOut ? movement.lastOut.slice(11, 16) : (movement.out || '');
    const lateMin = Number(movement.lateMinutes ?? movement.late_min ?? 0);
    const earlyMin = Number(movement.earlyGoingMinutes ?? movement.early_min ?? 0);
    const hrs = Number(movement.workedMinutes ? (movement.workedMinutes / 60).toFixed(2) : (movement.hrs_decimal ?? 0));
    const statusStr = String(movement.status || '').toUpperCase();
    const status: AttendanceStatus = statusStr === 'ABSENT' ? 'Absent'
      : statusStr === 'INCOMPLETE' ? 'Missing punch'
      : statusStr === 'NO_PUNCHES' ? 'No punching'
      : statusStr === 'ON_DUTY' ? 'On duty'
      : lateMin > 0 ? 'Late'
      : earlyMin > 0 ? 'Early out' : 'Present';
    return {
      employeeId: empId,
      date: movement.date || todayKey,
      firstIn,
      lastOut,
      hours: hrs,
      lateMinutes: lateMin,
      earlyMinutes: earlyMin,
      status,
      punches: movement.punches || [],
    };
  });
};

export const getEmployee = (employeeId: string) => employees.find((employee) => employee.id === employeeId);
export const getRecordsForDate = (date: string) => attendanceRecords.filter((record) => record.date === date);
export const getDepartments = () => [...new Set(employees.map((employee) => employee.department))].sort();

export const getTrendData = (days: number, employeeId?: string) => {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (days - index - 1));
    const records = getRecordsForDate(dateKey(date)).filter((record) => !employeeId || record.employeeId === employeeId);
    const attended = records.filter((record) => record.status !== 'Absent' && record.status !== 'No punching').length;
    return {
      date: days === 7 ? date.toLocaleDateString('en', { weekday: 'short' }) : date.toLocaleDateString('en', { month: 'short' }),
      attendance: records.length ? Math.round((attended / records.length) * 100) : null,
      onTime: records.length ? Math.round((records.filter((record) => record.status === 'Present').length / records.length) * 100) : null,
      records: records.length,
    };
  });
};

export const getWeeklyTrendData = (weeks: number, employeeId?: string) => {
  const currentMonday = new Date(today);
  currentMonday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return Array.from({ length: weeks }, (_, index) => {
    const start = new Date(currentMonday);
    start.setDate(currentMonday.getDate() - (weeks - index - 1) * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    const records = attendanceRecords.filter((record) => {
      const date = new Date(`${record.date}T00:00:00`);
      return date >= start && date < end && (!employeeId || record.employeeId === employeeId);
    });
    const present = records.filter((record) => record.status !== 'Absent' && record.status !== 'No punching').length;
    return {
      date: start.toLocaleDateString('en', { day: 'numeric', month: 'short' }),
      attendance: records.length ? Math.round((present / records.length) * 100) : null,
      records: records.length,
    };
  });
};

export const getMonthlyTrendData = (months: number, employeeId?: string) => {
  const firstMonth = new Date(today.getFullYear(), today.getMonth() - months + 1, 1);
  return Array.from({ length: months }, (_, index) => {
    const month = new Date(firstMonth.getFullYear(), firstMonth.getMonth() + index, 1);
    const prefix = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
    const records = attendanceRecords.filter((record) => record.date.startsWith(prefix) && (!employeeId || record.employeeId === employeeId));
    const present = records.filter((record) => record.status !== 'Absent' && record.status !== 'No punching').length;
    return {
      date: month.toLocaleDateString('en', { month: 'short' }),
      attendance: records.length ? Math.round((present / records.length) * 100) : null,
      onTime: records.length ? Math.round((records.filter((record) => record.lateMinutes === 0 && record.status !== 'Absent' && record.status !== 'No punching').length / records.length) * 100) : null,
      records: records.length,
    };
  });
};

export const departmentData = (date: string) => {
  const records = getRecordsForDate(date);
  return [...new Set(employees.map((employee) => employee.department))].map((department) => {
    const team = employees.filter((employee) => employee.department === department);
    const present = records.filter((record) => team.some((employee) => employee.id === record.employeeId) && record.status !== 'Absent' && record.status !== 'No punching').length;
    return { department, rate: team.length ? Math.round((present / team.length) * 100) : 0, present, total: team.length };
  }).sort((a, b) => b.rate - a.rate);
};

export const formatDate = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
