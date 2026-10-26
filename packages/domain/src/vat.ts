import { d, round2, sum, ZERO, type Dec, type DecInput } from "./money.js";

/**
 * UK VAT codes. Each code says how a line is taxed and which boxes of the
 * 9-box VAT return it feeds, separately for sales and purchases.
 */
export type VatCode = "S20" | "R5" | "Z0" | "EX" | "OS" | "RC20" | "PVA20";

export type VatBox = 1 | 4 | 6 | 7;

export interface VatCodeDef {
  code: VatCode;
  name: string;
  rate: string;
  /** Boxes fed by a sales line: VAT into box 1, net into box 6. */
  sales: { vat: VatBox[]; net: VatBox[] };
  /** Boxes fed by a purchase line: VAT into box 4, net into box 7. */
  purchase: { vat: VatBox[]; net: VatBox[] };
  /** True when the customer/supplier does not pay the VAT on the invoice (reverse charge, PVA). */
  selfAccounted: boolean;
}

export const VAT_CODES: Record<VatCode, VatCodeDef> = {
  S20: { code: "S20", name: "Standard rate 20%", rate: "0.20", sales: { vat: [1], net: [6] }, purchase: { vat: [4], net: [7] }, selfAccounted: false },
  R5: { code: "R5", name: "Reduced rate 5%", rate: "0.05", sales: { vat: [1], net: [6] }, purchase: { vat: [4], net: [7] }, selfAccounted: false },
  Z0: { code: "Z0", name: "Zero rated", rate: "0", sales: { vat: [], net: [6] }, purchase: { vat: [], net: [7] }, selfAccounted: false },
  EX: { code: "EX", name: "Exempt", rate: "0", sales: { vat: [], net: [6] }, purchase: { vat: [], net: [7] }, selfAccounted: false },
  OS: { code: "OS", name: "Outside the scope of VAT", rate: "0", sales: { vat: [], net: [] }, purchase: { vat: [], net: [] }, selfAccounted: false },
  // Domestic reverse charge: the supplier charges no VAT; the buyer declares output and input VAT.
  RC20: { code: "RC20", name: "Domestic reverse charge 20%", rate: "0.20", sales: { vat: [], net: [6] }, purchase: { vat: [1, 4], net: [7] }, selfAccounted: true },
  // Postponed VAT accounting on imports: import VAT declared in boxes 1 and 4, value in box 7.
  PVA20: { code: "PVA20", name: "Postponed import VAT 20%", rate: "0.20", sales: { vat: [], net: [] }, purchase: { vat: [1, 4], net: [7] }, selfAccounted: true },
};

export function vatCode(code: string): VatCodeDef {
  const def = VAT_CODES[code as VatCode];
  if (!def) throw new Error(`Unknown VAT code: ${code}`);
  return def;
}

/** VAT on a single line, rounded half-up to the penny. */
export function lineVat(net: DecInput, code: VatCode): Dec {
  return round2(d(net).times(vatCode(code).rate));
}

/** VAT the counterparty actually pays on the invoice (zero for self-accounted codes). */
export function chargedVat(net: DecInput, code: VatCode): Dec {
  return vatCode(code).selfAccounted ? ZERO : lineVat(net, code);
}

/** A VAT-relevant amount produced by a posting, in GBP. */
export interface VatEntry {
  direction: "sales" | "purchase";
  code: VatCode;
  net: Dec;
  vat: Dec;
}

export interface VatReturn {
  box1: string; box2: string; box3: string; box4: string; box5: string;
  box6: string; box7: string; box8: string; box9: string;
}

/**
 * Build the 9-box return from VAT entries in a period.
 * Boxes 1–5 are in pounds and pence; boxes 6–9 are whole pounds (pence dropped, as HMRC allows).
 * Boxes 2, 8 and 9 relate to Northern Ireland/EU goods movements, which are not yet supported.
 */
export function buildVatReturn(entries: Iterable<VatEntry>): VatReturn {
  const boxes = new Map<VatBox, Dec[]>([[1, []], [4, []], [6, []], [7, []]]);
  for (const e of entries) {
    const rule = vatCode(e.code)[e.direction];
    for (const b of rule.vat) boxes.get(b)!.push(e.vat);
    for (const b of rule.net) boxes.get(b)!.push(e.net);
  }
  const box1 = round2(sum(boxes.get(1)!));
  const box2 = d(0);
  const box3 = box1.plus(box2);
  const box4 = round2(sum(boxes.get(4)!));
  const box5 = box3.minus(box4).abs();
  const whole = (v: Dec) => v.truncated().toFixed(0);
  return {
    box1: box1.toFixed(2), box2: box2.toFixed(2), box3: box3.toFixed(2),
    box4: box4.toFixed(2), box5: box5.toFixed(2),
    box6: whole(sum(boxes.get(6)!)), box7: whole(sum(boxes.get(7)!)),
    box8: "0", box9: "0",
  };
}
