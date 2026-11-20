'use strict';
/**
 * xlsx.js — 零依赖 Excel (.xlsx) 读写
 *
 * xlsx 本质是个 zip 容器，里面放几个 XML。这里用 Node 内置 zlib 手写 zip，
 * 不引入任何 npm 依赖 —— 保证「拷贝到其它机器直接能用」。
 *
 * 写入用 inlineStr（内联字符串），避免 sharedStrings 部件，读起来更简单。
 * 读取支持 inlineStr 与 sharedStrings 两种（Excel 存出来的一般是后者）。
 *
 * 只支持「单表、纯文本/数值」——足够放账号列表。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- CRC32

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------------------------------------------------------------- ZIP 写

/**
 * 写一个 zip 文件
 * @param {Array<{name:string, data:Buffer|string}>} entries
 * @param {string} outPath
 */
function writeZip(entries, outPath) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 6 });
    const useStore = compressed.length >= data.length;
    const payload = useStore ? data : compressed;
    const method = useStore ? 0 : 8;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flags: UTF-8 name
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);          // mod time
    local.writeUInt16LE(0x21, 12);       // mod date (1996-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat([...chunks, cdBuf, end]));
}

// ---------------------------------------------------------------- ZIP 读

/** 读 zip，返回 { name: Buffer } 映射 */
function readZip(buf) {
  const out = {};
  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/xlsx 文件');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // 定位 local header 的数据起始
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    out[name] = method === 0 ? raw : zlib.inflateRawSync(raw);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------------------------------------------------------------- XML

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/** 列名 → 列字母：A, B, ... Z, AA, AB ... */
function colName(n) {
  let s = '';
  n += 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 列字母 → 0 基列号 */
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ---------------------------------------------------------------- 写

/**
 * 写一个单表 xlsx
 * @param {string} outPath
 * @param {string[]} headers 表头
 * @param {Array<Array<string|number>>} rows
 * @param {string} [sheetName]
 */
function write(outPath, headers, rows, sheetName = 'Sheet1') {
  const safeName = String(sheetName).replace(/[\\/?*\[\]:]/g, '_').slice(0, 31) || 'Sheet1';

  const cellXml = (rowIdx, colIdx, value) => {
    const ref = `${colName(colIdx)}${rowIdx}`;
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'number' && Number.isFinite(value)) {
      return `<c r="${ref}"><v>${value}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
  };

  const all = [headers, ...rows];
  const sheetRows = all.map((row, ri) => {
    const cells = row.map((v, ci) => cellXml(ri + 1, ci, v)).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(safeName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

  writeZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ], outPath);
}

// ---------------------------------------------------------------- 读

/**
 * 读 xlsx 的第一张表
 * @param {string} filePath
 * @returns {{headers:string[], rows:string[][]}}
 */
function read(filePath) {
  const zip = readZip(fs.readFileSync(filePath));

  // sharedStrings（如果存在）
  const shared = [];
  if (zip['xl/sharedStrings.xml']) {
    const xml = zip['xl/sharedStrings.xml'].toString('utf8');
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(xml))) {
      const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unesc(x[1]));
      shared.push(parts.join(''));
    }
  }

  // 找第一张 sheet
  let sheetXml = zip['xl/worksheets/sheet1.xml'];
  if (!sheetXml) {
    const key = Object.keys(zip).find((k) => /^xl\/worksheets\/.*\.xml$/.test(k));
    if (!key) throw new Error('xlsx 里没有工作表');
    sheetXml = zip[key];
  }
  const xml = sheetXml.toString('utf8');

  const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  const allRows = [];
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = {};
    const cellRe = /<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g;
    let cm;
    while ((cm = cellRe.exec(rm[2]))) {
      const attrs = cm[1] || cm[3] || '';
      const body = cm[2] || '';
      const refM = /r="([A-Z]+\d+)"/.exec(attrs);
      const typeM = /t="([^"]+)"/.exec(attrs);
      const ref = refM ? refM[1] : 'A1';
      const ci = colIndex(ref);
      const type = typeM ? typeM[1] : 'n';

      let val = '';
      if (type === 'inlineStr') {
        val = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unesc(x[1])).join('');
      } else if (type === 's') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        const idx = v ? parseInt(v[1], 10) : -1;
        val = idx >= 0 && idx < shared.length ? shared[idx] : '';
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        val = v ? unesc(v[1]) : '';
      }
      cells[ci] = val;
    }
    allRows.push({ r: parseInt(rm[1], 10), cells });
  }

  allRows.sort((a, b) => a.r - b.r);
  if (!allRows.length) return { headers: [], rows: [] };

  const toArr = (row) => {
    const max = Object.keys(row.cells).length ? Math.max(...Object.keys(row.cells).map(Number)) : 0;
    const arr = [];
    for (let i = 0; i <= max; i++) arr.push(row.cells[i] ?? '');
    return arr;
  };

  const headers = toArr(allRows[0]).map((h) => String(h).trim());
  const rows = allRows.slice(1).map(toArr);
  return { headers, rows };
}

function unesc(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

module.exports = { write, read, crc32, writeZip, readZip, colName, colIndex };
