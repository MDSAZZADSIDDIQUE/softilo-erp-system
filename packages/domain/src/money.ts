import { Decimal } from "decimal.js";

/**
 * All money and quantity arithmetic goes through this Decimal configuration.
 * Floats are never used for amounts. Rounding is half-up, matching HMRC guidance
 * for VAT and what UK accountants expect on documents.
 */
export const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = Decimal;
export type DecInput = Decimal.Value;

export const ZERO = new Dec(0);

export function d(value: DecInput): Dec {
  return new Dec(value);
}

/** Round to whole pence. */
export function round2(value: DecInput): Dec {
  return new Dec(value).toDecimalPlaces(2, Dec.ROUND_HALF_UP);
}

/** Unit costs are held to 6 decimal places: landed cost per unit is often below 1p. */
export function round6(value: DecInput): Dec {
  return new Dec(value).toDecimalPlaces(6, Dec.ROUND_HALF_UP);
}

export function sum(values: Iterable<DecInput>): Dec {
  let total = new Dec(0);
  for (const v of values) total = total.plus(v);
  return total;
}

/** Fixed-point string for storage in Postgres numeric columns. */
export function toFixed(value: DecInput, places = 2): string {
  return new Dec(value).toFixed(places);
}

export function isZero(value: DecInput): boolean {
  return new Dec(value).isZero();
}

/** Convert a document-currency amount into GBP at `rate` (GBP per 1 unit of currency). */
export function toBase(amount: DecInput, rate: DecInput): Dec {
  return round2(new Dec(amount).times(rate));
}
