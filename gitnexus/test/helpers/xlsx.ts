import { deflateRawSync } from 'node:zlib';

/** Minimal .xlsx writer: deflated zip entries, no zip64. */
export const makeXlsx = (
  sheets: Record<string, string>,
  extra: Record<string, string> = {},
): Buffer => {
  const names = Object.keys(sheets);
  const files: Record<string, string> = {
    'xl/workbook.xml': `<workbook xmlns:r="r"><sheets>${names
      .map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships>${names
      .map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('')}</Relationships>`,
    ...Object.fromEntries(
      names.map((n, i) => [
        `xl/worksheets/sheet${i + 1}.xml`,
        `<worksheet><sheetData>${sheets[n]}</sheetData></worksheet>`,
      ]),
    ),
    ...extra,
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
};
