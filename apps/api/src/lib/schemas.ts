import { VAT_CODES } from "@softilo/domain";
import { z } from "zod";

/** Decimal amounts travel as strings (or numbers from simple clients) and never become floats in the ledger. */
export const money = z.union([z.string(), z.number()]).transform(String)
  .refine((v) => /^-?\d{1,15}(\.\d{1,2})?$/.test(v), "Must be an amount with at most 2 decimal places");
export const positiveMoney = money.refine((v) => Number(v) > 0, "Must be greater than zero");
export const quantity = z.union([z.string(), z.number()]).transform(String)
  .refine((v) => /^\d{1,14}(\.\d{1,4})?$/.test(v) && Number(v) > 0, "Must be a positive quantity (max 4 decimal places)");
export const unitPrice = z.union([z.string(), z.number()]).transform(String)
  .refine((v) => /^\d{1,13}(\.\d{1,6})?$/.test(v), "Must be a price with at most 6 decimal places");
export const rate = z.union([z.string(), z.number()]).transform(String)
  .refine((v) => /^\d{1,10}(\.\d{1,8})?$/.test(v) && Number(v) > 0, "Must be a positive exchange rate");
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((v) => !Number.isNaN(Date.parse(v)), "Not a real date");
export const uuid = z.uuid();
export const currency = z.string().length(3).transform((c) => c.toUpperCase());
export const vatCode = z.enum(Object.keys(VAT_CODES) as [keyof typeof VAT_CODES, ...(keyof typeof VAT_CODES)[]]);
export const accountCode = z.string().regex(/^\d{4}$/, "Account codes are 4 digits");

export const IdParams = z.object({ id: uuid });

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** GBP documents must use rate 1; foreign-currency documents need a rate. */
export function checkRate(cur: string, r: string | undefined): string {
  if (cur === "GBP") return "1";
  if (!r) throw Object.assign(new Error(`An exchange rate (GBP per 1 ${cur}) is required for ${cur} documents`), { statusCode: 400 });
  return r;
}
