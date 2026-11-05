import type { Mode } from "./types.js";

/**
 * Which provider each service uses. INTEGRATIONS sets the default for all of them ("demo" unless set),
 * and each service can be switched on its own, e.g. HMRC_MODE=live while the bank feed stays on demo.
 */
export type Service = "hmrc" | "bank_feed" | "companies_house" | "vat_check" | "email" | "fx" | "ai";

const ENV: Record<Service, string> = {
  hmrc: "HMRC_MODE", bank_feed: "BANK_FEED_MODE", companies_house: "COMPANIES_HOUSE_MODE",
  vat_check: "VAT_CHECK_MODE", email: "EMAIL_MODE", fx: "FX_MODE", ai: "AI_MODE",
};

export function modeOf(service: Service, env: NodeJS.ProcessEnv = process.env): Mode {
  // AI is live as soon as a key is configured, unless it is switched off explicitly.
  if (service === "ai" && !env.AI_MODE && env.GEMINI_API_KEY) return "live";
  const v = (env[ENV[service]] ?? env.INTEGRATIONS ?? "demo").toLowerCase();
  return v === "live" ? "live" : "demo";
}

export function missing(env: NodeJS.ProcessEnv, names: string[]): string[] {
  return names.filter((n) => !env[n]);
}

/** HMRC publishes a sandbox and a production API; live mode uses the sandbox unless HMRC_ENV=production. */
export function hmrcBase(env: NodeJS.ProcessEnv = process.env) {
  return env.HMRC_ENV === "production" ? "https://api.service.hmrc.gov.uk" : "https://test-api.service.hmrc.gov.uk";
}

export async function httpJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
    if (!res.ok) {
      const msg = typeof body === "object" && body && "message" in body ? String((body as { message: unknown }).message) : text.slice(0, 300);
      throw Object.assign(new Error(`${new URL(url).host} answered ${res.status}: ${msg}`), { statusCode: 502, upstreamStatus: res.status, body });
    }
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}
