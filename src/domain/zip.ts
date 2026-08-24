/**
 * A tiny ZIP writer for text (and other) files.
 *
 * Node has gzip, not ZIP. The archive we hand back from Settings is a handful
 * of CSVs, so pulling in an archiver for that would be a dependency for a
 * format that is a local-file header, a central directory, and an end record.
 * Compression is DEFLATE (method 8) via `node:zlib`.
 *
 * Filenames are stored as UTF-8 with the language-encoding flag set. Bodies
 * are taken as UTF-8 when they arrive as strings.
 */
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  body: string | Uint8Array;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const VERSION = 20;
/** Bit 11: UTF-8 filenames. */
const UTF8_FLAG = 1 << 11;
const DEFLATE = 8;

/**
 * Builds a ZIP from named files. Order is preserved, so a README first is a
 * README first when someone opens the archive.
 */
export function zipFiles(files: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  const now = dosDateTime(new Date());

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    if (nameBytes.length > 0xffff) {
      throw new Error(`ZIP filename too long: ${file.name}`);
    }
    const uncompressed =
      typeof file.body === "string" ? encoder.encode(file.body) : file.body;
    const compressed = deflateRawSync(uncompressed);
    const checksum = crc32(uncompressed) >>> 0;

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_SIG, true);
    localView.setUint16(4, VERSION, true);
    localView.setUint16(6, UTF8_FLAG, true);
    localView.setUint16(8, DEFLATE, true);
    localView.setUint16(10, now.time, true);
    localView.setUint16(12, now.date, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, compressed.length, true);
    localView.setUint32(22, uncompressed.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, compressed);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_SIG, true);
    centralView.setUint16(4, VERSION, true);
    centralView.setUint16(6, VERSION, true);
    centralView.setUint16(8, UTF8_FLAG, true);
    centralView.setUint16(10, DEFLATE, true);
    centralView.setUint16(12, now.time, true);
    centralView.setUint16(14, now.date, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, compressed.length, true);
    centralView.setUint32(24, uncompressed.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, EOCD_SIG, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);
  eocdView.setUint16(20, 0, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let written = 0;
  for (const chunk of chunks) {
    out.set(chunk, written);
    written += chunk.length;
  }
  for (const central of centrals) {
    out.set(central, written);
    written += central.length;
  }
  out.set(eocd, written);
  return out;
}

/** Filenames in the central directory, in archive order. Used by tests. */
export function zipFilenames(zip: Uint8Array): string[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.byteLength - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== EOCD_SIG) eocd -= 1;
  if (eocd < 0) throw new Error("Not a ZIP: missing end-of-central-directory");

  const count = view.getUint16(eocd + 8, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_SIG) {
      throw new Error("Not a ZIP: broken central directory");
    }
    const nameLen = view.getUint16(offset + 28, true);
    names.push(decoder.decode(zip.subarray(offset + 46, offset + 46 + nameLen)));
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** Inflates one named entry. Used by tests; the export itself only writes. */
export function unzipFile(zip: Uint8Array, filename: string): string {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let offset = 0;
  const decoder = new TextDecoder();
  while (offset + 30 <= zip.byteLength && view.getUint32(offset, true) === LOCAL_SIG) {
    const method = view.getUint16(offset + 8, true);
    const compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const name = decoder.decode(zip.subarray(offset + 30, offset + 30 + nameLen));
    const dataStart = offset + 30 + nameLen + extraLen;
    const data = zip.subarray(dataStart, dataStart + compSize);
    if (name === filename) {
      const raw = method === DEFLATE ? inflateRawSync(data) : data;
      return decoder.decode(raw);
    }
    offset = dataStart + compSize;
  }
  throw new Error(`ZIP has no file named ${filename}`);
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = date.getUTCFullYear();
  if (year < 1980) return { time: 0, date: 0 };
  const time =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (Math.floor(date.getUTCSeconds() / 2));
  const dosDate =
    ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, date: dosDate };
}
