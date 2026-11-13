export type ApiIdentity = {
  username: string;
  roles: string[];
  employeeId: string;
};

export type ApiEmployee = {
  employeeId: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  shift: string | null;
  joiningDate: string | null;
  employmentStatus: string;
};

export type ApiPunch = {
  sequence: number;
  time: string;
  type: 'IN' | 'OUT';
  rawValue: string;
};

export type ApiMovement = {
  employeeId: string;
  employeeName: string;
  department: string;
  date: string;
  firstIn: string | null;
  lastOut: string | null;
  punches: ApiPunch[];
  workedMinutes: number;
  lateMinutes: number;
  earlyGoingMinutes: number;
  status: string;
};

export type ApiDashboardSummary = {
  date: string;
  totalEmployees: number;
  presentEmployees: number;
  absentEmployees: number | null;
  lateComing: number;
  earlyGoing: number;
  onDuty: number;
  missingPunches: number;
  averageWorkingHours: number | null;
  employeeMasterAvailable: boolean;
  importedReportAvailable: boolean;
};

export type ApiDepartmentAnalytics = {
  departmentId: string;
  department: string;
  employeeCount: number;
  presentCount: number;
  absentCount: number | null;
  lateArrivals: number;
  earlyDepartures: number;
  averageWorkingHours: number;
};

export type ApiAlert = {
  id: string | null;
  employeeId: string;
  employeeName: string;
  department: string;
  date: string;
  type: string;
  severity: string;
  message: string;
  createdAt: string | null;
  status: string;
};

export type ImportPreviewRow = {
  sourceRow: number;
  employeeId: string;
  employeeName: string;
  date: string | null;
  punches: ApiPunch[];
  firstIn: string | null;
  lastOut: string | null;
  workedMinutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  status: string;
  validationStatus: 'VALID' | 'INVALID' | 'DUPLICATE';
  messages: string[];
  originalData: Record<string, string>;
};

export type ImportPreview = {
  importId: string;
  filename: string;
  fileType: string;
  status: string;
  totalRows: number;
  validRows: number;
  rejectedRows: number;
  duplicateRows: number;
  reportDates: string[];
  rows: ImportPreviewRow[];
  messages: string[];
};

export type ImportHistoryItem = {
  id: string;
  filename: string;
  fileType: string;
  status: string;
  totalRows: number;
  validRows: number;
  rejectedRows: number;
  duplicateRows: number;
  createdAt: string;
  committedAt: string | null;
  uploadedBy: string;
};

export async function apiRequest<T>(
  path: string,
  authorization: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Authorization', authorization);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const apiBase = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
  const targetUrl = path.startsWith('http') ? path : `${apiBase}${path.startsWith('/') ? path : `/${path}`}`;
  const response = await fetch(targetUrl, { ...options, headers });
  if (!response.ok) {
    let message = response.status >= 500
      ? `Attendance API server error (${response.status}). Check that the backend and PostgreSQL are running, then review the backend logs.`
      : `Request failed (${response.status}).`;
    try {
      const error = await response.json() as { message?: string };
      if (error.message) message = error.message;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}
