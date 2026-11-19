/** CSV and Excel (.xlsx) writers with no dependencies. */
import { crc32, deflateRawSync } from 'node:zlib';

export type Cell = string | number | boolean | Date | null | undefined;

const csvCell = (v: Cell): string => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formulas in text cells (CSV injection).
  const safe = /^[=+\-@\t\r]/.test(s) && typeof v === 'string' ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(headers: string[], rows: Cell[][]): string {
  return '﻿' + [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}

const xml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const colName = (i: number) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
// Excel serial date (days since 1899-12-30), shown with the date-time style.
const serial = (d: Date) => d.getTime() / 86_400_000 + 25569;

function sheetXml(headers: string[], rows: Cell[][]): string {
  const cell = (v: Cell, ref: string, header = false): string => {
    if (v === null || v === undefined || v === '') return '';
    if (header) return `<c r="${ref}" t="inlineStr" s="1"><is><t>${xml(String(v))}</t></is></c>`;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : `<c r="${ref}" s="2"><v>${serial(v)}</v></c>`;
    if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${ref}"><v>${v}</v></c>` : '';
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(String(v).slice(0, 32_000))}</t></is></c>`;
  };
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`);
  out.push(`<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`);
  out.push(`<cols>${headers.map((h, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(Math.max(h.length + 4, 12), 40)}" customWidth="1"/>`).join('')}</cols><sheetData>`);
  out.push(`<row r="1">${headers.map((h, i) => cell(h, `${colName(i)}1`, true)).join('')}</row>`);
  rows.forEach((r, ri) => out.push(`<row r="${ri + 2}">${r.map((v, ci) => cell(v, `${colName(ci)}${ri + 2}`)).join('')}</row>`));
  out.push(`</sheetData>${rows.length ? `<autoFilter ref="A1:${colName(headers.length - 1)}${rows.length + 1}"/>` : ''}</worksheet>`);
  return out.join('');
}

function zip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const deflated = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, deflated);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(deflated.length, 20); c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36); c.writeUInt32LE(0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + deflated.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cd, end]);
}

/** One or more sheets → .xlsx bytes. */
export function toXlsx(sheets: { name: string; headers: string[]; rows: Cell[][] }[]): Buffer {
  const b = (s: string) => Buffer.from(s, 'utf8');
  const names = sheets.map((s, i) => xml(s.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${i + 1}`));
  const files = [
    { name: '[Content_Types].xml', data: b(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`) },
    { name: '_rels/.rels', data: b(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: b(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: b(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/styles.xml', data: b(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`) },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: b(sheetXml(s.headers, s.rows)) })),
  ];
  return zip(files);
}

/** A zip of arbitrary files (registry evidence packages). */
export const toZip = zip;
