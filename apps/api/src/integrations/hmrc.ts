import { createHash } from "node:crypto";
import type { VatReturn } from "@softilo/domain";
import { hmrcBase, httpJson, missing } from "./config.js";
import type { FraudPreventionData, HmrcAuth, HmrcVatProvider, VatObligation, VatSubmissionReceipt } from "./types.js";

const iso = (d: Date) => d.toISOString().slice(0, 10);
function addMonths(date: string, months: number): Date {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}
function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

/** Quarterly periods from the first period start, keyed the way HMRC keys them (e.g. 26A1, 26A2, 27A1). */
export function quarterlyPeriods(firstStart: string, until: string) {
  const out: { periodKey: string; start: string; end: string; due: string }[] = [];
  const perYear = new Map<string, number>();
  for (let i = 0; i < 40; i++) {
    const start = addMonths(firstStart, i * 3);
    if (iso(start) > until) break;
    const end = addDays(addMonths(firstStart, (i + 1) * 3), -1);
    const yy = iso(start).slice(2, 4);
    const n = (perYear.get(yy) ?? 0) + 1;
    perYear.set(yy, n);
    // Payment and filing are due one month and seven days after the period ends.
    const due = addDays(addMonths(iso(addDays(end, 1)), 1), 6);
    out.push({ periodKey: `${yy}A${n}`, start: iso(start), end: iso(end), due: iso(due) });
  }
  return out;
}

/**
 * Behaves like the HMRC sandbox: quarterly obligations, a receipt with a form bundle number on submission,
 * and the same validation HMRC applies (whole pounds in boxes 6-9, box 5 equal to box 3 minus box 4).
 */
export function demoHmrc(): HmrcVatProvider {
  return {
    info: () => ({ mode: "demo", name: "Built-in HMRC simulator", ready: true }),
    authoriseUrl: () => null,
    exchangeCode: async () => ({ accessToken: "demo", refreshToken: "demo", expiresIn: 14_400 }),
    refresh: async () => ({ accessToken: "demo", refreshToken: "demo", expiresIn: 14_400 }),
    async obligations(auth, from, to) {
      const first = auth.firstPeriodStart ?? `${from.slice(0, 7)}-01`;
      const filed = new Map((auth.filed ?? []).map((f) => [f.periodKey, f.submittedAt]));
      return quarterlyPeriods(first, to)
        .filter((p) => p.end >= from)
        .map((p): VatObligation => ({ ...p, status: filed.has(p.periodKey) ? "F" : "O", received: filed.get(p.periodKey)?.slice(0, 10) }));
    },
    async submit(auth, periodKey, boxes) {
      validateBoxes(boxes);
      if (auth.filed?.some((f) => f.periodKey === periodKey)) {
        throw Object.assign(new Error("HMRC: DUPLICATE_SUBMISSION - this period has already been submitted"), { statusCode: 409 });
      }
      const h = createHash("sha256").update(`${auth.vrn}|${periodKey}|${boxes.box5}`).digest();
      const digits = (n: number) => Array.from(h.subarray(0, n), (b) => b % 10).join("");
      const owed = Number(boxes.box3) > Number(boxes.box4);
      return {
        processingDate: new Date().toISOString(),
        formBundleNumber: `0${digits(11)}`,
        paymentIndicator: "BANK",
        chargeRefNumber: owed ? `XM00${digits(10)}` : undefined,
      };
    },
  };
}

/** HMRC's own rules for the 9-box figures, checked before anything is sent. */
export function validateBoxes(b: VatReturn) {
  const pence = /^-?\d{1,11}\.\d{2}$/;
  for (const k of ["box1", "box2", "box3", "box4"] as const) if (!pence.test(b[k])) throw new Error(`${k} must be pounds and pence`);
  if (!/^\d{1,11}\.\d{2}$/.test(b.box5)) throw new Error("box5 must be a positive amount");
  for (const k of ["box6", "box7", "box8", "box9"] as const) if (!/^-?\d{1,13}$/.test(b[k])) throw new Error(`${k} must be whole pounds`);
  const net = Math.abs(Math.round(Number(b.box3) * 100) - Math.round(Number(b.box4) * 100));
  if (net !== Math.round(Number(b.box5) * 100)) throw new Error("box5 must equal the difference between box3 and box4");
}

/** Gov-Client-* and Gov-Vendor-* headers for the WEB_APP_VIA_SERVER connection method. */
export function fraudHeaders(f: FraudPreventionData, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const enc = encodeURIComponent;
  const h: Record<string, string> = {
    "Gov-Client-Connection-Method": "WEB_APP_VIA_SERVER",
    "Gov-Vendor-Product-Name": enc("Softilo ERP"),
    "Gov-Vendor-Version": `softilo-erp=${enc(env.npm_package_version ?? "0.1.0")}`,
  };
  const set = (k: string, v: string | undefined) => { if (v) h[k] = v; };
  set("Gov-Client-Public-IP", f.clientPublicIp);
  set("Gov-Client-Public-Port", f.clientPublicPort);
  set("Gov-Client-Device-ID", f.clientDeviceId);
  if (f.clientUserIds) set("Gov-Client-User-IDs", Object.entries(f.clientUserIds).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&"));
  set("Gov-Client-Timezone", f.clientTimezone);
  set("Gov-Client-Screens", f.clientScreens);
  set("Gov-Client-Window-Size", f.clientWindowSize);
  set("Gov-Client-Browser-JS-User-Agent", f.clientBrowserJsUserAgent);
  set("Gov-Client-Browser-Do-Not-Track", f.clientBrowserDoNotTrack);
  set("Gov-Client-Multi-Factor", f.clientMultiFactor);
  set("Gov-Vendor-Public-IP", f.vendorPublicIp ?? env.VENDOR_PUBLIC_IP);
  set("Gov-Vendor-Forwarded", f.vendorForwarded);
  set("Gov-Client-Public-IP-Timestamp", f.clientPublicIp ? new Date().toISOString() : undefined);
  return h;
}

/** The real MTD VAT API (sandbox by default, production with HMRC_ENV=production). */
export function liveHmrc(env: NodeJS.ProcessEnv = process.env): HmrcVatProvider {
  const base = hmrcBase(env);
  const need = missing(env, ["HMRC_CLIENT_ID", "HMRC_CLIENT_SECRET"]);
  const accept = { accept: "application/vnd.hmrc.1.0+json" };
  async function token(params: Record<string, string>) {
    const r = await httpJson<{ access_token: string; refresh_token: string; expires_in: number }>(`${base}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.HMRC_CLIENT_ID ?? "", client_secret: env.HMRC_CLIENT_SECRET ?? "", ...params }),
    });
    return { accessToken: r.access_token, refreshToken: r.refresh_token, expiresIn: r.expires_in };
  }
  return {
    info: () => ({ mode: "live", name: env.HMRC_ENV === "production" ? "HMRC MTD (production)" : "HMRC MTD (sandbox)", ready: !need.length, missing: need }),
    authoriseUrl: (state, redirectUri) =>
      `${base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: env.HMRC_CLIENT_ID ?? "", scope: "read:vat write:vat", state, redirect_uri: redirectUri })}`,
    exchangeCode: (code, redirectUri) => token({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    refresh: (refreshToken) => token({ grant_type: "refresh_token", refresh_token: refreshToken }),
    async obligations(auth, from, to) {
      const r = await httpJson<{ obligations: VatObligation[] }>(
        `${base}/organisations/vat/${auth.vrn}/obligations?${new URLSearchParams({ from, to })}`,
        { headers: { ...accept, authorization: `Bearer ${auth.accessToken}` } });
      return r.obligations;
    },
    async submit(auth, periodKey, b, fraud) {
      validateBoxes(b);
      return httpJson<VatSubmissionReceipt>(`${base}/organisations/vat/${auth.vrn}/returns`, {
        method: "POST",
        headers: { ...accept, "content-type": "application/json", authorization: `Bearer ${auth.accessToken}`, ...fraudHeaders(fraud, env) },
        body: JSON.stringify({
          periodKey,
          vatDueSales: Number(b.box1), vatDueAcquisitions: Number(b.box2), totalVatDue: Number(b.box3),
          vatReclaimedCurrPeriod: Number(b.box4), netVatDue: Number(b.box5),
          totalValueSalesExVAT: Number(b.box6), totalValuePurchasesExVAT: Number(b.box7),
          totalValueGoodsSuppliedExVAT: Number(b.box8), totalAcquisitionsExVAT: Number(b.box9),
          finalised: true,
        }),
      });
    },
  };
}
