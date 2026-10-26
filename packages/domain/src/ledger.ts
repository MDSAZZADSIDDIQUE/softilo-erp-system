import { d, round2, sum, ZERO, type Dec, type DecInput } from "./money.js";
import type { VatEntry } from "./vat.js";

export interface JournalLine {
  account: string;
  debit: Dec;
  credit: Dec;
  description?: string;
}

export interface JournalDraft {
  date: string;
  memo: string;
  lines: JournalLine[];
}

/** What every posting rule returns: a balanced journal plus any VAT entries for the return. */
export interface Posting {
  journal: JournalDraft;
  vat: VatEntry[];
}

export class UnbalancedJournalError extends Error {
  constructor(public debits: Dec, public credits: Dec) {
    super(`Journal does not balance: debits ${debits.toFixed(2)} ≠ credits ${credits.toFixed(2)}`);
  }
}

export function dr(account: string, amount: DecInput, description?: string): JournalLine {
  const a = round2(amount);
  return a.isNegative()
    ? { account, debit: ZERO, credit: a.neg(), description }
    : { account, debit: a, credit: ZERO, description };
}

export function cr(account: string, amount: DecInput, description?: string): JournalLine {
  const a = round2(amount);
  return a.isNegative()
    ? { account, debit: a.neg(), credit: ZERO, description }
    : { account, debit: ZERO, credit: a, description };
}

/**
 * Normalise a journal: drop zero lines, merge lines on the same account and description,
 * and check it balances. Every posting rule runs its result through this.
 */
export function finalise(draft: JournalDraft): JournalDraft {
  const merged = new Map<string, JournalLine>();
  for (const l of draft.lines) {
    const key = `${l.account}\u0000${l.description ?? ""}`;
    const prev = merged.get(key);
    const net = (prev ? prev.debit.minus(prev.credit) : ZERO).plus(l.debit).minus(l.credit);
    merged.set(key, net.isNegative()
      ? { account: l.account, debit: ZERO, credit: net.neg(), description: l.description }
      : { account: l.account, debit: net, credit: ZERO, description: l.description });
  }
  const lines = [...merged.values()].filter((l) => !l.debit.isZero() || !l.credit.isZero());
  const debits = sum(lines.map((l) => l.debit));
  const credits = sum(lines.map((l) => l.credit));
  if (!debits.equals(credits)) throw new UnbalancedJournalError(debits, credits);
  if (lines.length === 0) throw new Error("Journal has no non-zero lines");
  return { ...draft, lines };
}

export function journalTotal(j: JournalDraft): Dec {
  return sum(j.lines.map((l) => l.debit));
}

export function isBalanced(lines: { debit: DecInput; credit: DecInput }[]): boolean {
  return sum(lines.map((l) => d(l.debit))).equals(sum(lines.map((l) => d(l.credit))));
}
