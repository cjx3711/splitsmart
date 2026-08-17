/**
 * ULID generation and validation.
 *
 * Pure: no database, no Node built-ins. The frontend imports this the same way
 * it already imports `split.ts`, so a client-minted expense id is the same
 * 26-character string the server would have stored. See docs/ULIDS.md.
 *
 * A ULID is 128 bits, encoded as 26 characters of Crockford base32: a 48-bit
 * millisecond timestamp (10 chars) followed by 80 bits of randomness (16 chars).
 * They sort lexicographically by time. They are not sequential; that is the point.
 */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Crockford base32, no I/L/O/U. Length 26. Case-sensitive: we only emit uppercase. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Encodes `len` characters of Crockford base32 from a non-negative integer,
 * most significant digit first. Used for the 48-bit timestamp (10 chars).
 */
function encodeTime(now: number, len: number): string {
  let time = now;
  let out = "";
  for (let i = 0; i < len; i++) {
    out = ENCODING[time % 32]! + out;
    time = Math.floor(time / 32);
  }
  return out;
}

/**
 * 80 bits of `crypto.getRandomValues`, as 16 Crockford characters.
 *
 * Each byte contributes its low 5 bits. Discarding 3 bits per byte is fine:
 * we still have 80 bits of entropy, which is the ULID spec.
 */
function encodeRandom(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ENCODING[bytes[i]! & 31]!;
  }
  return out;
}

/** 26-character Crockford ULID. `now` is injectable so tests (and import) can pin the timestamp. */
export function ulid(now: number = Date.now()): string {
  const t = Number.isFinite(now) && now >= 0 ? Math.floor(now) : Date.now();
  return encodeTime(t, 10) + encodeRandom(16);
}

/** Milliseconds encoded in the first 10 characters. Inverse of `ulid(now)`. */
export function ulidTime(id: string): number {
  let t = 0;
  for (let i = 0; i < 10; i++) {
    const idx = ENCODING.indexOf(id[i]!);
    if (idx < 0) return NaN;
    t = t * 32 + idx;
  }
  return t;
}

export function isUlid(value: unknown): value is string {
  return typeof value === "string" && ULID_RE.test(value);
}
