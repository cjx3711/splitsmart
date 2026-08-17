/**
 * Password hashing.
 *
 * Uses scrypt from node:crypto; no native dependency, nothing to compile in
 * Docker, and it is an OWASP-acceptable password KDF at these parameters.
 *
 * Hashes are stored SELF-DESCRIBING:
 *
 *   scrypt$N$r$p$<salt-base64url>$<hash-base64url>
 *
 * The algorithm name and its parameters travel with every hash, so moving to
 * argon2id later (or raising the cost) is a non-event: `verifyPassword` keeps
 * accepting old hashes, and `needsRehash` tells the login path when to
 * transparently upgrade one. Never store a bare hash without this prefix.
 */
import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** OWASP-recommended scrypt parameters (N=2^17, r=8, p=1). ~200ms per hash. */
const PARAMS = { N: 1 << 17, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 32;
// scrypt needs roughly 128 * N * r bytes; give it headroom or it throws.
const MAX_MEM = 256 * PARAMS.N * PARAMS.r;

export class PasswordError extends Error {}

export async function hashPassword(password: string): Promise<string> {
  assertReasonable(password);

  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
    ...PARAMS,
    maxmem: MAX_MEM,
  });

  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupted row
 * should fail closed as a bad login, not crash the auth route.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;

    const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
    const N = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    if (!N || !r || !p) return false;

    const salt = Buffer.from(saltB64!, "base64url");
    const expected = Buffer.from(hashB64!, "base64url");

    const derived = await scrypt(password.normalize("NFKC"), salt, expected.length, {
      N,
      r,
      p,
      maxmem: Math.max(MAX_MEM, 256 * N * r),
    });

    // Lengths are equal by construction above, but timingSafeEqual throws on a
    // mismatch, so guard anyway.
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash uses weaker parameters than we now use. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return (
    Number(parts[1]) < PARAMS.N ||
    Number(parts[2]) < PARAMS.r ||
    Number(parts[3]) < PARAMS.p
  );
}

function assertReasonable(password: string): void {
  if (typeof password !== "string" || password.length < 8) {
    throw new PasswordError("Password must be at least 8 characters");
  }
  // scrypt has no practical input limit, but an unbounded input is a cheap DoS.
  if (Buffer.byteLength(password, "utf8") > 1024) {
    throw new PasswordError("Password must be at most 1024 bytes");
  }
}

// ---------------------------------------------------------------------------
// Opaque tokens (sessions, API tokens, invite links, recovery codes)
// ---------------------------------------------------------------------------

/**
 * Generates a high-entropy token. 32 bytes is well past guessing range, and
 * base64url keeps it safe in URLs and cookies without escaping.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Hashes a token for storage.
 *
 * Plain SHA-256 is correct here and scrypt would be wrong: these tokens are
 * already full-entropy random, so there is nothing to brute-force, and session
 * lookup happens on every request where a 200ms KDF would be unusable.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/**
 * Generates a human-transcribable recovery code for ghost accounts, e.g.
 * "K7M2-9QXR-4TWP". Avoids characters that get misread when typed by hand.
 */
export function generateRecoveryCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/I/L
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)]
    .map((g) => g.join(""))
    .join("-");
}

export function normaliseRecoveryCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
