import { createHash, randomUUID } from "node:crypto";
import { httpJson, missing } from "./config.js";
import type { CompaniesHouseProvider, CompanyProfile, EmailProvider, FxProvider, VatCheckProvider } from "./types.js";

// ---------------------------------------------------------------- UK VAT number check digits

/**
 * HMRC's check-digit rule for 9-digit VAT numbers: weight the first seven digits 8..2, add the last two
 * as a number, and the total must divide by 97 (or by 97 after adding 55, for numbers issued since 2010).
 */
export function vatChecksumOk(vat: string): boolean {
  const n = vat.replace(/^GB/i, "").replace(/\s/g, "");
  if (!/^\d{9}(\d{3})?$/.test(n)) return false;
  const digits = n.slice(0, 9).split("").map(Number);
  const total = digits.slice(0, 7).reduce((s, x, i) => s + x * (8 - i), 0) + Number(n.slice(7, 9));
  return total % 97 === 0 || (total + 55) % 97 === 0;
}

// ---------------------------------------------------------------- demo company register

/**
 * A small slice of the register: the demo company's trading partners and a few others, in the shape
 * Companies House returns. All names and numbers are made up.
 */
const REGISTER: (CompanyProfile & { vat?: string })[] = [
  { companyNumber: "14523987", name: "THAMES VALLEY IMPORTS LTD", status: "active", type: "ltd", incorporatedOn: "2022-11-14", sicCodes: ["46499"], vat: "284716531", address: { line1: "Unit 4, Kennet Trade Park", city: "Reading", postcode: "RG2 0QX", country: "GB" } },
  { companyNumber: "09811234", name: "OXFORD KITCHEN CO LTD", status: "active", type: "ltd", incorporatedOn: "2015-09-28", sicCodes: ["47599"], vat: "221548332", address: { line1: "41 Little Clarendon Street", city: "Oxford", postcode: "OX1 2HU", country: "GB" } },
  { companyNumber: "07264418", name: "BATH HOME STORES LTD", status: "active", type: "ltd", incorporatedOn: "2010-05-24", sicCodes: ["47599", "47190"], vat: "102938430", address: { line1: "8 Milsom Place", city: "Bath", postcode: "BA1 1BZ", country: "GB" } },
  { companyNumber: "11893052", name: "BRIGHTON LIVING PLC", status: "active", type: "plc", incorporatedOn: "2019-03-11", sicCodes: ["47599"], vat: "317726452", address: { line1: "Churchill Square", line2: "Western Road", city: "Brighton", postcode: "BN1 2RG", country: "GB" } },
  { companyNumber: "12667301", name: "HARROGATE COOKSHOP LTD", status: "active", type: "ltd", incorporatedOn: "2020-06-02", sicCodes: ["47599"], vat: "354182950", address: { line1: "12 Station Parade", city: "Harrogate", postcode: "HG1 1UE", country: "GB" } },
  { companyNumber: "08470215", name: "SOLENT HOTEL SUPPLIES LTD", status: "active", type: "ltd", incorporatedOn: "2013-04-03", sicCodes: ["46690", "46499"], vat: "482915716", address: { line1: "Unit 9, Ocean Quay", city: "Southampton", postcode: "SO14 3JW", country: "GB" } },
  { companyNumber: "13310877", name: "KITCHEN CORNER ONLINE LTD", status: "active", type: "ltd", incorporatedOn: "2021-04-06", sicCodes: ["47910"], vat: "393008751", address: { line1: "Suite 3, Brunel House", city: "Swindon", postcode: "SN1 1PL", country: "GB" } },
  { companyNumber: "05529761", name: "FELIXSTOWE FREIGHT SERVICES LTD", status: "active", type: "ltd", incorporatedOn: "2005-08-01", sicCodes: ["52290"], vat: "193847518", address: { line1: "Dock Gate 2, Walton Avenue", city: "Felixstowe", postcode: "IP11 3HH", country: "GB" } },
  { companyNumber: "06115830", name: "HARBOUR CUSTOMS BROKERS LTD", status: "active", type: "ltd", incorporatedOn: "2007-02-19", sicCodes: ["52290"], vat: "556677830", address: { line1: "Customs House, Langer Road", city: "Felixstowe", postcode: "IP11 2BW", country: "GB" } },
  { companyNumber: "03977412", name: "KENNET ESTATES LTD", status: "active", type: "ltd", incorporatedOn: "2000-04-17", sicCodes: ["68209"], vat: "302010449", address: { line1: "Abbey House, Abbey Square", city: "Reading", postcode: "RG1 3BE", country: "GB" } },
  { companyNumber: "OC398812", name: "ABBEY SQUARE ACCOUNTANTS LLP", status: "active", type: "llp", incorporatedOn: "2015-02-09", sicCodes: ["69201"], vat: "374620102", address: { line1: "2 Abbey Square", city: "Reading", postcode: "RG1 3AF", country: "GB" } },
  { companyNumber: "10204466", name: "SOUTHERN BUSINESS ENERGY LTD", status: "active", type: "ltd", incorporatedOn: "2016-06-01", sicCodes: ["35140"], vat: "560193846", address: { line1: "Energy House, Forbury Road", city: "Reading", postcode: "RG1 1SB", country: "GB" } },
  { companyNumber: "04412290", name: "COTSWOLD INTERIORS LIMITED", status: "dissolved", type: "ltd", incorporatedOn: "2002-04-25", sicCodes: ["47599"], address: { line1: "The Old Forge, High Street", city: "Burford", postcode: "OX18 4QA", country: "GB" } },
  { companyNumber: "15022846", name: "COTSWOLD INTERIORS (2023) LTD", status: "active", type: "ltd", incorporatedOn: "2023-07-12", sicCodes: ["47599"], vat: "421103325", address: { line1: "The Old Forge, High Street", city: "Burford", postcode: "OX18 4QA", country: "GB" } },
  { companyNumber: "12098345", name: "WESSEX COOKWARE DISTRIBUTION LTD", status: "active", type: "ltd", incorporatedOn: "2019-07-08", sicCodes: ["46499"], vat: "331920035", address: { line1: "Unit 22, Solstice Park", city: "Amesbury", postcode: "SP4 7SQ", country: "GB" } },
];

const oneLine = (a: CompanyProfile["address"]) => [a.line1, a.line2, a.city, a.postcode].filter(Boolean).join(", ");

export function demoCompaniesHouse(): CompaniesHouseProvider {
  return {
    info: () => ({ mode: "demo", name: "Built-in Companies House sample register", ready: true }),
    async search(q) {
      const words = q.toUpperCase().split(/\s+/).filter(Boolean);
      return REGISTER.filter((c) => words.every((w) => c.name.includes(w) || c.companyNumber === w))
        .slice(0, 10).map((c) => ({ companyNumber: c.companyNumber, name: c.name, status: c.status, address: oneLine(c.address) }));
    },
    async profile(number) {
      const c = REGISTER.find((x) => x.companyNumber === number.toUpperCase());
      if (!c) return null;
      const { vat: _vat, ...profile } = c;
      return profile;
    },
  };
}

export function liveCompaniesHouse(env: NodeJS.ProcessEnv = process.env): CompaniesHouseProvider {
  const base = "https://api.company-information.service.gov.uk";
  const need = missing(env, ["COMPANIES_HOUSE_API_KEY"]);
  const headers = () => ({ authorization: `Basic ${Buffer.from(`${env.COMPANIES_HOUSE_API_KEY}:`).toString("base64")}` });
  type Addr = { address_line_1?: string; address_line_2?: string; locality?: string; postal_code?: string; country?: string };
  const addr = (a: Addr = {}) => ({ line1: a.address_line_1, line2: a.address_line_2, city: a.locality, postcode: a.postal_code, country: "GB" });
  return {
    info: () => ({ mode: "live", name: "Companies House API", ready: !need.length, missing: need }),
    async search(q) {
      type Item = { company_number: string; title: string; company_status: string; address_snippet?: string };
      const r = await httpJson<{ items?: Item[] }>(`${base}/search/companies?${new URLSearchParams({ q, items_per_page: "10" })}`, { headers: headers() });
      return (r.items ?? []).map((i) => ({ companyNumber: i.company_number, name: i.title, status: i.company_status, address: i.address_snippet ?? "" }));
    },
    async profile(number) {
      type P = { company_number: string; company_name: string; company_status: string; type: string; date_of_creation?: string; sic_codes?: string[]; registered_office_address?: Addr };
      try {
        const p = await httpJson<P>(`${base}/company/${encodeURIComponent(number.toUpperCase())}`, { headers: headers() });
        return { companyNumber: p.company_number, name: p.company_name, status: p.company_status, type: p.type,
          incorporatedOn: p.date_of_creation, sicCodes: p.sic_codes ?? [], address: addr(p.registered_office_address) };
      } catch (e) {
        if ((e as { upstreamStatus?: number }).upstreamStatus === 404) return null;
        throw e;
      }
    },
  };
}

// ---------------------------------------------------------------- HMRC check a UK VAT number

export function demoVatCheck(): VatCheckProvider {
  return {
    info: () => ({ mode: "demo", name: "Built-in VAT register sample", ready: true }),
    async check(vatNumber, requesterVrn) {
      const n = vatNumber.replace(/^GB/i, "").replace(/\s/g, "");
      const c = REGISTER.find((x) => x.vat === n);
      const checkedAt = new Date().toISOString();
      if (!c && !vatChecksumOk(n)) return { valid: false, vatNumber: n, checkedAt };
      return {
        valid: Boolean(c), vatNumber: n, name: c?.name, address: c ? oneLine(c.address) : undefined, checkedAt,
        consultationNumber: requesterVrn && c ? createHash("sha256").update(`${requesterVrn}${n}${checkedAt.slice(0, 10)}`).digest("hex").slice(0, 9).toUpperCase().replace(/(...)(...)(...)/, "$1-$2-$3") : undefined,
      };
    },
  };
}

/** HMRC "Check a UK VAT number" API v2 (application-restricted: client credentials). */
export function liveVatCheck(env: NodeJS.ProcessEnv = process.env): VatCheckProvider {
  const base = env.HMRC_ENV === "production" ? "https://api.service.hmrc.gov.uk" : "https://test-api.service.hmrc.gov.uk";
  const need = missing(env, ["HMRC_CLIENT_ID", "HMRC_CLIENT_SECRET"]);
  let cached: { token: string; until: number } | undefined;
  async function token() {
    if (cached && cached.until > Date.now()) return cached.token;
    const r = await httpJson<{ access_token: string; expires_in: number }>(`${base}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.HMRC_CLIENT_ID ?? "", client_secret: env.HMRC_CLIENT_SECRET ?? "", scope: "read:vat" }),
    });
    cached = { token: r.access_token, until: Date.now() + (r.expires_in - 60) * 1000 };
    return cached.token;
  }
  return {
    info: () => ({ mode: "live", name: "HMRC Check a UK VAT number", ready: !need.length, missing: need }),
    async check(vatNumber, requesterVrn) {
      const n = vatNumber.replace(/^GB/i, "").replace(/\s/g, "");
      const path = requesterVrn ? `lookup/${n}/${requesterVrn}` : `lookup/${n}`;
      type R = { target: { name: string; vatNumber: string; address: Record<string, string> }; processingDate: string; consultationNumber?: string };
      try {
        const r = await httpJson<R>(`${base}/organisations/vat/check-vat-number/${path}`, {
          headers: { accept: "application/vnd.hmrc.2.0+json", authorization: `Bearer ${await token()}` } });
        return { valid: true, vatNumber: r.target.vatNumber, name: r.target.name, address: Object.values(r.target.address).join(", "),
          consultationNumber: r.consultationNumber, checkedAt: r.processingDate };
      } catch (e) {
        if ((e as { upstreamStatus?: number }).upstreamStatus === 404) return { valid: false, vatNumber: n, checkedAt: new Date().toISOString() };
        throw e;
      }
    },
  };
}

// ---------------------------------------------------------------- email

/** Demo mode keeps every message in the outbox, marked sent, so it can be read in the app. Nothing leaves the server. */
export function demoEmail(): EmailProvider {
  return {
    info: () => ({ mode: "demo", name: "Outbox only (nothing is sent)", ready: true }),
    send: async () => ({ id: `demo-${randomUUID()}` }),
  };
}

export function liveEmail(env: NodeJS.ProcessEnv = process.env): EmailProvider {
  const need = missing(env, ["POSTMARK_SERVER_TOKEN", "EMAIL_FROM"]);
  return {
    info: () => ({ mode: "live", name: "Postmark", ready: !need.length, missing: need }),
    async send(m) {
      const r = await httpJson<{ MessageID: string }>("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "x-postmark-server-token": env.POSTMARK_SERVER_TOKEN ?? "" },
        body: JSON.stringify({
          From: `${m.fromName} <${env.EMAIL_FROM}>`, To: m.toName ? `${m.toName} <${m.to}>` : m.to, ReplyTo: m.replyTo,
          Subject: m.subject, TextBody: m.text, MessageStream: "outbound",
        }),
      });
      return { id: r.MessageID };
    },
  };
}

// ---------------------------------------------------------------- exchange rates

/** Month-average GBP per unit through 2025-2026, shaped like the published series. */
const ANCHORS: Record<string, number[]> = {
  //       Jan    Feb    Mar    Apr    May    Jun    Jul    Aug    Sep    Oct    Nov    Dec
  USD25: [0.810, 0.798, 0.775, 0.762, 0.750, 0.737, 0.741, 0.744, 0.741, 0.748, 0.760, 0.752],
  USD26: [0.800, 0.795, 0.790, 0.792, 0.790, 0.782, 0.770, 0.758, 0.752, 0.756, 0.754, 0.750],
  EUR25: [0.838, 0.829, 0.837, 0.856, 0.843, 0.851, 0.861, 0.865, 0.869, 0.872, 0.878, 0.874],
  EUR26: [0.869, 0.866, 0.862, 0.864, 0.861, 0.858, 0.855, 0.851, 0.848, 0.852, 0.850, 0.849],
};

function anchor(cur: string, date: string): number | null {
  const y = date.slice(2, 4);
  const m = Number(date.slice(5, 7)) - 1;
  const usd = ANCHORS[`USD${y}`]?.[m] ?? ANCHORS.USD26![11]!;
  if (cur === "USD") return usd;
  if (cur === "EUR") return ANCHORS[`EUR${y}`]?.[m] ?? ANCHORS.EUR26![11]!;
  if (cur === "CNY") return usd / 7.18;
  if (cur === "HKD") return usd / 7.8;
  return null;
}

function lastWorkingDay(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Deterministic daily rates around the monthly averages (within ±0.4%), published on working days only. */
export function demoFx(): FxProvider {
  return {
    info: () => ({ mode: "demo", name: "Built-in reference rates", ready: true }),
    async rates(date, currencies) {
      const day = lastWorkingDay(date);
      return currencies.flatMap((c) => {
        const a = anchor(c, day);
        if (a === null) return [];
        const wobble = (parseInt(createHash("sha256").update(`${c}${day}`).digest("hex").slice(0, 4), 16) / 0xffff - 0.5) * 0.008;
        return [{ currency: c, date: day, rate: (a * (1 + wobble)).toFixed(6) }];
      });
    },
  };
}

/** European Central Bank reference rates via the Frankfurter API (no key needed). */
export function liveFx(): FxProvider {
  return {
    info: () => ({ mode: "live", name: "ECB reference rates (Frankfurter)", ready: true }),
    async rates(date, currencies) {
      const want = currencies.filter((c) => c !== "GBP");
      if (!want.length) return [];
      const r = await httpJson<{ date: string; rates: Record<string, number> }>(
        `https://api.frankfurter.dev/v1/${date}?${new URLSearchParams({ base: "GBP", symbols: want.join(",") })}`);
      // Frankfurter gives units per pound; Softilo stores pounds per unit.
      return Object.entries(r.rates).map(([currency, perGbp]) => ({ currency, date: r.date, rate: (1 / perGbp).toFixed(6) }));
    },
  };
}
