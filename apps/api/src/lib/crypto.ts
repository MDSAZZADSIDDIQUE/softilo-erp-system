import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encrypts tokens for HMRC and bank connections before they are stored (AES-256-GCM).
 * SECRETS_KEY is 32 bytes, base64. Development falls back to a fixed key so the demo works out of the box;
 * production refuses to store a secret without a real one.
 */
function key(): Buffer {
  const k = process.env.SECRETS_KEY;
  if (k) {
    const buf = Buffer.from(k, "base64");
    if (buf.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
    return buf;
  }
  if (process.env.NODE_ENV === "production" && process.env.DEMO_MODE !== "1") {
    throw Object.assign(new Error("SECRETS_KEY is not set, so connection tokens cannot be stored safely"), { statusCode: 503 });
  }
  return createHash("sha256").update("softilo-development-only-key").digest();
}

export function seal(value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return `v1.${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${data.toString("base64")}`;
}

export function unseal<T = unknown>(sealed: string): T {
  const [v, iv, tag, data] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Unrecognised secret format");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8")) as T;
}
