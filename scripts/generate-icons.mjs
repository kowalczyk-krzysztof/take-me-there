// Generates placeholder extension icons (16, 48, 128 px) with zero
// dependencies: a slate rounded square with a cream location ring.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

const icon = (size) => {
  const bg = [38, 54, 68, 255];
  const cream = [240, 235, 220, 255];
  const transparent = [0, 0, 0, 0];
  const corner = size * 0.22;
  const dotR = size * 0.3;
  const holeR = size * 0.12;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0;
    for (let x = 0; x < size; x += 1) {
      const nx = x + 0.5;
      const ny = y + 0.5;
      // Rounded-rectangle mask via a clamped distance field.
      const px = Math.abs(nx - size / 2) - (size / 2 - corner);
      const py = Math.abs(ny - size / 2) - (size / 2 - corner);
      const outside =
        Math.hypot(Math.max(px, 0), Math.max(py, 0)) + Math.min(Math.max(px, py), 0) - corner;
      const dc = Math.hypot(nx - size / 2, ny - size / 2);
      let pixel = transparent;
      if (outside <= 0) {
        pixel = bg;
        if (dc <= dotR && dc >= holeR) {
          pixel = cream;
        }
      }
      row.set(pixel, 1 + x * 4);
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor with alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

for (const size of [16, 48, 128]) {
  writeFileSync(path.join(outDir, `${size}.png`), icon(size));
  console.log(`wrote public/icons/${size}.png`);
}
