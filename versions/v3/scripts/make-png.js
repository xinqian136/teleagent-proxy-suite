#!/usr/bin/env node
/**
 * make-png.js — 零依赖生成测试用 PNG
 *
 * 手写 PNG 编码（zlib deflate + CRC32），不依赖任何图形库。
 * 用途：测网关的多模态能力时需要一张内容确定的图。
 *
 * 用法: node scripts/make-png.js [输出路径]
 * 生成：160x120，左半红、右半绿、中间一条白色横杠
 */
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function makePng(w, h, pixelFn) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixelFn(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png = makePng(160, 120, (x, y) => {
  if (y > 55 && y < 65 && x > 20 && x < 140) return [255, 255, 255];
  return x < 80 ? [220, 20, 20] : [20, 180, 60];
});

const out = process.argv[2] || path.join(__dirname, 'test-image.png');
fs.writeFileSync(out, png);
console.log('已生成', out, png.length, '字节');
