/**
 * Minimal .xlsx reader for the data-file phase: lists each worksheet's first
 * `keep` non-blank rows as strings, plus its non-blank row count. Built on
 * node:zlib (no dependency); handles plain zip archives (no zip64, no
 * encryption) — anything else returns null and the workbook gets no columns.
 *
 * Input is untrusted: only the parts used are inflated, under one shared byte
 * budget, and XML is scanned by splitting on closing tags so a malformed file
 * costs linear time.
 */

import { inflateRawSync } from 'node:zlib';

/**
 * Inflated bytes allowed across all parts of one workbook. A zip bomb (or
 * many directory entries pointing at one bomb) runs out of budget instead of
 * memory; a part past the budget is treated as missing.
 */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

export interface SheetRows {
  name: string;
  records: string[][];
  total: number;
}

/** Lazy reader over the zip's entries; each part is inflated at most once. */
const readZipIndex = (buf: Buffer): ((name: string) => string | undefined) | null => {
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
  const index = new Map<string, { method: number; start: number; size: number }>();
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
    index.set(name, { method, start, size });
  }

  let budget = MAX_INFLATED_BYTES;
  const cache = new Map<string, string | undefined>();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    const entry = index.get(name);
    let out: Buffer | undefined;
    if (entry && budget > 0) {
      const raw = buf.subarray(entry.start, entry.start + entry.size);
      try {
        if (entry.method === 0 && raw.length <= budget) out = raw;
        else if (entry.method === 8) out = inflateRawSync(raw, { maxOutputLength: budget });
      } catch {
        budget = 0; // corrupt stream or past the budget: inflate nothing more
      }
    }
    if (out) budget -= out.length;
    const text = out?.toString('utf8');
    cache.set(name, text);
    return text;
  };
};

/**
 * Attributes and body of each `<tag ...>body</tag>` element. Splitting on the
 * closing tag keeps a missing closer to one linear pass, not a rescan per
 * opener. Self-closing siblings carry no body and are skipped.
 */
const elementBodies = (xml: string, tag: string): { attrs: string; body: string }[] => {
  const out: { attrs: string; body: string }[] = [];
  const parts = xml.split(`</${tag}>`);
  for (let i = 0; i < parts.length - 1; i++) {
    const chunk = parts[i];
    let open = chunk.lastIndexOf(`<${tag}`);
    // `<c` also prefixes `<col`: the tag name must end right after it.
    while (open >= 0 && /[\w:.-]/.test(chunk[open + tag.length + 1] ?? '')) {
      open = open === 0 ? -1 : chunk.lastIndexOf(`<${tag}`, open - 1);
    }
    if (open < 0) continue;
    const close = chunk.indexOf('>', open);
    if (close < 0) continue;
    out.push({ attrs: chunk.slice(open + tag.length + 1, close), body: chunk.slice(close + 1) });
  }
  return out;
};

/** Attribute text of each `<tag ...>` or `<tag .../>` opener (bounded length). */
const openerAttrs = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<${tag}\\b([^>]{0,4096})>`, 'g'))].map((m) => m[1]);

const decodeXml = (s: string): string =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (named[e.toLowerCase()]) return named[e.toLowerCase()];
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });

/** Concatenated text of every `<t>` run (plain and rich-text), minus phonetic (`<rPh>`) runs. */
const textRuns = (xml: string): string => {
  // Keep the text before each `<rPh` whose `</rPh>` closes the part.
  const parts = xml.split('</rPh>');
  const visible = parts
    .map((part, i) => {
      if (i === parts.length - 1) return part;
      const open = part.indexOf('<rPh');
      return open < 0 ? part : part.slice(0, open);
    })
    .join('');
  let out = '';
  for (const m of visible.matchAll(/<t(?:\s[^>]{0,256})?>([^<]*)<\/t>/g)) out += m[1];
  return decodeXml(out);
};

const attr = (attrs: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]{0,1024})"`).exec(attrs)?.[1];

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
  for (const row of elementBodies(xml, 'row')) {
    const cells: string[] = [];
    let next = 0;
    let hasContent = false;
    for (const c of elementBodies(row.body, 'c')) {
      const ref = attr(c.attrs, 'r');
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      const type = attr(c.attrs, 't');
      let value: string;
      if (type === 'inlineStr') value = textRuns(c.body);
      else {
        const v = /<v>([^<]*)<\/v>/.exec(c.body)?.[1];
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
  const read = readZipIndex(buf);
  const workbook = read?.('xl/workbook.xml');
  if (!read || !workbook) return null;

  const targets = new Map<string, string>();
  for (const attrs of openerAttrs(read('xl/_rels/workbook.xml.rels') ?? '', 'Relationship')) {
    const id = attr(attrs, 'Id');
    const target = attr(attrs, 'Target');
    if (id && target) {
      targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    }
  }

  const shared = elementBodies(read('xl/sharedStrings.xml') ?? '', 'si').map((si) =>
    textRuns(si.body),
  );

  const sheets: SheetRows[] = [];
  for (const attrs of openerAttrs(workbook, 'sheet')) {
    const rid = attr(attrs, 'r:id');
    const target = rid ? targets.get(rid) : undefined;
    const xml = target ? read(target) : undefined;
    if (!xml) continue; // chartsheet, missing part, or past the inflate budget
    sheets.push({ name: decodeXml(attr(attrs, 'name') ?? ''), ...readSheet(xml, shared, keep) });
  }
  return sheets;
};
