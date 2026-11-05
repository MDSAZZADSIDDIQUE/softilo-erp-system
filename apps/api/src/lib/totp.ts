import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** RFC 6238 time-based one-time passwords (30-second steps, 6 digits, SHA-1), as used by authenticator apps. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$|\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(randomBytes(20));

export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = h[h.length - 1]! & 0xf;
  const code = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(code % 1_000_000).padStart(6, "0");
}

export const step = (at = Date.now()) => Math.floor(at / 30_000);

/** Accepts the current code and one step either side (clock drift). Returns the step matched, or null. */
export function verifyTotp(secret: string, code: string, lastStep: number | null, at = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = step(at);
  for (const s of [now, now - 1, now + 1]) {
    if (lastStep !== null && s <= lastStep) continue; // a code can only be used once
    const expected = Buffer.from(hotp(secret, s));
    if (timingSafeEqual(expected, Buffer.from(code))) return s;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer = "Softilo ERP") {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?${new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" })}`;
}

/** Ten single-use recovery codes, shown once, like "7KQ4-M2XD". */
export function recoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const s = base32Encode(randomBytes(5)).slice(0, 8);
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}
