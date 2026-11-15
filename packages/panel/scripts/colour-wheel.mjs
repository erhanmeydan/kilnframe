// Draws public/icons/colour-wheel.png, the Captions colour picker's wheel: hue round the circle, saturation
// from the white middle to the edge, at the brightness of WHEEL_VALUE. The panel turns a click into a colour
// with the same mapping (wheelColour in src/captions.ts), so the two must change together.
// Run: node scripts/colour-wheel.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZE = 224;
const WHEEL_VALUE = 0.9;

function hsv(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)].map((c) => Math.round(c * 255));
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
const r0 = SIZE / 2;
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE; x++) {
    const dx = x + 0.5 - r0;
    const dy = y + 0.5 - r0;
    const d = Math.hypot(dx, dy);
    const i = y * (SIZE * 4 + 1) + 1 + x * 4;
    // a soft one-pixel edge
    const alpha = Math.max(0, Math.min(1, r0 - d));
    if (alpha === 0) continue;
    const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    const [r, g, b] = hsv(h, Math.min(d / r0, 1), WHEEL_VALUE);
    raw[i] = r;
    raw[i + 1] = g;
    raw[i + 2] = b;
    raw[i + 3] = Math.round(alpha * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(new URL("../public/icons/colour-wheel.png", import.meta.url), png);
console.log(`colour-wheel.png ${png.length} bytes`);
