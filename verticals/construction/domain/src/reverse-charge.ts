import type { VatCode } from "@softilo/domain";

/**
 * VAT domestic reverse charge for building and construction services (VAT Act 1994 s55A,
 * in force since 1 March 2021). When it applies, the supplier charges no VAT and the customer
 * accounts for it on their own return: the supplier puts only the net value in box 6.
 *
 * It applies when all of these hold:
 *  - the supplier and customer are both VAT registered in the UK;
 *  - the services are construction operations within CIS and payment is reported under CIS
 *    (so the customer is a CIS contractor);
 *  - the supply is standard or reduced rated (never zero rated);
 *  - the customer has not confirmed in writing that they are an end user or intermediary supplier.
 * By agreement at the start of a contract, reverse-charge elements of 5% or less of the whole
 * contract value can be disregarded (the 5% disregard), assessed on contract value, not per invoice.
 */
export interface SalesVatContext {
  supplierVatRegistered: boolean;
  customerVatRegistered: boolean;
  /** The customer is a CIS contractor and will report the payment under CIS. */
  customerCisRegistered: boolean;
  /** Written confirmation held that the customer is an end user or intermediary supplier. */
  endUserOrIntermediary: boolean;
  rate: "standard" | "reduced" | "zero";
  /** Both parties agreed the 5% disregard at the start of the contract. */
  fivePercentDisregard?: boolean;
}

export interface SalesVatDecision {
  code: VatCode;
  reverseCharge: boolean;
  reason: string;
  /** Wording a reverse-charge invoice must carry. */
  invoiceNote?: string;
}

export const REVERSE_CHARGE_NOTE = "Reverse charge: VAT Act 1994 Section 55A applies. Customer to account to HMRC for the VAT.";

export function constructionSalesVat(c: SalesVatContext): SalesVatDecision {
  if (!c.supplierVatRegistered) return { code: "OS", reverseCharge: false, reason: "You are not VAT registered, so no VAT is charged" };
  if (c.rate === "zero") return { code: "Z0", reverseCharge: false, reason: "Zero-rated work is outside the reverse charge" };
  const normal: VatCode = c.rate === "reduced" ? "R5" : "S20";
  if (!c.customerVatRegistered) return { code: normal, reverseCharge: false, reason: "The customer is not VAT registered" };
  if (!c.customerCisRegistered) return { code: normal, reverseCharge: false, reason: "The payment is not reported under CIS" };
  if (c.endUserOrIntermediary) return { code: normal, reverseCharge: false, reason: "The customer has confirmed in writing they are an end user or intermediary supplier" };
  if (c.fivePercentDisregard) return { code: normal, reverseCharge: false, reason: "The 5% disregard was agreed for this contract" };
  if (c.rate === "reduced") {
    // The core VAT table has no reduced-rate reverse-charge code yet.
    throw new Error("Reverse charge at the reduced rate (5%) is not supported yet");
  }
  return { code: "RC20", reverseCharge: true, reason: "Domestic reverse charge applies", invoiceNote: REVERSE_CHARGE_NOTE };
}

/**
 * Default VAT code for a contractor's bill from a supplier. A VAT-registered CIS subcontractor
 * supplying construction services to a contractor (who makes onward supplies, so is not an end
 * user) bills under the reverse charge; a merchant charges VAT normally.
 */
export function purchaseVatDefault(supplier: { vatRegistered: boolean; cisSubcontractor: boolean }, contractorIsEndUser = false): VatCode {
  if (!supplier.vatRegistered) return "OS";
  if (supplier.cisSubcontractor && !contractorIsEndUser) return "RC20";
  return "S20";
}
