import { unzipSync, strFromU8 } from 'fflate';
import { isLegacyXls, readLegacyXls } from './legacyXls';
import type { ApiMovement, ApiPunch, ImportPreview, ImportPreviewRow } from './api';

// Browser-side reader for eSSL movement reports (.xlsx). Mirrors the backend MovementImportParser
// so the preview matches what the API would accept.

type Sheet = { name: string; rows: string[][] };

const PUNCH_PATTERN = /^\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*(AM|PM)?\s*[- ]?\s*(I|O|IN|OUT)\s*$/i;

const columnIndex = (ref: string) => {
  let index = 0;
  for (const character of ref.replace(/[^A-Z]/gi, '').toUpperCase()) index = index * 26 + character.charCodeAt(0) - 64;
  return index - 1;
};

const parseXml = (bytes: Uint8Array) => new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');
const byTag = (root: Document | Element, tag: string) => Array.from(root.getElementsByTagNameNS('*', tag));

function readHtmlTables(bytes: Uint8Array): Sheet[] {
  const document = new DOMParser().parseFromString(strFromU8(bytes), 'text/html');
  return Array.from(document.querySelectorAll('table')).map((table, index) => ({
    name: `Table ${index + 1}`,
    rows: Array.from(table.querySelectorAll('tr')).map((row) => Array.from(row.querySelectorAll('th,td')).map((cell) => (cell.textContent ?? '').trim())),
  }));
}

function readWorkbook(bytes: Uint8Array): Sheet[] {
  if (isLegacyXls(bytes)) return readLegacyXls(bytes);
  if (bytes[0] !== 0x50 && /^s*</.test(strFromU8(bytes.subarray(0, 64)))) return readHtmlTables(bytes);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('This file is not a valid .xlsx workbook. Open it in Excel and save it as .xlsx.');
  }
  if (!files['xl/workbook.xml']) throw new Error('This file is not a valid .xlsx workbook.');

  const shared = files['xl/sharedStrings.xml']
    ? byTag(parseXml(files['xl/sharedStrings.xml']), 'si').map((item) =>
      byTag(item, 't').filter((node) => node.parentElement?.localName !== 'rPh').map((node) => node.textContent ?? '').join(''))
    : [];

  const relationships = new Map<string, string>();
  if (files['xl/_rels/workbook.xml.rels']) {
    for (const rel of byTag(parseXml(files['xl/_rels/workbook.xml.rels']), 'Relationship')) {
      const target = rel.getAttribute('Target') ?? '';
      relationships.set(rel.getAttribute('Id') ?? '', target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    }
  }

  const sheets: Sheet[] = [];
  byTag(parseXml(files['xl/workbook.xml']), 'sheet').forEach((sheetNode, position) => {
    const relId = sheetNode.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? sheetNode.getAttribute('r:id') ?? '';
    const path = relationships.get(relId) ?? `xl/worksheets/sheet${position + 1}.xml`;
    const data = files[path];
    if (!data) return;
    const rows: string[][] = [];
    let rowCounter = 0;
    for (const rowNode of byTag(parseXml(data), 'row')) {
      const rowNumber = Number(rowNode.getAttribute('r')) || rowCounter + 1;
      rowCounter = rowNumber;
      const cells: string[] = [];
      let cellCounter = 0;
      for (const cell of Array.from(rowNode.children).filter((node) => node.localName === 'c')) {
        const ref = cell.getAttribute('r');
        const column = ref ? columnIndex(ref) : cellCounter;
        cellCounter = column + 1;
        const type = cell.getAttribute('t');
        const valueNode = Array.from(cell.children).find((node) => node.localName === 'v');
        let value = '';
        if (type === 'inlineStr') value = byTag(cell, 't').map((node) => node.textContent ?? '').join('');
        else if (type === 's') value = shared[Number(valueNode?.textContent)] ?? '';
        else value = valueNode?.textContent ?? '';
        cells[column] = value.trim();
      }
      rows[rowNumber - 1] = cells;
    }
    sheets.push({ name: sheetNode.getAttribute('name') ?? `Sheet${position + 1}`, rows });
  });
  return sheets;
}

const normalize = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

function canonicalHeader(header: string) {
  if (['ticketno', 'ticketnumber', 'employeeid', 'empid', 'employeecode', 'empcode', 'cardno', 'badgeno', 'employee'].includes(header)) return 'employeeId';
  if (['empname', 'employeename', 'name', 'staffname'].includes(header)) return 'employeeName';
  if (['date', 'punchdate', 'workdate', 'attendancedate'].includes(header)) return 'date';
  if (['department', 'dept', 'departmentname'].includes(header)) return 'department';
  if (['late', 'lateminutes', 'lateby'].includes(header)) return 'reportedLate';
  if (['earler', 'earlier', 'early', 'earlygoing', 'earlygoingminutes', 'earlyby'].includes(header)) return 'reportedEarly';
  if (['status', 'attendancestatus', 'attendance'].includes(header)) return 'attendanceStatus';
  const time = header.match(/^(?:time|punch|punches|movement)(\d{1,2})$/);
  return time ? `time${time[1]}` : '';
}

function columnMap(row: string[]) {
  const columns = new Map<string, number>();
  row.forEach((cell, index) => {
    const field = cell ? canonicalHeader(normalize(cell)) : '';
    if (field && !columns.has(field)) columns.set(field, index);
  });
  return columns;
}

const pad = (value: number) => String(value).padStart(2, '0');

function parseDate(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  let year: number, month: number, day: number;
  let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = value.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/))) {
    [day, month] = [Number(match[1]), Number(match[2])];
    year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  } else if (/^\d{5}(\.\d+)?$/.test(value) && Number(value) > 20000 && Number(value) < 80000) {
    const serial = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(value)) * 86400000);
    [year, month, day] = [serial.getUTCFullYear(), serial.getUTCMonth() + 1, serial.getUTCDate()];
  } else return null;
  const check = new Date(year, month - 1, day);
  if (check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function parsePunch(raw: string): { minutes: number; type: 'IN' | 'OUT' } | null {
  const match = raw.match(PUNCH_PATTERN);
  if (!match) return null;
  const [hourText, minuteText] = match[1].split(':');
  let hour = Number(hourText);
  const minute = Number(minuteText);
  if (minute > 59) return null;
  if (match[2]) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (match[2].toUpperCase() === 'PM' ? 12 : 0);
  } else if (hour > 23) return null;
  const type = match[3].toUpperCase().startsWith('I') ? 'IN' : 'OUT';
  return { minutes: hour * 60 + minute, type };
}

function reportedMinutes(value: string | undefined) {
  if (!value || value === '-') return 0;
  if (/^0\.\d{4,}$/.test(value)) return Math.round(Number(value) * 1440);
  const match = value.match(/(\d{1,3})(?::(\d{1,2}))?/);
  if (!match) return 0;
  return match[2] ? Number(match[1]) * 60 + Number(match[2]) : Number(match[1]);
}

function isoAt(date: string, minutes: number) {
  const [year, month, day] = date.split('-').map(Number);
  const moment = new Date(year, month - 1, day, 0, minutes);
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}T${pad(moment.getHours())}:${pad(moment.getMinutes())}:00`;
}

function buildRow(sourceRow: number, original: Record<string, string>): ImportPreviewRow {
  const messages: string[] = [];
  const employeeId = (original.employeeId ?? '').trim();
  const employeeName = (original.employeeName ?? '').trim();
  const date = parseDate(original.date ?? '');
  if (!employeeId) messages.push('Employee ID is required.');
  if (!employeeName) messages.push('Employee name is required.');
  if (!date) messages.push('Date is missing or uses an unsupported format.');

  const rawPunches = Object.keys(original)
    .filter((key) => /^time\d{1,2}$/.test(key))
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
    .map((key) => ({ column: key, value: original[key].trim() }))
    .filter((item) => item.value && item.value !== '-' && item.value.toUpperCase() !== 'NA');

  const punches: ApiPunch[] = [];
  const seen = new Set<string>();
  let firstIn: string | null = null;
  let lastOut: string | null = null;
  let pendingIn: number | null = null;
  let previous: number | null = null;
  let dayOffset = 0;
  let workedMinutes = 0;
  for (const raw of rawPunches) {
    const parsed = parsePunch(raw.value);
    if (!parsed) {
      messages.push(`${raw.column} (“${raw.value}”) must include an explicit IN/OUT indicator, e.g. 08:03 AM-I.`);
      continue;
    }
    let absolute = parsed.minutes + dayOffset * 1440;
    if (previous !== null && absolute < previous && previous - absolute > 2 * 60) {
      dayOffset++;
      absolute = parsed.minutes + dayOffset * 1440;
    }
    previous = absolute;
    const signature = `${parsed.type}:${parsed.minutes}`;
    if (seen.has(signature)) {
      messages.push(`Duplicate punch detected at ${raw.value}.`);
      continue;
    }
    seen.add(signature);
    const time = date ? isoAt(date, absolute) : '';
    punches.push({ sequence: punches.length + 1, rawValue: raw.value, type: parsed.type, time });
    if (parsed.type === 'IN') {
      if (pendingIn !== null) messages.push(`Unmatched IN punch before ${raw.value}.`);
      pendingIn = absolute;
      if (!firstIn) firstIn = time;
    } else {
      lastOut = time;
      if (pendingIn === null) messages.push(`Unmatched OUT punch at ${raw.value}.`);
      else {
        if (absolute > pendingIn) workedMinutes += absolute - pendingIn;
        else messages.push('OUT punch is not after its matching IN punch.');
        pendingIn = null;
      }
    }
  }
  if (pendingIn !== null) messages.push('Final IN punch has no matching OUT punch.');
  if (!rawPunches.length) messages.push('No punch values were found; this is not treated as an absence.');

  const invalid = messages.some((message) => message.includes('required') || message.startsWith('Date is') || message.includes('explicit IN/OUT'));
  const duplicate = messages.some((message) => message.startsWith('Duplicate punch'));
  const status = (original.attendanceStatus ?? '').trim().toLowerCase() === 'on duty' ? 'ON_DUTY'
    : !punches.length ? 'NO_PUNCHES'
      : messages.some((message) => message.startsWith('Unmatched') || message.startsWith('Final IN')) ? 'INCOMPLETE' : 'PRESENT';
  return {
    sourceRow, employeeId, employeeName, date, punches, firstIn, lastOut, workedMinutes,
    lateMinutes: reportedMinutes(original.reportedLate),
    earlyMinutes: reportedMinutes(original.reportedEarly),
    status, validationStatus: invalid ? 'INVALID' : duplicate ? 'DUPLICATE' : 'VALID',
    messages, originalData: original,
  };
}

export function parseMovementWorkbook(bytes: Uint8Array, filename: string): ImportPreview {
  const maxRows = 20000;
  for (const sheet of readWorkbook(bytes)) {
    const headerIndex = sheet.rows.slice(0, 25).findIndex((row) => {
      if (!row) return false;
      const columns = columnMap(row);
      return columns.has('employeeId') && columns.has('employeeName') && columns.has('date');
    });
    if (headerIndex < 0) continue;
    const columns = columnMap(sheet.rows[headerIndex]);
    const rows: ImportPreviewRow[] = [];
    const seenKeys = new Set<string>();
    for (let index = headerIndex + 1; index < sheet.rows.length && rows.length < maxRows; index++) {
      const cells = sheet.rows[index];
      if (!cells || cells.every((cell) => !cell)) continue;
      const original: Record<string, string> = {};
      columns.forEach((column, field) => { original[field] = cells[column] ?? ''; });
      if (!original.employeeId && !original.employeeName) continue;
      // Merged header cells can sit a column away from their values, so look next to the Date heading.
      const dateColumn = columns.get('date') as number;
      if (!parseDate(original.date)) {
        const nearby = [-1, 1, -2, 2].map((delta) => cells[dateColumn + delta]).find((cell) => cell && parseDate(cell));
        if (nearby) original.date = nearby;
      }
      const row = buildRow(index + 1, original);
      if (row.validationStatus === 'VALID' && row.date) {
        const key = `${row.employeeId}|${row.date}`;
        if (seenKeys.has(key)) {
          row.validationStatus = 'DUPLICATE';
          row.messages.push('This employee already has a record for this date in the file.');
        } else seenKeys.add(key);
      }
      rows.push(row);
    }
    if (!rows.length) throw new Error('The detected report header has no attendance rows.');
    const valid = rows.filter((row) => row.validationStatus === 'VALID');
    return {
      importId: 'local',
      filename,
      fileType: 'XLSX',
      status: 'PREVIEW',
      totalRows: rows.length,
      validRows: valid.length,
      rejectedRows: rows.filter((row) => row.validationStatus === 'INVALID').length,
      duplicateRows: rows.filter((row) => row.validationStatus === 'DUPLICATE').length,
      reportDates: [...new Set(valid.map((row) => row.date as string))].sort(),
      rows,
      messages: [`Detected report columns on row ${headerIndex + 1} in sheet “${sheet.name}”.`],
    };
  }
  throw new Error('Could not detect the required employee ID, employee name and date columns. Supported headings include TicketNo, EmpName, Date, Time1–Time10, Late and Earler.');
}

export function previewToData(preview: ImportPreview) {
  const valid = preview.rows.filter((row) => row.validationStatus === 'VALID' && row.date);
  const people = new Map<string, { employeeId: string; employeeName: string; department: string | null }>();
  for (const row of valid) {
    if (!people.has(row.employeeId)) people.set(row.employeeId, { employeeId: row.employeeId, employeeName: row.employeeName, department: row.originalData.department?.trim() || null });
  }
  const movements: ApiMovement[] = valid.map((row) => ({
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    department: row.originalData.department?.trim() ?? '',
    date: row.date as string,
    firstIn: row.firstIn,
    lastOut: row.lastOut,
    punches: row.punches,
    workedMinutes: row.workedMinutes,
    lateMinutes: row.lateMinutes,
    earlyGoingMinutes: row.earlyMinutes,
    status: row.status === 'PRESENT' && row.lateMinutes > 0 ? 'LATE' : row.status,
  }));
  return { employees: [...people.values()], movements };
}
