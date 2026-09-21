/**
 * Content hashing for the artifact spine (Gate B) — SHA-256 over the canonical JSON bytes.
 *
 * Why THIS algorithm, and why implemented here:
 *
 * - **SHA-256** because a content hash is an IDENTITY — dedup keys, replay comparison, and
 *   provenance chains all assume two different artifacts never share a hash. A fast non-crypto
 *   hash (FNV, xxHash) trades exactly that guarantee away for speed the spine does not need:
 *   large tables travel by {@link TableHandle} reference, so hashed payloads are envelopes, which
 *   are small by design. It also matches the repo's existing convention — every tooling hash
 *   (manifest enforcement, MCP contracts) is already SHA-256.
 * - **Pure TypeScript** because the library is browser-safe: `node:crypto`'s `createHash` exists
 *   only in Node (today it appears solely under `tools/`, never in a package), and
 *   `crypto.subtle.digest` is async — an awaitable constructor would poison every create/read
 *   call with promises to hash a few hundred bytes. FIPS 180-4 SHA-256 is ~60 lines, synchronous,
 *   and dependency-free.
 *
 * The digest string carries its algorithm — `sha256:<64 hex>` — so a future algorithm change is a
 * visible new prefix, never a silent re-keying.
 */

import { ErrorCode, InputError } from '../errors.js';
import { canonicalJsonOf } from '../canonical-json.js';

/** The hash-string grammar: algorithm prefix + lowercase hex digest. */
export const CONTENT_HASH_PREFIX = 'sha256:';

/** Exact shape test for a spine hash string (used by handle/artifact validation). */
export function isContentHashString(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

// FIPS 180-4 round constants: first 32 bits of the fractional parts of the cube roots of the
// first 64 primes.
// prettier-ignore
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/**
 * UTF-8 encode without `TextEncoder` — the compile target is pure ES2022 (no DOM/Node lib), and a
 * hand-rolled encoder is also the most explicit statement of the byte contract the hash covers:
 * well-formed code points encode per RFC 3629; a LONE SURROGATE encodes as U+FFFD (the same
 * replacement `TextEncoder` performs), so an ill-formed string still has ONE deterministic hash.
 */
function utf8Bytes(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      } else {
        code = 0xfffd; // unpaired high surrogate
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd; // unpaired low surrogate
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
  }
  return new Uint8Array(bytes);
}

/** FIPS 180-4 SHA-256 of a byte array, as 8 big-endian words. */
function sha256Words(bytes: Uint8Array): Uint32Array {
  // Message length in bits, split into two 32-bit halves. `bytes.length` is a safe integer well
  // below 2^53, so the high word is exact.
  const bitLengthLow = (bytes.length << 3) >>> 0;
  const bitLengthHigh = Math.floor(bytes.length / 0x20000000);

  // Padded length: message + 0x80 + zeros to 56 mod 64, + 8 length bytes.
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLengthHigh);
  view.setUint32(paddedLength - 4, bitLengthLow);

  // Initial hash: first 32 bits of the fractional parts of the square roots of the first 8 primes.
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(offset + t * 4);
    for (let t = 16; t < 64; t++) {
      const w15 = w[t - 15]!;
      const w2 = w[t - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;
    for (let t = 0; t < 64; t++) {
      const bigSigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (hh + bigSigma1 + choose + K[t]! + w[t]!) >>> 0;
      const bigSigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (bigSigma0 + majority) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  return h;
}

/**
 * SHA-256 of a UTF-8 string, as 64 lowercase hex characters. The raw primitive under
 * {@link contentHash}, exported so golden vectors and external comparisons (`echo -n … |
 * shasum -a 256`, Python's `hashlib`) can target it directly.
 */
export function sha256Hex(text: string): string {
  if (typeof text !== 'string') {
    throw new InputError(
      `sha256Hex: text must be a string, got ${text === null ? 'null' : typeof text}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { received: text === null ? 'null' : typeof text },
      },
    );
  }
  const words = sha256Words(utf8Bytes(text));
  let hex = '';
  for (let i = 0; i < 8; i++) hex += words[i]!.toString(16).padStart(8, '0');
  return hex;
}

/**
 * The spine's content identity: `sha256:` + SHA-256 of the value's canonical JSON. Same logical
 * value → same hash, regardless of key order or `-0`; any covered field change → a different hash.
 * What a given envelope's hash COVERS (and that provenance labels are excluded) is decided by that
 * envelope's own `…ContentHash` function, not here — this is the mechanism, not the policy.
 */
export function contentHash(value: unknown): string {
  return CONTENT_HASH_PREFIX + sha256Hex(canonicalJsonOf(value));
}
