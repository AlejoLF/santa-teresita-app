/**
 * Genera los íconos PWA de Santa Teresita en `public/` SIN dependencias externas.
 *
 * Por qué a mano: el repo no tiene sharp/canvas/resvg instalados y no queremos
 * sumar deps nativas solo para 4 PNGs estáticos. Acá hay un encoder PNG mínimo
 * (RGBA, filtro 0 por scanline, IDAT vía zlib del runtime) + un "rasterizador"
 * trivial que dibuja el monograma "T" de Teresita sobre verde.
 *
 * Salida:
 *   - icon-192.png            (rounded, purpose any)
 *   - icon-512.png            (rounded, purpose any)
 *   - icon-maskable-512.png   (full-bleed verde, T dentro de la safe-zone)
 *   - apple-touch-icon.png    (180, full square — iOS redondea solo)
 *
 * Correr: `node apps/mobile/scripts/gen-icons.mjs`
 */

import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '..', 'public');

// Paleta de marca (verde Teresita + cremoso).
const VERDE = [0x1f, 0x4d, 0x3c, 0xff]; // #1f4d3c (theme_color)
const VERDE_OSCURO = [0x16, 0x3a, 0x2d, 0xff]; // un poco más oscuro p/ profundidad sutil
const CREMA = [0xf3, 0xea, 0xd8, 0xff]; // #f3ead8
const TRANSP = [0, 0, 0, 0];

// ── CRC32 (tabla) ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** rgba: Uint8Array de size*size*4. Devuelve el Buffer PNG. */
function encodePng(rgba, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Scanlines con byte de filtro 0 al inicio de cada fila.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgba.copy
      ? rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
      : Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function blend(dst, i, color) {
  // color es [r,g,b,a]; si a=255 sobreescribe. Acá solo usamos opaco o transparente.
  dst[i] = color[0];
  dst[i + 1] = color[1];
  dst[i + 2] = color[2];
  dst[i + 3] = color[3];
}

/**
 * Dibuja el ícono.
 * @param size lado en px
 * @param opts.rounded radio relativo de esquina (0 = cuadrado lleno)
 * @param opts.monoScale escala del monograma (1 = base; <1 para maskable safe-zone)
 */
function drawIcon(size, { rounded = 0, monoScale = 1 } = {}) {
  const px = new Uint8Array(size * size * 4);
  const r = rounded * size; // radio de esquina en px
  const cx = size / 2;

  // Fondo: verde con un degradé vertical muy sutil (arriba más claro).
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // ¿dentro del rounded-rect?
      let dentro = true;
      if (r > 0) {
        // esquinas
        const corners = [
          [r, r],
          [size - r, r],
          [r, size - r],
          [size - r, size - r],
        ];
        const inCornerBox =
          (x < r || x > size - r) && (y < r || y > size - r);
        if (inCornerBox) {
          // chequear distancia al centro de la esquina correspondiente
          const ccx = x < r ? r : size - r;
          const ccy = y < r ? r : size - r;
          const dx = x + 0.5 - ccx;
          const dy = y + 0.5 - ccy;
          dentro = dx * dx + dy * dy <= r * r;
        }
      }
      if (!dentro) {
        blend(px, i, TRANSP);
        continue;
      }
      // degradé sutil: mezcla verde→verde_oscuro según y
      const t = y / size;
      const col = [
        Math.round(VERDE[0] * (1 - t) + VERDE_OSCURO[0] * t),
        Math.round(VERDE[1] * (1 - t) + VERDE_OSCURO[1] * t),
        Math.round(VERDE[2] * (1 - t) + VERDE_OSCURO[2] * t),
        0xff,
      ];
      blend(px, i, col);
    }
  }

  // Monograma "T" en crema, centrado. Geometría relativa al tamaño y monoScale.
  const s = monoScale;
  // Barra horizontal superior
  const barX0 = cx - 0.24 * size * s;
  const barX1 = cx + 0.24 * size * s;
  const barY0 = (0.5 - 0.2 * s) * size;
  const barY1 = (0.5 - 0.1 * s) * size;
  // Tronco vertical
  const stemX0 = cx - 0.05 * size * s;
  const stemX1 = cx + 0.05 * size * s;
  const stemY0 = barY0;
  const stemY1 = (0.5 + 0.22 * s) * size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (px[i + 3] === 0) continue; // no pintar fuera del rounded-rect
      const xc = x + 0.5;
      const yc = y + 0.5;
      const enBarra = xc >= barX0 && xc <= barX1 && yc >= barY0 && yc <= barY1;
      const enTronco = xc >= stemX0 && xc <= stemX1 && yc >= stemY0 && yc <= stemY1;
      if (enBarra || enTronco) blend(px, i, CREMA);
    }
  }

  return Buffer.from(px.buffer);
}

function write(name, size, opts) {
  const rgba = drawIcon(size, opts);
  const png = encodePng(rgba, size);
  const out = path.join(PUBLIC, name);
  fs.writeFileSync(out, png);
  console.log(`  ✓ ${name} (${size}px, ${(png.length / 1024).toFixed(1)} KB)`);
}

function main() {
  fs.mkdirSync(PUBLIC, { recursive: true });
  console.log('Generando íconos PWA en', PUBLIC);
  write('icon-192.png', 192, { rounded: 0.22, monoScale: 1 });
  write('icon-512.png', 512, { rounded: 0.22, monoScale: 1 });
  // maskable: full-bleed, T dentro de safe-zone (~72%)
  write('icon-maskable-512.png', 512, { rounded: 0, monoScale: 0.72 });
  // apple-touch: cuadrado lleno (iOS redondea), sin transparencia
  write('apple-touch-icon.png', 180, { rounded: 0, monoScale: 1 });
  console.log('Listo.');
}

main();
