import type { RoleMap } from "./chart.js";
import { cr, dr, finalise, type JournalLine, type Posting } from "./ledger.js";
import { d, round2, sum, toBase, type Dec, type DecInput } from "./money.js";
import { chargedVat, lineVat, vatCode, type VatCode, type VatEntry } from "./vat.js";

/**
 * Posting rules: each business document becomes one balanced journal (plus VAT entries).
 * Inputs are already-validated document data; amounts in document currency unless named *Gbp.
 * `rate` is GBP per one unit of document currency (1 for GBP documents).
 */

export interface GoodsReceiptInput {
  date: string;
  reference: string;
  lines: { valueGbp: DecInput; description?: string }[];
}

/** Goods in: Dr Stock, Cr Goods received not invoiced. */
export function postGoodsReceipt(acc: RoleMap, g: GoodsReceiptInput): Posting {
  const lines: JournalLine[] = [];
  for (const l of g.lines) {
    lines.push(dr(acc.stock, l.valueGbp, l.description));
    lines.push(cr(acc.grni, l.valueGbp, l.description));
  }
  return { journal: finalise({ date: g.date, memo: `Goods received ${g.reference}`, lines }), vat: [] };
}

export type BillLine =
  | { kind: "receipt"; net: DecInput; vatCode: VatCode; grniValueGbp: DecInput; description?: string }
  | { kind: "account"; net: DecInput; vatCode: VatCode; account: string; description?: string };

export interface SupplierBillInput {
  date: string;
  reference: string;
  rate: DecInput;
  /** -1 for a supplier credit note. */
  sign?: 1 | -1;
  lines: BillLine[];
}

export interface BillPosting extends Posting {
  /** What the supplier is owed, in document currency and in GBP. */
  total: Dec;
  totalGbp: Dec;
}

/**
 * Supplier bill. Receipt lines clear GRNI at the value booked on receipt; any difference
 * (price or exchange rate) goes to purchase price variance. Self-accounted VAT (reverse charge)
 * is posted to both input and output VAT and not owed to the supplier.
 */
export function postSupplierBill(acc: RoleMap, b: SupplierBillInput): BillPosting {
  const s = b.sign ?? 1;
  const lines: JournalLine[] = [];
  const vat: VatEntry[] = [];
  const owed: Dec[] = [];
  const owedGbp: Dec[] = [];
  for (const l of b.lines) {
    const net = round2(d(l.net).times(s));
    const netGbp = toBase(net, b.rate);
    const vatDoc = lineVat(net, l.vatCode);
    const vatGbp = toBase(vatDoc, b.rate);
    const charged = chargedVat(net, l.vatCode);
    if (l.kind === "receipt") {
      const grni = round2(d(l.grniValueGbp).times(s));
      lines.push(dr(acc.grni, grni, l.description));
      lines.push(dr(acc.ppv, netGbp.minus(grni), l.description));
    } else {
      lines.push(dr(l.account, netGbp, l.description));
    }
    if (!vatGbp.isZero()) {
      lines.push(dr(acc.vat_input, vatGbp));
      if (vatCode(l.vatCode).selfAccounted) lines.push(cr(acc.vat_output, vatGbp));
    }
    vat.push({ direction: "purchase", code: l.vatCode, net: netGbp, vat: vatGbp });
    owed.push(net.plus(charged));
    owedGbp.push(netGbp.plus(toBase(charged, b.rate)));
  }
  const totalGbp = sum(owedGbp);
  lines.push(cr(acc.creditors, totalGbp));
  const memo = `${s === 1 ? "Supplier bill" : "Supplier credit"} ${b.reference}`;
  return { journal: finalise({ date: b.date, memo, lines }), vat, total: sum(owed), totalGbp };
}

export interface SalesLine {
  net: DecInput;
  vatCode: VatCode;
  account?: string;
  /** Cost of stock issued (or returned on a credit), in GBP, from the costing engine. */
  costGbp?: DecInput;
  description?: string;
}

export interface SalesInvoiceInput {
  date: string;
  reference: string;
  rate: DecInput;
  /** -1 for a credit note. */
  sign?: 1 | -1;
  lines: SalesLine[];
}

/** Sales invoice: Dr Debtors, Cr Sales, Cr VAT output; and Dr COGS, Cr Stock for goods sold. */
export function postSalesInvoice(acc: RoleMap, inv: SalesInvoiceInput): BillPosting {
  const s = inv.sign ?? 1;
  const lines: JournalLine[] = [];
  const vat: VatEntry[] = [];
  const owed: Dec[] = [];
  const owedGbp: Dec[] = [];
  for (const l of inv.lines) {
    const net = round2(d(l.net).times(s));
    const netGbp = toBase(net, inv.rate);
    const charged = chargedVat(net, l.vatCode);
    const chargedGbp = toBase(charged, inv.rate);
    lines.push(cr(l.account ?? acc.sales, netGbp, l.description));
    if (!chargedGbp.isZero()) lines.push(cr(acc.vat_output, chargedGbp));
    if (l.costGbp !== undefined && !d(l.costGbp).isZero()) {
      const cost = round2(d(l.costGbp).times(s));
      lines.push(dr(acc.cogs, cost, l.description));
      lines.push(cr(acc.stock, cost, l.description));
    }
    vat.push({ direction: "sales", code: l.vatCode, net: netGbp, vat: chargedGbp });
    owed.push(net.plus(charged));
    owedGbp.push(netGbp.plus(chargedGbp));
  }
  const totalGbp = sum(owedGbp);
  lines.push(dr(acc.debtors, totalGbp));
  const memo = `${s === 1 ? "Sales invoice" : "Credit note"} ${inv.reference}`;
  return { journal: finalise({ date: inv.date, memo, lines }), vat, total: sum(owed), totalGbp };
}

export interface PaymentInput {
  date: string;
  reference: string;
  /** "receipt" = money in from a customer; "payment" = money out to a supplier. */
  direction: "receipt" | "payment";
  bankAccount: string;
  amount: DecInput;
  rate: DecInput;
  /** Amounts applied to open documents, with the rate each document was posted at. */
  allocations: { amount: DecInput; documentRate: DecInput }[];
}

/**
 * Customer receipt or supplier payment. The control account is cleared at each document's
 * original rate; the difference against the bank amount is a realised FX gain or loss.
 * Any unallocated amount stays on account at the payment rate.
 */
export function postPayment(acc: RoleMap, p: PaymentInput): Posting {
  const amount = round2(p.amount);
  const allocated = sum(p.allocations.map((a) => round2(a.amount)));
  if (allocated.greaterThan(amount)) throw new Error("Allocations exceed the payment amount");
  const bankGbp = toBase(amount, p.rate);
  const controlGbp = sum(p.allocations.map((a) => toBase(a.amount, a.documentRate)))
    .plus(toBase(amount.minus(allocated), p.rate));
  const fx = bankGbp.minus(controlGbp);
  const lines: JournalLine[] = p.direction === "receipt"
    ? [dr(p.bankAccount, bankGbp), cr(acc.debtors, controlGbp), cr(acc.fx, fx)]
    : [cr(p.bankAccount, bankGbp), dr(acc.creditors, controlGbp), dr(acc.fx, fx)];
  const memo = `${p.direction === "receipt" ? "Customer receipt" : "Supplier payment"} ${p.reference}`;
  return { journal: finalise({ date: p.date, memo, lines }), vat: [] };
}

export interface LandedCostInput {
  date: string;
  reference: string;
  /** Portion of allocated cost on stock still held. */
  stockGbp: DecInput;
  /** Portion on units already sold. */
  cogsGbp: DecInput;
}

/** Landed cost: clear the landed-cost clearing account into stock and cost of sales. */
export function postLandedCost(acc: RoleMap, l: LandedCostInput): Posting {
  const total = round2(d(l.stockGbp).plus(l.cogsGbp));
  return {
    journal: finalise({
      date: l.date,
      memo: `Landed cost ${l.reference}`,
      lines: [dr(acc.stock, l.stockGbp), dr(acc.cogs, l.cogsGbp), cr(acc.landed_cost_clearing, total)],
    }),
    vat: [],
  };
}

export interface PvaInput {
  date: string;
  reference: string;
  valueGbp: DecInput;
  vatGbp: DecInput;
}

/** Postponed import VAT from the monthly CDS statement: input and output VAT cancel out. */
export function postPva(acc: RoleMap, p: PvaInput): Posting {
  return {
    journal: finalise({
      date: p.date,
      memo: `Postponed import VAT ${p.reference}`,
      lines: [dr(acc.vat_input, p.vatGbp), cr(acc.vat_output, p.vatGbp)],
    }),
    vat: [{ direction: "purchase", code: "PVA20", net: round2(p.valueGbp), vat: round2(p.vatGbp) }],
  };
}

export interface StockAdjustmentInput {
  date: string;
  reference: string;
  /** Positive = stock found / written up; negative = stock lost / written down. */
  valueGbp: DecInput;
  offsetAccount: string;
}

export function postStockAdjustment(acc: RoleMap, a: StockAdjustmentInput): Posting {
  return {
    journal: finalise({
      date: a.date,
      memo: `Stock adjustment ${a.reference}`,
      lines: [dr(acc.stock, a.valueGbp), cr(a.offsetAccount, a.valueGbp)],
    }),
    vat: [],
  };
}

/**
 * VAT return settlement: move the period's output and input VAT into the VAT liability account,
 * leaving what is owed to (or due from) HMRC.
 */
export function postVatSettlement(acc: RoleMap, date: string, period: string, box1: DecInput, box4: DecInput): Posting {
  return {
    journal: finalise({
      date,
      memo: `VAT return ${period}`,
      lines: [
        dr(acc.vat_output, box1),
        cr(acc.vat_input, box4),
        cr(acc.vat_control, d(box1).minus(box4)),
      ],
    }),
    vat: [],
  };
}

export interface BankEntryInput {
  date: string;
  reference: string;
  bankAccount: string;
  /** Bank amount, VAT-inclusive: positive = money in, negative = money out. */
  gross: DecInput;
  account: string;
  vatCode: VatCode;
  description?: string;
}

/**
 * A bank line coded straight to an account (bank charges, rent, a refund received).
 * VAT is extracted from the gross amount: vat = gross × rate / (1 + rate).
 */
export function postBankEntry(acc: RoleMap, b: BankEntryInput): Posting {
  const gross = round2(b.gross);
  const def = vatCode(b.vatCode);
  if (def.selfAccounted) throw new Error("Reverse charge and postponed VAT cannot be coded from a bank line");
  const rateD = d(def.rate);
  const vatAbs = round2(gross.abs().times(rateD).dividedBy(rateD.plus(1)));
  const netAbs = gross.abs().minus(vatAbs);
  const moneyIn = gross.isPositive();
  const lines: JournalLine[] = moneyIn
    ? [dr(b.bankAccount, gross.abs()), cr(b.account, netAbs, b.description), cr(acc.vat_output, vatAbs)]
    : [cr(b.bankAccount, gross.abs()), dr(b.account, netAbs, b.description), dr(acc.vat_input, vatAbs)];
  return {
    journal: finalise({ date: b.date, memo: `${moneyIn ? "Bank receipt" : "Bank payment"} ${b.reference}`, lines }),
    vat: [{ direction: moneyIn ? "sales" : "purchase", code: b.vatCode, net: netAbs, vat: vatAbs }],
  };
}
