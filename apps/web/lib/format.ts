const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const plain = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Money in accounting style: negatives in brackets. Amounts arrive as decimal strings. */
export function money(value: string | number | null | undefined, currency = "GBP"): string {
  if (value === null || value === undefined || value === "") return "–";
  const n = Number(value) + 0; // + 0 turns "-0.00" into plain zero, which would otherwise print as -£0.00
  const f = currency === "GBP" ? gbp : new Intl.NumberFormat("en-GB", { style: "currency", currency });
  return n < 0 ? `(${f.format(-n)})` : f.format(n);
}

export function amount(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "–";
  const n = Number(value);
  return n < 0 ? `(${plain.format(-n)})` : plain.format(n);
}

export function qty(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "–";
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 4 }).format(Number(value));
}

export function date(value: string | null | undefined): string {
  if (!value) return "–";
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return "–";
  return new Date(value).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function monthLabel(ym: string): string {
  return new Date(`${ym}-01T00:00:00`).toLocaleDateString("en-GB", { month: "short" });
}

export const VAT_CODES: { code: string; label: string }[] = [
  { code: "S20", label: "20% Standard" },
  { code: "R5", label: "5% Reduced" },
  { code: "Z0", label: "0% Zero rated" },
  { code: "EX", label: "Exempt" },
  { code: "OS", label: "Outside scope" },
  { code: "RC20", label: "Reverse charge 20%" },
];

export const VAT_RATE: Record<string, number> = { S20: 0.2, R5: 0.05, Z0: 0, EX: 0, OS: 0, RC20: 0, PVA20: 0 };

/** Pence-exact sum of decimal strings (avoids float drift in on-screen totals). */
export function sumPence(values: (string | number)[]): number {
  return values.reduce<number>((s, v) => s + Math.round(Number(v || 0) * 100), 0) / 100;
}

export function roundHalfUp(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n) * 100 + 1e-9) / 100;
}
