// Minimal reader for legacy binary Excel (.xls, BIFF8 in an OLE2 container).
// eSSL and many biometric tools export this format with an .xlsx extension. Only cell
// values are read: text, numbers and formula results. Formatting is ignored.

export type LegacySheet = { name: string; rows: string[][] };

const END_OF_CHAIN = 0xfffffffe;

export const isLegacyXls = (bytes: Uint8Array) =>
  bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;

function readContainerStream(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorSize = 1 << view.getUint16(0x1e, true);
  const miniSectorSize = 1 << view.getUint16(0x20, true);
  const miniCutoff = view.getUint32(0x38, true);
  const sectorOffset = (sector: number) => (sector + 1) * sectorSize;

  const fatSectors: number[] = [];
  for (let index = 0; index < 109; index++) {
    const sector = view.getUint32(0x4c + index * 4, true);
    if (sector < END_OF_CHAIN) fatSectors.push(sector);
  }
  let difat = view.getUint32(0x44, true);
  for (let guard = 0; difat < END_OF_CHAIN && guard < 4096; guard++) {
    const base = sectorOffset(difat);
    const perSector = sectorSize / 4 - 1;
    for (let index = 0; index < perSector; index++) {
      const sector = view.getUint32(base + index * 4, true);
      if (sector < END_OF_CHAIN) fatSectors.push(sector);
    }
    difat = view.getUint32(base + perSector * 4, true);
  }

  const fat: number[] = [];
  for (const sector of fatSectors) {
    const base = sectorOffset(sector);
    for (let index = 0; index < sectorSize / 4; index++) fat.push(view.getUint32(base + index * 4, true));
  }

  const chain = (start: number, table: number[]) => {
    const sectors: number[] = [];
    for (let sector = start; sector < END_OF_CHAIN && sectors.length <= table.length; sector = table[sector]) sectors.push(sector);
    return sectors;
  };
  const readSectors = (start: number) => {
    const sectors = chain(start, fat);
    const out = new Uint8Array(sectors.length * sectorSize);
    sectors.forEach((sector, index) => out.set(bytes.subarray(sectorOffset(sector), sectorOffset(sector) + sectorSize), index * sectorSize));
    return out;
  };

  const directory = readSectors(view.getUint32(0x30, true));
  const entries: Array<{ name: string; type: number; start: number; size: number }> = [];
  const directoryView = new DataView(directory.buffer);
  for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
    const nameLength = Math.max(0, directoryView.getUint16(offset + 0x40, true) - 2);
    let name = '';
    for (let index = 0; index < nameLength; index += 2) name += String.fromCharCode(directoryView.getUint16(offset + index, true));
    entries.push({ name, type: directory[offset + 0x42], start: directoryView.getUint32(offset + 0x74, true), size: directoryView.getUint32(offset + 0x78, true) });
  }
  const book = entries.find((entry) => entry.type === 2 && ['workbook', 'book'].includes(entry.name.toLowerCase()));
  if (!book) throw new Error('No Excel workbook stream was found in this file.');

  if (book.size >= miniCutoff) return readSectors(book.start).subarray(0, book.size);

  const root = entries.find((entry) => entry.type === 5);
  if (!root) throw new Error('This .xls file is damaged.');
  const miniContainer = readSectors(root.start);
  const miniFatBytes = readSectors(view.getUint32(0x3c, true));
  const miniFatView = new DataView(miniFatBytes.buffer);
  const miniFat: number[] = [];
  for (let index = 0; index + 4 <= miniFatBytes.length; index += 4) miniFat.push(miniFatView.getUint32(index, true));
  const miniSectors = chain(book.start, miniFat);
  const out = new Uint8Array(miniSectors.length * miniSectorSize);
  miniSectors.forEach((sector, index) => out.set(miniContainer.subarray(sector * miniSectorSize, (sector + 1) * miniSectorSize), index * miniSectorSize));
  return out.subarray(0, book.size);
}

type Record = { id: number; data: Uint8Array; position: number };

function* records(stream: Uint8Array, from = 0): Generator<Record> {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let position = from;
  while (position + 4 <= stream.length) {
    const id = view.getUint16(position, true);
    const length = view.getUint16(position + 2, true);
    yield { id, data: stream.subarray(position + 4, position + 4 + length), position };
    position += 4 + length;
  }
}

function decodeRk(value: number) {
  let number: number;
  if (value & 2) number = value >> 2;
  else {
    const buffer = new DataView(new ArrayBuffer(8));
    buffer.setUint32(4, value & 0xfffffffc, true);
    number = buffer.getFloat64(0, true);
  }
  return value & 1 ? number / 100 : number;
}

const numberText = (value: number) => (Number.isInteger(value) ? String(value) : String(parseFloat(value.toPrecision(12))));

function readText(data: Uint8Array, offset: number, length: number, wide: boolean) {
  let text = '';
  for (let index = 0; index < length; index++) {
    text += wide
      ? String.fromCharCode(data[offset + index * 2] | (data[offset + index * 2 + 1] << 8))
      : String.fromCharCode(data[offset + index]);
  }
  return text;
}

function readSharedStrings(segments: Uint8Array[]) {
  const strings: string[] = [];
  let segment = 0;
  let position = 8;
  const total = new DataView(segments[0].buffer, segments[0].byteOffset).getUint32(4, true);
  const ensure = () => {
    while (segment < segments.length && position >= segments[segment].length) { segment++; position = 0; }
    return segment < segments.length;
  };
  const byte = () => (ensure() ? segments[segment][position++] : 0);
  const skip = (count: number) => {
    while (count > 0 && ensure()) {
      const step = Math.min(count, segments[segment].length - position);
      position += step;
      count -= step;
    }
  };
  for (let index = 0; index < total && ensure(); index++) {
    const length = byte() | (byte() << 8);
    const flags = byte();
    let wide = (flags & 1) === 1;
    const runs = flags & 8 ? byte() | (byte() << 8) : 0;
    const extension = flags & 4 ? byte() | (byte() << 8) | (byte() << 16) | (byte() << 24) : 0;
    let text = '';
    let remaining = length;
    while (remaining > 0 && segment < segments.length) {
      if (position >= segments[segment].length) {
        segment++;
        position = 0;
        if (segment >= segments.length) break;
        wide = (segments[segment][position++] & 1) === 1;
      }
      const width = wide ? 2 : 1;
      const count = Math.min(remaining, Math.floor((segments[segment].length - position) / width));
      if (count === 0) { position = segments[segment].length; continue; }
      text += readText(segments[segment], position, count, wide);
      position += count * width;
      remaining -= count;
    }
    skip(runs * 4 + extension);
    strings.push(text);
  }
  return strings;
}

export function readLegacyXls(bytes: Uint8Array): LegacySheet[] {
  const stream = readContainerStream(bytes);
  const sheets: Array<{ name: string; offset: number }> = [];
  let strings: string[] = [];

  let sharedSegments: Uint8Array[] | null = null;
  let biff8 = false;
  for (const record of records(stream)) {
    if (record.id === 0x0809 && !biff8) {
      biff8 = new DataView(record.data.buffer, record.data.byteOffset).getUint16(0, true) === 0x0600;
      if (!biff8) throw new Error('Only Excel 97–2003 (BIFF8) files are supported. Open the file in Excel and save it as .xlsx.');
    }
    if (record.id === 0x00fc) sharedSegments = [record.data];
    else if (record.id === 0x003c && sharedSegments) sharedSegments.push(record.data);
    else if (sharedSegments) { strings = readSharedStrings(sharedSegments); sharedSegments = null; }
    if (record.id === 0x0085 && record.data.length > 8) {
      const view = new DataView(record.data.buffer, record.data.byteOffset);
      const kind = record.data[5];
      const length = record.data[6];
      const wide = (record.data[7] & 1) === 1;
      if (kind === 0) sheets.push({ name: readText(record.data, 8, length, wide), offset: view.getUint32(0, true) });
    }
    if (record.id === 0x000a) break;
  }
  if (sharedSegments) strings = readSharedStrings(sharedSegments);

  return sheets.map(({ name, offset }) => {
    const rows: string[][] = [];
    const put = (row: number, column: number, value: string) => { (rows[row] ??= [])[column] = value.trim(); };
    let depth = 0;
    let pendingFormula: { row: number; column: number } | null = null;
    for (const record of records(stream, offset)) {
      const data = record.data;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (record.id === 0x0809) { depth++; continue; }
      if (record.id === 0x000a) { if (--depth <= 0) break; continue; }
      if (depth !== 1) continue;
      switch (record.id) {
        case 0x00fd: put(view.getUint16(0, true), view.getUint16(2, true), strings[view.getUint32(6, true)] ?? ''); break;
        case 0x0204: {
          const length = view.getUint16(6, true);
          const wide = (data[8] & 1) === 1;
          put(view.getUint16(0, true), view.getUint16(2, true), readText(data, 9, length, wide));
          break;
        }
        case 0x0203: put(view.getUint16(0, true), view.getUint16(2, true), numberText(view.getFloat64(6, true))); break;
        case 0x027e: put(view.getUint16(0, true), view.getUint16(2, true), numberText(decodeRk(view.getUint32(6, true)))); break;
        case 0x00bd: {
          const row = view.getUint16(0, true);
          const first = view.getUint16(2, true);
          const last = view.getUint16(data.length - 2, true);
          for (let column = first; column <= last; column++) put(row, column, numberText(decodeRk(view.getUint32(4 + (column - first) * 6 + 2, true))));
          break;
        }
        case 0x0006: {
          const row = view.getUint16(0, true);
          const column = view.getUint16(2, true);
          if (view.getUint16(12, true) === 0xffff && data[6] === 0) pendingFormula = { row, column };
          else { pendingFormula = null; put(row, column, numberText(view.getFloat64(6, true))); }
          break;
        }
        case 0x0207:
          if (pendingFormula) {
            const length = view.getUint16(0, true);
            put(pendingFormula.row, pendingFormula.column, readText(data, 3, length, (data[2] & 1) === 1));
            pendingFormula = null;
          }
          break;
        default: break;
      }
    }
    return { name, rows };
  });
}
