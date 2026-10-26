import { cr, dr, finalise, round2, type DecInput, type Posting, type SalesLine, type VatCode } from "@softilo/domain";
import type { RecAccounts } from "./accounts.js";
import type { PricedRate } from "./timesheet.js";

export interface WorkerPayAccrualInput {
  date: string;
  reference: string;
  pay: DecInput;
  holiday: DecInput;
  onCosts: DecInput;
  description?: string;
}

/**
 * Approved timesheet → the cost of the worker, accrued until it is paid:
 *   Dr Temporary worker pay, Dr Holiday pay, Dr Employer on-costs (cost of sales)
 *   Cr Temporary worker pay accrued (pay + on-costs), Cr Holiday pay accrued.
 * PAYE calculation and RTI are out of scope for now: a later pay run clears the accruals to net pay, HMRC and pension.
 */
export function postWorkerPayAccrual(acc: RecAccounts, a: WorkerPayAccrualInput): Posting {
  const pay = round2(a.pay);
  const holiday = round2(a.holiday);
  const onCosts = round2(a.onCosts);
  return {
    journal: finalise({
      date: a.date,
      memo: `Worker pay accrued ${a.reference}`,
      lines: [
        dr(acc.rec_worker_pay, pay, a.description),
        dr(acc.rec_holiday_pay, holiday, a.description),
        dr(acc.rec_oncosts, onCosts, a.description),
        cr(acc.rec_pay_accrued, pay.plus(onCosts), a.description),
        cr(acc.rec_holiday_accrued, holiday, a.description),
      ],
    }),
    vat: [],
  };
}

export interface InvoiceableTimesheet {
  number: string;
  weekEnding: string;
  workerName: string;
  jobTitle: string;
  byRate: Pick<PricedRate, "rateType" | "hours" | "chargeRate" | "charge">[];
}

export interface TimesheetInvoiceLine extends SalesLine {
  quantity: string;
  unitPrice: string;
}

const RATE_LABEL: Record<string, string> = { standard: "Standard", overtime: "Overtime", weekend: "Weekend", night: "Night" };

/**
 * One invoice line per timesheet and rate type, so the client sees hours × rate exactly as approved.
 * Supplies of staff are standard-rated in the UK, so lines default to S20.
 */
export function timesheetInvoiceLines(sheets: InvoiceableTimesheet[], account: string, vatCode: VatCode = "S20"): TimesheetInvoiceLine[] {
  const lines: TimesheetInvoiceLine[] = [];
  for (const t of sheets) {
    for (const r of t.byRate) {
      const label = RATE_LABEL[r.rateType] ?? r.rateType;
      lines.push({
        net: round2(r.charge), vatCode, account,
        quantity: r.hours.toString(), unitPrice: r.chargeRate.toString(),
        description: `${t.workerName}, ${t.jobTitle} – week ending ${t.weekEnding} – ${label} hours (${t.number})`,
      });
    }
  }
  return lines;
}
