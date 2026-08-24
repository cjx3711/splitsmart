/**
 * Geometric profile images: a base colour plus stacked chord bands.
 *
 * PURE. The browser paints these from the stored numbers (or a hash of the
 * user id when nothing is stored). There is no image file, no upload, and
 * nothing financial reads this.
 *
 * A band is a rotated linear-gradient strip: percent start, percent end,
 * rotation, and HSLA. Overlapping semi-transparent bands of a related palette
 * are what make the polygonal Splitwise-style look.
 */

export const MAX_AVATAR_LAYERS = 10;

export type AvatarHsla = {
  /** 0–360 */
  h: number;
  /** 0–100 */
  s: number;
  /** 0–100 */
  l: number;
  /** 0–1 */
  a: number;
};

export type AvatarLayer = AvatarHsla & {
  /** 0–100 along the disc diameter (the visible axis), not the square's diagonal. */
  start: number;
  /** 0–100, greater than start. */
  end: number;
  /** 0–360 degrees. */
  rotation: number;
};

export type AvatarPattern = {
  base: AvatarHsla;
  /** When set, the base is a linear gradient to this colour. */
  baseEnd?: AvatarHsla;
  /** Gradient angle for the base. Ignored without baseEnd. */
  baseRotation?: number;
  /** Painted bottom-to-top: index 0 sits on the base, the last is on top. */
  layers: AvatarLayer[];
};

export function hslaCss(c: AvatarHsla): string {
  return `hsla(${round(c.h, 1)} ${round(c.s, 1)}% ${round(c.l, 1)}% / ${round(c.a, 3)})`;
}

/**
 * Stacked CSS backgrounds, first paint on top. Clipped by a circular avatar.
 */
export function avatarLayerCss(layer: AvatarLayer): string {
  const color = hslaCss(layer);
  const start = round(circleStopToCss(layer.start, layer.rotation), 2);
  const end = round(circleStopToCss(layer.end, layer.rotation), 2);
  return `linear-gradient(${round(layer.rotation, 1)}deg, transparent ${start}%, ${color} ${start}%, ${color} ${end}%, transparent ${end}%)`;
}

/**
 * CSS linear-gradient percentages run along the square, which is longer on
 * the diagonal. Stops on the disc are along the diameter; this maps them so
 * 0% and 100% stay on the rim at every angle.
 */
export function circleStopToCss(percent: number, rotation: number): number {
  const span = cssGradientSpan(rotation);
  return ((percent / 100 - 0.5) / span) * 100 + 50;
}

function cssGradientSpan(rotation: number): number {
  const theta = (rotation * Math.PI) / 180;
  const max = Math.max(Math.abs(Math.sin(theta)), Math.abs(Math.cos(theta)));
  return max === 0 ? 1 : 1 / max;
}

export function avatarPatternCss(pattern: AvatarPattern): string {
  const bands = [...pattern.layers].reverse().map(avatarLayerCss);
  const base = pattern.baseEnd
    ? `linear-gradient(${round(pattern.baseRotation ?? 150, 1)}deg, ${hslaCss({ ...pattern.base, a: 1 })}, ${hslaCss({ ...pattern.baseEnd, a: 1 })})`
    : hslaCss({ ...pattern.base, a: 1 });
  return [...bands, base].join(", ");
}

/** Letter/emoji colour that contrasts with the (usually dark) base. */
export function avatarInkCss(pattern: AvatarPattern): string {
  return pattern.base.l < 56 ? "#f3eee6" : "#06120e";
}

export function parseAvatarPattern(raw: unknown): AvatarPattern | null {
  if (raw == null || raw === "") return null;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const base = parseHsla(obj.base);
  if (!base) return null;

  let baseEnd: AvatarHsla | undefined;
  if (obj.baseEnd !== undefined) {
    const parsed = parseHsla(obj.baseEnd);
    if (!parsed) return null;
    baseEnd = parsed;
  }

  let baseRotation: number | undefined;
  if (obj.baseRotation !== undefined) {
    const parsed = parseNum(obj.baseRotation, 0, 360);
    if (parsed === null) return null;
    baseRotation = parsed;
  }

  if (!Array.isArray(obj.layers) || obj.layers.length > MAX_AVATAR_LAYERS) return null;
  const layers: AvatarLayer[] = [];
  for (const item of obj.layers) {
    const layer = parseLayer(item);
    if (!layer) return null;
    layers.push(layer);
  }

  return {
    base,
    ...(baseEnd ? { baseEnd } : {}),
    ...(baseRotation !== undefined ? { baseRotation } : {}),
    layers,
  };
}

export function stringifyAvatarPattern(pattern: AvatarPattern): string {
  return JSON.stringify(normalizeAvatarPattern(pattern));
}

export function normalizeAvatarPattern(pattern: AvatarPattern): AvatarPattern {
  const layers = pattern.layers.slice(0, MAX_AVATAR_LAYERS).map(normalizeLayer);
  const next: AvatarPattern = { base: normalizeHsla(pattern.base), layers };
  if (pattern.baseEnd) next.baseEnd = normalizeHsla(pattern.baseEnd);
  if (pattern.baseRotation !== undefined) next.baseRotation = round(clamp(pattern.baseRotation, 0, 360), 1);
  return next;
}

export function avatarPatternFromId(id: string, iconHue?: number | null): AvatarPattern {
  return randomAvatarPattern(rngFromSeed(seedFromId(id)), {
    baseHue: iconHue ?? undefined,
  });
}

/** Which parts of a pattern Randomise must leave alone. Session-only; not stored. */
export type AvatarLockMask = {
  base?: boolean;
  /** Parallel to `current.layers`. A missing/false entry is unlocked. */
  layers?: boolean[];
};

export function randomizeAvatarPattern(
  current: AvatarPattern,
  locks?: AvatarLockMask,
): AvatarPattern {
  return randomAvatarPattern(Math.random, {
    baseHue: current.base.h,
    // The editor always passes a lock mask so a click cannot add or
    // remove discs. The form Randomise omits it and rolls a new count.
    keepLayerCount: locks !== undefined,
    keep: locks ? { current, locks } : undefined,
  });
}

export function resolveAvatarPattern(person: {
  id: string;
  iconHue?: number | null;
  iconPattern?: unknown;
}): AvatarPattern {
  const stored = parseAvatarPattern(person.iconPattern);
  if (stored) return stored;
  return avatarPatternFromId(person.id, person.iconHue);
}

export function defaultAvatarLayer(base: AvatarHsla): AvatarLayer {
  return {
    start: 28,
    end: 58,
    rotation: 24,
    h: base.h,
    s: clamp(base.s + 6, 0, 100),
    l: clamp(base.l + 10, 0, 100),
    a: 0.55,
  };
}

export function hexFromHsla(c: AvatarHsla): string {
  const { r, g, b } = hslToRgb(c.h, c.s, c.l);
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function hslaFromHex(hex: string, a: number): AvatarHsla | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 16);
  const { h, s, l } = rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
  return { h, s, l, a: clamp(a, 0, 1) };
}

export function paletteSpan(pattern: AvatarPattern): number {
  const hues = [pattern.base.h];
  if (pattern.baseEnd) hues.push(pattern.baseEnd.h);
  for (const layer of pattern.layers) {
    if (!isNeutral(layer)) hues.push(layer.h);
  }
  return hueSpan(hues);
}

export function isNeutral(c: AvatarHsla): boolean {
  return c.s <= 12 || c.l <= 14 || c.l >= 86;
}

export function randomAvatarPattern(
  rng: () => number,
  opts: {
    baseHue?: number;
    /** Keep `current.layers.length`. Editor Randomise; a fresh roll omits this. */
    keepLayerCount?: boolean;
    keep?: { current: AvatarPattern; locks?: AvatarLockMask };
  } = {},
): AvatarPattern {
  const current = opts.keep?.current;
  const locks = opts.keep?.locks;
  const keepBase = Boolean(locks?.base && current);
  const layerLocks = locks?.layers ?? [];
  const keepAnyLayer = Boolean(current && layerLocks.some(Boolean));

  const origin = keepBase
    ? current!.base.h
    : opts.baseHue !== undefined
      ? wrapHue(opts.baseHue)
      : rng() * 360;
  const span = 55 + rng() * 125;

  let base: AvatarHsla;
  let baseEnd: AvatarHsla | undefined;
  let baseRotation: number | undefined;
  if (keepBase && current) {
    base = current.base;
    baseEnd = current.baseEnd;
    baseRotation = current.baseRotation;
  } else {
    const sat = 48 + rng() * 32;
    const light = 26 + rng() * 22;
    base = {
      h: round(origin, 1),
      s: round(sat, 1),
      l: round(light, 1),
      a: 1,
    };
    baseEnd = {
      h: round(wrapHue(origin + Math.min(span, 8 + rng() * 24)), 1),
      s: round(clamp(sat + (rng() - 0.5) * 18, 38, 84), 1),
      l: round(clamp(light + (rng() - 0.5) * 16, 16, 56), 1),
      a: 1,
    };
    baseRotation = round(rng() * 360, 1);
  }

  const layerCount =
    (opts.keepLayerCount || keepAnyLayer) && current
      ? current.layers.length
      : 3 + Math.floor(rng() * 4);
  const layers: AvatarLayer[] = [];
  let neutrals = 0;
  if (keepAnyLayer && current) {
    for (let i = 0; i < layerCount; i++) {
      if (layerLocks[i] && isNeutral(current.layers[i]!)) neutrals += 1;
    }
  }

  for (let i = 0; i < layerCount; i++) {
    if (keepAnyLayer && current && layerLocks[i] && current.layers[i]) {
      layers.push(current.layers[i]!);
      continue;
    }
    const rolled = rollLayer(rng, origin, span, i, neutrals);
    layers.push(rolled.layer);
    neutrals = rolled.neutrals;
  }

  return {
    base,
    ...(baseEnd ? { baseEnd } : {}),
    ...(baseRotation !== undefined ? { baseRotation } : {}),
    layers,
  };
}

function rollLayer(
  rng: () => number,
  origin: number,
  span: number,
  index: number,
  neutrals: number,
): { layer: AvatarLayer; neutrals: number } {
  const wantNeutral = neutrals < 2 && rng() < (index === 0 ? 0.05 : 0.16);
  if (wantNeutral) {
    const lightAccent = rng() < 0.55;
    const start = rng() * 78;
    const width = 4 + rng() * 12;
    return {
      neutrals: neutrals + 1,
      layer: {
        start: round(start, 2),
        end: round(Math.min(100, start + width), 2),
        rotation: round(rng() * 180, 1),
        h: round(wrapHue(origin + rng() * span), 1),
        s: round(rng() * 10, 1),
        l: round(lightAccent ? 86 + rng() * 10 : 6 + rng() * 12, 1),
        a: round(0.22 + rng() * 0.38, 3),
      },
    };
  }

  const start = rng() * 62;
  const width = 14 + rng() * 36;
  return {
    neutrals,
    layer: {
      start: round(start, 2),
      end: round(Math.min(100, start + width), 2),
      rotation: round(rng() * 180, 1),
      h: round(wrapHue(origin + rng() * span), 1),
      s: round(35 + rng() * 48, 1),
      l: round(18 + rng() * 42, 1),
      a: round(0.38 + rng() * 0.5, 3),
    },
  };
}

function parseLayer(raw: unknown): AvatarLayer | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const color = parseHsla(obj);
  const start = parseNum(obj.start, 0, 100);
  const end = parseNum(obj.end, 0, 100);
  const rotation = parseNum(obj.rotation, 0, 360);
  if (!color || start === null || end === null || rotation === null) return null;
  if (start === end) return null;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  return { ...color, start: lo, end: hi, rotation };
}

function parseHsla(raw: unknown): AvatarHsla | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const h = parseNum(obj.h, 0, 360);
  const s = parseNum(obj.s, 0, 100);
  const l = parseNum(obj.l, 0, 100);
  const a = parseNum(obj.a, 0, 1);
  if (h === null || s === null || l === null || a === null) return null;
  return { h, s, l, a };
}

function parseNum(raw: unknown, min: number, max: number): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < min || raw > max) return null;
  return raw;
}

function normalizeLayer(layer: AvatarLayer): AvatarLayer {
  const start = clamp(layer.start, 0, 100);
  const end = clamp(layer.end, 0, 100);
  return {
    ...normalizeHsla(layer),
    start: round(Math.min(start, end), 2),
    end: round(Math.max(start, end), 2),
    rotation: round(clamp(layer.rotation, 0, 360), 1),
  };
}

function normalizeHsla(c: AvatarHsla): AvatarHsla {
  return {
    h: round(clamp(c.h, 0, 360), 1),
    s: round(clamp(c.s, 0, 100), 1),
    l: round(clamp(c.l, 0, 100), 1),
    a: round(clamp(c.a, 0, 1), 3),
  };
}

function hueSpan(hues: number[]): number {
  if (hues.length <= 1) return 0;
  const sorted = [...hues.map(wrapHue)].sort((a, b) => a - b);
  let gap = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    gap = Math.max(gap, sorted[i + 1]! - sorted[i]!);
  }
  gap = Math.max(gap, sorted[0]! + 360 - sorted[sorted.length - 1]!);
  return 360 - gap;
}

function wrapHue(h: number): number {
  const x = h % 360;
  return x < 0 ? x + 360 : x;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function seedFromId(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function rngFromSeed(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hp = wrapHue(h) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = light - c / 2;
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: round(l * 100, 1) };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) * 60;
  else if (max === gg) h = ((bb - rr) / d + 2) * 60;
  else h = ((rr - gg) / d + 4) * 60;
  return { h: round(h, 1), s: round(s * 100, 1), l: round(l * 100, 1) };
}

function toHex(n: number): string {
  return n.toString(16).padStart(2, "0");
}
