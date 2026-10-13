/**
 * Minimal .xlsx reader for the data-file phase: lists each worksheet's first
 * `keep` non-blank rows as strings, plus its non-blank row count. Built on
 * node:zlib (no dependency); handles plain zip archives (no zip64, no
 * encryption) — anything else returns null and the workbook gets no columns.
 */

import { inflateRawSync } from 'node:zlib';

/** Per-entry inflate cap: a zip bomb throws instead of exhausting memory. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export interface SheetRows {
  name: string;
  records: string[][];
  total: number;
}

const readZipEntries = (buf: Buffer): Map<string, Buffer> | null => {
  // End of central directory: 22 bytes plus a comment of up to 64 KiB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return null;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (method === 0) entries.set(name, raw);
    else if (method === 8)
      entries.set(name, inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }));
  }
  return entries;
};

const decodeXml = (s: string): string =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (named[e.toLowerCase()]) return named[e.toLowerCase()];
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });

/** Concatenated text of every `<t>` run (plain and rich-text), minus phonetic (`<rPh>`) runs. */
const textRuns = (xml: string): string => {
  let out = '';
  const visible = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  for (const m of visible.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) out += m[1];
  return decodeXml(out);
};

const attr = (attrs: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];

/** "AB12" -> 27 (zero-based column index). */
const columnIndex = (ref: string): number => {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
};

const readSheet = (
  xml: string,
  shared: string[],
  keep: number,
): { records: string[][]; total: number } => {
  const records: string[][] = [];
  let total = 0;
  for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: string[] = [];
    let next = 0;
    let hasContent = false;
    for (const c of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1], 'r');
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      const body = c[2] ?? '';
      const type = attr(c[1], 't');
      let value: string;
      if (type === 'inlineStr') value = textRuns(body);
      else {
        const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
        if (v === undefined) continue;
        value = type === 's' ? (shared[Number(v)] ?? '') : decodeXml(v);
      }
      if (value === '') continue;
      hasContent = true;
      if (records.length < keep && col >= 0 && col < 16384) {
        while (cells.length < col) cells.push('');
        cells[col] = value;
      }
    }
    if (!hasContent) continue;
    if (records.length < keep) records.push(cells);
    total++;
  }
  return { records, total };
};

/** Worksheets in workbook order, or null when the file is not a readable .xlsx. */
export const readXlsxSheets = (buf: Buffer, keep: number): SheetRows[] | null => {
  let entries: Map<string, Buffer> | null;
  try {
    entries = readZipEntries(buf);
  } catch {
    return null; // corrupt deflate stream or an entry past MAX_ENTRY_BYTES
  }
  const workbook = entries?.get('xl/workbook.xml')?.toString('utf8');
  if (!entries || !workbook) return null;

  const targets = new Map<string, string>();
  const rels = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) {
      targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    }
  }

  const sharedXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1]));

  const sheets: SheetRows[] = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const rid = attr(m[1], 'r:id');
    const target = rid ? targets.get(rid) : undefined;
    const xml = target ? entries.get(target)?.toString('utf8') : undefined;
    if (!xml) continue; // chartsheet or missing part
    sheets.push({ name: decodeXml(attr(m[1], 'name') ?? ''), ...readSheet(xml, shared, keep) });
  }
  return sheets;
};
