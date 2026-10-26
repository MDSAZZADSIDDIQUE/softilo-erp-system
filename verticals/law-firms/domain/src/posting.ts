import { cr, dr, finalise, lineVat, round2, sum, type Dec, type DecInput, type Posting, type VatCode } from "@softilo/domain";

/** Ledger accounts the law-firm posting rules use, by role. */
export interface LawAccounts {
  clientBank: string;
  clientControl: string;
  officeBank: string;
  debtors: string;
  fees: string;
  vatOutput: string;
}

export interface ClientMoneyInput {
  date: string;
  matter: string;
  reference: string;
  amount: DecInput;
}

/** Money received for a client: Dr Client bank, Cr Client money held. */
export function postClientReceipt(acc: LawAccounts, r: ClientMoneyInput): Posting {
  return {
    journal: finalise({
      date: r.date,
      memo: `Client receipt ${r.matter} ${r.reference}`,
      lines: [dr(acc.clientBank, r.amount), cr(acc.clientControl, r.amount)],
    }),
    vat: [],
  };
}

/** Client money paid out: Dr Client money held, Cr Client bank. */
export function postClientPayment(acc: LawAccounts, p: ClientMoneyInput): Posting {
  return {
    journal: finalise({
      date: p.date,
      memo: `Client payment ${p.matter} ${p.reference}`,
      lines: [dr(acc.clientControl, p.amount), cr(acc.clientBank, p.amount)],
    }),
    vat: [],
  };
}

export interface FeeNoteInput {
  date: string;
  number: string;
  matter: string;
  /** Profit costs: one value per time entry (or fixed fee line). */
  lines: { net: DecInput }[];
  vatCode: VatCode;
}

export interface FeeNotePosting extends Posting {
  net: Dec;
  vatAmount: Dec;
  total: Dec;
}

/**
 * Fee note for profit costs: Dr Debtors (gross), Cr Professional fees (net), Cr VAT output.
 * VAT is worked out once on the total fees, rounded half-up to the penny.
 */
export function postFeeNote(acc: LawAccounts, f: FeeNoteInput): FeeNotePosting {
  if (f.lines.length === 0) throw new RangeError("A fee note needs at least one line");
  const net = round2(sum(f.lines.map((l) => round2(l.net))));
  if (net.lessThanOrEqualTo(0)) throw new RangeError("A fee note must be for more than zero");
  const vatAmount = lineVat(net, f.vatCode);
  const total = net.plus(vatAmount);
  const journal = finalise({
    date: f.date,
    memo: `Fee note ${f.number} ${f.matter}`,
    lines: [dr(acc.debtors, total), cr(acc.fees, net), cr(acc.vatOutput, vatAmount)],
  });
  return { journal, vat: [{ direction: "sales", code: f.vatCode, net, vat: vatAmount }], net, vatAmount, total };
}

export interface TransferInput {
  date: string;
  matter: string;
  feeNote: string;
  amount: DecInput;
}

/**
 * Client to office transfer to settle a fee note. Both halves go in one balanced entry:
 * client side Dr Client money held / Cr Client bank; office side Dr Office bank / Cr Debtors.
 */
export function postClientToOffice(acc: LawAccounts, t: TransferInput): Posting {
  const a = round2(t.amount);
  return {
    journal: finalise({
      date: t.date,
      memo: `Transfer client to office ${t.matter} for ${t.feeNote}`,
      lines: [
        dr(acc.clientControl, a, "Client side"),
        cr(acc.clientBank, a, "Client side"),
        dr(acc.officeBank, a, "Office side"),
        cr(acc.debtors, a, "Office side"),
      ],
    }),
    vat: [],
  };
}
