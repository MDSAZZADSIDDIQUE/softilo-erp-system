import { round2, sum, type Dec, type DecInput } from "@softilo/domain";

/** SRA Accounts Rules 2019, rule 8.3: reconcile client accounts at least every five weeks. */
export const RECONCILIATION_INTERVAL_DAYS = 35;

export interface ThreeWayInput {
  /** Closing balance on the client bank statement at the statement date. */
  statementBalance: DecInput;
  /** Receipts in the client cash book that the bank has not yet credited. */
  outstandingLodgements?: DecInput[];
  /** Payments in the client cash book that the bank has not yet paid out. */
  unpresentedPayments?: DecInput[];
  /** Client bank account balance in the ledger at the statement date. */
  cashBook: DecInput;
  /** Client money held (liability) in the ledger at the statement date, as a positive figure. */
  clientControl: DecInput;
  /** Client ledger balance of every matter at the statement date. */
  matterBalances: { matterId: string; balance: DecInput }[];
}

export interface ThreeWayResult {
  statementBalance: Dec;
  outstandingLodgements: Dec;
  unpresentedPayments: Dec;
  adjustedBank: Dec;
  cashBook: Dec;
  clientLedgers: Dec;
  clientControl: Dec;
  differences: { bankVsCashBook: Dec; cashBookVsLedgers: Dec; ledgersVsControl: Dec };
  overdrawn: { matterId: string; balance: Dec }[];
  balanced: boolean;
}

/**
 * Three-way reconciliation: adjusted bank statement vs. client cash book vs. sum of client matter ledgers.
 * Also checks the matter ledgers against the client money control account, and that no matter is overdrawn.
 */
export function threeWayReconciliation(i: ThreeWayInput): ThreeWayResult {
  const statementBalance = round2(i.statementBalance);
  const outstandingLodgements = round2(sum((i.outstandingLodgements ?? []).map((v) => round2(v))));
  const unpresentedPayments = round2(sum((i.unpresentedPayments ?? []).map((v) => round2(v))));
  const adjustedBank = statementBalance.plus(outstandingLodgements).minus(unpresentedPayments);
  const cashBook = round2(i.cashBook);
  const clientControl = round2(i.clientControl);
  const clientLedgers = round2(sum(i.matterBalances.map((m) => round2(m.balance))));
  const overdrawn = i.matterBalances
    .map((m) => ({ matterId: m.matterId, balance: round2(m.balance) }))
    .filter((m) => m.balance.lessThan(0));
  const differences = {
    bankVsCashBook: adjustedBank.minus(cashBook),
    cashBookVsLedgers: cashBook.minus(clientLedgers),
    ledgersVsControl: clientLedgers.minus(clientControl),
  };
  const balanced = Object.values(differences).every((v) => v.isZero()) && overdrawn.length === 0;
  return {
    statementBalance, outstandingLodgements, unpresentedPayments, adjustedBank,
    cashBook, clientLedgers, clientControl, differences, overdrawn, balanced,
  };
}

/** The latest date the next reconciliation can be done by: five weeks after this statement date. */
export function nextReconciliationDue(statementDate: string): string {
  const dt = new Date(`${statementDate}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) throw new RangeError(`Not a date: ${statementDate}`);
  dt.setUTCDate(dt.getUTCDate() + RECONCILIATION_INTERVAL_DAYS);
  return dt.toISOString().slice(0, 10);
}
