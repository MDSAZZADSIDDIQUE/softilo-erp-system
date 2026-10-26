import { d, round2, type Dec, type DecInput } from "@softilo/domain";

/** £1,234.56 for messages shown to users. */
export function pounds(v: Dec): string {
  const [whole, pence] = v.toFixed(2).split(".");
  return `£${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${pence}`;
}

/**
 * SRA Accounts Rules 2019, rule 5.3: client money may only be withdrawn if enough is held
 * for that client. Softilo applies this per matter: no matter's client ledger may go below zero.
 */
export class ClientLedgerOverdrawnError extends Error {
  constructor(public balance: Dec, public amount: Dec) {
    super(`This would overdraw the matter's client ledger: ${pounds(balance)} is held and ${pounds(amount)} was requested`);
  }
}

/** Rule 4.3: costs may only be taken from client money against a bill, for no more than the sum billed. */
export class TransferNotAllowedError extends Error {}

function positive(amount: DecInput, what: string): Dec {
  const a = round2(amount);
  if (a.lessThanOrEqualTo(0)) throw new RangeError(`${what} must be greater than zero`);
  return a;
}

/** Check a withdrawal from a matter's client ledger and return the balance left. */
export function withdrawClientMoney(balance: DecInput, amount: DecInput): Dec {
  const a = positive(amount, "A payment");
  const b = round2(balance);
  if (a.greaterThan(b)) throw new ClientLedgerOverdrawnError(b, a);
  return b.minus(a);
}

export interface TransferCheck {
  clientBalance: DecInput;
  /** What is still unpaid on the fee note being settled. */
  feeNoteOutstanding: DecInput;
  amount: DecInput;
}

/** Check a client-to-office transfer against both the client ledger and the fee note. */
export function checkTransfer(t: TransferCheck): Dec {
  const a = positive(t.amount, "A transfer");
  const outstanding = round2(t.feeNoteOutstanding);
  if (a.greaterThan(outstanding)) {
    throw new TransferNotAllowedError(`The transfer is more than the ${pounds(outstanding)} still unpaid on the fee note`);
  }
  withdrawClientMoney(t.clientBalance, a);
  return a;
}

/** The most that can be transferred now: the smaller of the client balance and what is unpaid. */
export function maxTransfer(clientBalance: DecInput, feeNoteOutstanding: DecInput): Dec {
  const c = round2(clientBalance);
  const o = round2(feeNoteOutstanding);
  const m = c.lessThan(o) ? c : o;
  return m.isNegative() ? d(0) : m;
}
