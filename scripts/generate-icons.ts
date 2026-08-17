/**
 * Renders the PWA icon set from the same path data as web/src/Logo.tsx.
 *
 * Run with `yarn icons`. The output is checked in, because a build should not
 * need a rasteriser installed; re-run it if the mark ever changes.
 *
 * WHY THIS IS HAND-ROLLED. An installable app needs PNGs — Android's launcher
 * and iOS's home screen will not take the SVG the manifest already lists — and
 * every way of producing them has a cost:
 *
 *   - `sharp` / `canvas`: a native build in the dependency tree of an app whose
 *     entire server is Hono + SQLite, pulled in for four files that change
 *     roughly never.
 *   - `rsvg-convert` / ImageMagick: not installed here, and "the icons are
 *     stale because your machine lacks a package" is a bad failure mode.
 *   - Drawing the icons separately by hand: two copies of the mark, and the
 *     copy nobody looks at is the one that goes wrong.
 *
 * So the mark's three paths are the single source of truth and this file turns
 * them into pixels: a cubic-bezier flattener, a scanline fill, and a PNG
 * encoder over node:zlib. Nothing here is general-purpose — it handles the
 * subset of SVG the mark actually uses (absolute M, C and Z) and refuses
 * anything else rather than guessing.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../web/public/app/icons");

// ---------------------------------------------------------------------------
// The mark
// ---------------------------------------------------------------------------
//
// Copied verbatim from web/src/Logo.tsx (viewBox 0 0 200 200). The colours are
// literal rather than CSS variables for the same reason web/public/favicon.svg
// spells them out: a launcher icon has no page to inherit a theme from.

const PLATE = "#0E1214";
const BRIGHT = "#58DBBE";
const DEEP = "#1A9788";

const MARK: Array<{ d: string; fill: string }> = [
  {
    d: "M176.706 132.159C164.072 169.564 125.48 192.884 85.588 185.319C66.1606 181.635 49.7007 171.248 38.1499 157.006L176.706 132.159Z",
    fill: BRIGHT,
  },
  {
    d: "M177.266 77.4246C180.794 89.3118 181.617 102.195 179.148 115.217C178.491 118.68 177.62 122.048 176.554 125.311L25.8112 130.829C20.0619 116.891 18.1614 101.18 21.1799 85.2622C21.6269 82.9052 22.1732 80.5922 22.8124 78.3261L177.266 77.4246Z",
    fill: DEEP,
  },
  {
    d: "M116.765 14.9607C139.236 19.2218 157.736 32.4516 169.262 50.242L24.7196 71.0486C36.2866 31.9415 75.8419 7.20066 116.765 14.9607Z",
    fill: BRIGHT,
  },
];

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** A closed contour, as a flat run of x,y pairs in device space. */
type Contour = number[];

/**
 * Flattens `d` into closed contours.
 *
 * Absolute M / C / Z only. That is what the mark uses, and a parser that
 * silently ignored a command it did not understand would produce a subtly wrong
 * icon rather than an error.
 */
function parsePath(d: string, transform: (x: number, y: number) => [number, number]): Contour[] {
  const tokens = d.match(/[MCZmczLl]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const contours: Contour[] = [];
  let current: Contour = [];
  let cx = 0;
  let cy = 0;
  let i = 0;

  const push = (x: number, y: number) => {
    const [dx, dy] = transform(x, y);
    current.push(dx, dy);
  };

  const number = (): number => {
    const value = Number(tokens[i++]);
    if (Number.isNaN(value)) throw new Error(`Expected a number in path data, got ${tokens[i - 1]}`);
    return value;
  };

  while (i < tokens.length) {
    const command = tokens[i++]!;
    switch (command) {
      case "M": {
        if (current.length > 0) contours.push(current);
        current = [];
        cx = number();
        cy = number();
        push(cx, cy);
        break;
      }
      case "L": {
        cx = number();
        cy = number();
        push(cx, cy);
        break;
      }
      case "C": {
        const x1 = number();
        const y1 = number();
        const x2 = number();
        const y2 = number();
        const x = number();
        const y = number();
        // 24 segments per curve. At 512px the mark's curves span a few hundred
        // pixels, so this is well under half a pixel of chord error and the
        // supersampling below hides the rest.
        const steps = 24;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const u = 1 - t;
          push(
            u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
            u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y,
          );
        }
        cx = x;
        cy = y;
        break;
      }
      case "Z":
      case "z": {
        if (current.length > 0) contours.push(current);
        current = [];
        break;
      }
      default:
        throw new Error(
          `generate-icons only understands absolute M, L, C and Z; found "${command}". ` +
            "Re-export the mark with absolute commands rather than teaching this a new one.",
        );
    }
  }

  if (current.length > 0) contours.push(current);
  return contours;
}

/** A rounded rectangle, as one contour. Used for the plate under the mark. */
function roundedRect(w: number, h: number, r: number): Contour[] {
  if (r <= 0) return [[0, 0, w, 0, w, h, 0, h]];

  const contour: Contour = [];
  const arc = (cx: number, cy: number, from: number, to: number) => {
    const steps = 16;
    for (let s = 0; s <= steps; s++) {
      const a = from + ((to - from) * s) / steps;
      contour.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
  };

  const half = Math.PI / 2;
  arc(w - r, h - r, 0, half);
  arc(r, h - r, half, Math.PI);
  arc(r, r, Math.PI, Math.PI + half);
  arc(w - r, r, Math.PI + half, 2 * Math.PI);
  return [contour];
}

/**
 * Per-pixel coverage of a filled shape, 0..1, nonzero winding.
 *
 * Exact horizontally (each span contributes its real overlap with the pixel)
 * and 4x supersampled vertically, which is more than enough for an icon and
 * avoids a full 16x sample grid.
 */
function rasterise(contours: Contour[], size: number): Float32Array {
  const coverage = new Float32Array(size * size);
  const subRows = 4;

  type Edge = { x0: number; y0: number; x1: number; y1: number; winding: number };
  const edges: Edge[] = [];

  for (const contour of contours) {
    const points = contour.length / 2;
    for (let p = 0; p < points; p++) {
      const ax = contour[p * 2]!;
      const ay = contour[p * 2 + 1]!;
      const q = (p + 1) % points;
      const bx = contour[q * 2]!;
      const by = contour[q * 2 + 1]!;
      if (ay === by) continue; // horizontal edges never cross a scanline
      edges.push(
        ay < by
          ? { x0: ax, y0: ay, x1: bx, y1: by, winding: 1 }
          : { x0: bx, y0: by, x1: ax, y1: ay, winding: -1 },
      );
    }
  }

  const crossings: Array<{ x: number; winding: number }> = [];

  for (let row = 0; row < size; row++) {
    for (let sub = 0; sub < subRows; sub++) {
      const y = row + (sub + 0.5) / subRows;
      crossings.length = 0;

      for (const e of edges) {
        if (y < e.y0 || y >= e.y1) continue;
        crossings.push({
          x: e.x0 + ((y - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0),
          winding: e.winding,
        });
      }

      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a.x - b.x);

      let winding = 0;
      for (let c = 0; c < crossings.length - 1; c++) {
        winding += crossings[c]!.winding;
        if (winding === 0) continue;

        const spanStart = Math.max(0, crossings[c]!.x);
        const spanEnd = Math.min(size, crossings[c + 1]!.x);
        if (spanEnd <= spanStart) continue;

        const first = Math.floor(spanStart);
        const last = Math.min(size - 1, Math.ceil(spanEnd) - 1);
        for (let px = first; px <= last; px++) {
          const overlap = Math.min(spanEnd, px + 1) - Math.max(spanStart, px);
          if (overlap <= 0) continue;
          const at = row * size + px;
          coverage[at] = coverage[at]! + overlap / subRows;
        }
      }
    }
  }

  return coverage;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** 8-bit RGBA, filter 0 on every scanline. No interlacing, no palette. */
function encodePng(rgba: Uint8Array, size: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let row = 0; row < size; row++) {
    raw[row * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + row * stride, stride).copy(
      raw,
      row * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Source-over, premultiplied by coverage, straight into an RGBA buffer. */
function composite(target: Uint8Array, coverage: Float32Array, colour: string): void {
  const [r, g, b] = rgb(colour);
  for (let i = 0; i < coverage.length; i++) {
    const a = Math.min(1, coverage[i]!);
    if (a <= 0) continue;
    const o = i * 4;
    target[o] = Math.round(r * a + target[o]! * (1 - a));
    target[o + 1] = Math.round(g * a + target[o + 1]! * (1 - a));
    target[o + 2] = Math.round(b * a + target[o + 2]! * (1 - a));
    target[o + 3] = Math.round(255 * a + target[o + 3]! * (1 - a));
  }
}

/**
 * One icon.
 *
 * `markScale` is the mark's width as a fraction of the canvas. `cornerRadius`
 * is a fraction too, and is 0 for the maskable and Apple variants: both of
 * those get masked by the platform, and a plate that has already been rounded
 * shows as a pale halo inside the platform's own rounding.
 */
function renderIcon(size: number, markScale: number, cornerRadius: number): Buffer {
  const rgba = new Uint8Array(size * size * 4); // transparent

  composite(rgba, rasterise(roundedRect(size, size, size * cornerRadius), size), PLATE);

  const scale = (size * markScale) / 200;
  const offset = (size - 200 * scale) / 2;
  const transform = (x: number, y: number): [number, number] => [
    offset + x * scale,
    offset + y * scale,
  ];

  for (const shape of MARK) {
    composite(rgba, rasterise(parsePath(shape.d, transform), size), shape.fill);
  }

  return encodePng(rgba, size);
}

// ---------------------------------------------------------------------------

/**
 * The set the manifest and app.html ask for.
 *
 * 192 and 512 are what Chrome wants for an installable app; the maskable one is
 * full-bleed with the mark inside the inner 80% Android will not crop; the
 * Apple one is 180 and square, because iOS rounds it itself.
 */
const ICONS: Array<{ file: string; size: number; markScale: number; cornerRadius: number }> = [
  { file: "icon-192.png", size: 192, markScale: 0.66, cornerRadius: 0.234 },
  { file: "icon-512.png", size: 512, markScale: 0.66, cornerRadius: 0.234 },
  { file: "icon-maskable-512.png", size: 512, markScale: 0.5, cornerRadius: 0 },
  { file: "apple-touch-icon.png", size: 180, markScale: 0.64, cornerRadius: 0 },
];

mkdirSync(outDir, { recursive: true });

for (const icon of ICONS) {
  const png = renderIcon(icon.size, icon.markScale, icon.cornerRadius);
  writeFileSync(resolve(outDir, icon.file), png);
  console.log(`  ${icon.file.padEnd(24)} ${icon.size}x${icon.size}  ${png.length} bytes`);
}

console.log(`Wrote ${ICONS.length} icons to web/public/app/icons/`);
