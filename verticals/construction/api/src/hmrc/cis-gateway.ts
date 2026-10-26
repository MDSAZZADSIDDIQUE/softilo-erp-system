import { createHash } from "node:crypto";
import type { Cis300Preview, CisStatus } from "@softilo/construction-domain";

/**
 * HMRC CIS online services: subcontractor verification and the monthly CIS300 return.
 * The live service (Government Gateway / Transaction Engine XML) needs credentials Softilo does
 * not hold yet, so everything goes through this interface. Only the stub exists today.
 */
export interface VerificationRequest {
  contractorUtr: string | null;
  employerRef: string | null;
  businessType: "sole_trader" | "partnership" | "company" | "trust";
  name: string;
  utr: string;
  nino?: string | null;
  companyNumber?: string | null;
}

export interface VerificationResult {
  status: CisStatus;
  /** HMRC issues a verification number; for unmatched subcontractors it carries a letter suffix. */
  verificationNumber: string;
  raw: Record<string, unknown>;
}

export interface ReturnReceipt {
  correlationId: string;
  submittedAt: string;
  raw: Record<string, unknown>;
}

export interface CisGateway {
  readonly name: string;
  verify(req: VerificationRequest): Promise<VerificationResult>;
  submitReturn(header: { contractorUtr: string; employerRef: string }, preview: Cis300Preview): Promise<ReturnReceipt>;
}

/**
 * Deterministic stand-in for HMRC. The last digit of the UTR decides the answer, so tests and
 * demos can exercise every rate: 0–1 gross, 2–7 net (20%), 8–9 unmatched (30%).
 */
export class StubCisGateway implements CisGateway {
  readonly name = "stub";

  async verify(req: VerificationRequest): Promise<VerificationResult> {
    if (!/^\d{10}$/.test(req.utr)) throw new Error("A UTR is 10 digits");
    if (req.businessType === "sole_trader" && req.nino && /^(TN|\d{2})/i.test(req.nino)) {
      throw new Error("Temporary National Insurance numbers cannot be verified");
    }
    const last = Number(req.utr.at(-1));
    const status: CisStatus = last <= 1 ? "gross" : last <= 7 ? "net" : "unmatched";
    const digits = BigInt(`0x${createHash("sha256").update(req.utr).digest("hex").slice(0, 12)}`).toString().slice(0, 10).padStart(10, "0");
    const verificationNumber = `V${digits}${status === "unmatched" ? "A" : ""}`;
    return { status, verificationNumber, raw: { stub: true, utr: req.utr, status } };
  }

  async submitReturn(header: { contractorUtr: string; employerRef: string }, preview: Cis300Preview): Promise<ReturnReceipt> {
    const submittedAt = new Date().toISOString();
    const correlationId = createHash("sha256").update(JSON.stringify({ header, month: preview.month.end, submittedAt })).digest("hex").slice(0, 32).toUpperCase();
    return { correlationId, submittedAt, raw: { stub: true, month: preview.month.end, subcontractors: preview.totals.subcontractors } };
  }
}
