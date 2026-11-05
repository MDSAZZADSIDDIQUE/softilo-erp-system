/**
 * Every external service Softilo talks to sits behind one of these interfaces.
 * Each has a demo provider (realistic, deterministic, no network) and a live provider (the real API).
 * Callers never know which one they have, so moving a tenant to live data is a configuration change.
 */
import type { VatReturn } from "@softilo/domain";

export type Mode = "demo" | "live";

export interface ProviderInfo {
  mode: Mode;
  /** Human name of what is behind this provider, e.g. "HMRC sandbox" or "Built-in demo". */
  name: string;
  /** Live providers that are missing credentials say what is needed. */
  ready: boolean;
  missing?: string[];
}

// ---------------------------------------------------------------- HMRC Making Tax Digital (VAT)

export interface VatObligation {
  periodKey: string;
  start: string;
  end: string;
  due: string;
  status: "O" | "F";
  received?: string;
}

export interface VatSubmissionReceipt {
  processingDate: string;
  formBundleNumber: string;
  paymentIndicator?: "DD" | "BANK";
  chargeRefNumber?: string;
}

/** Fraud-prevention data HMRC requires on every MTD call, gathered from the browser and the server. */
export interface FraudPreventionData {
  clientPublicIp?: string;
  clientPublicPort?: string;
  clientDeviceId?: string;
  clientUserIds?: Record<string, string>;
  clientTimezone?: string;
  clientScreens?: string;
  clientWindowSize?: string;
  clientBrowserJsUserAgent?: string;
  clientBrowserDoNotTrack?: string;
  clientMultiFactor?: string;
  vendorPublicIp?: string;
  vendorForwarded?: string;
}

export interface HmrcVatProvider {
  info(): ProviderInfo;
  /** URL to send the user to so they grant Softilo access to their VAT account (live only). */
  authoriseUrl(state: string, redirectUri: string): string | null;
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>;
  refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>;
  obligations(auth: HmrcAuth, from: string, to: string): Promise<VatObligation[]>;
  submit(auth: HmrcAuth, periodKey: string, boxes: VatReturn, fraud: FraudPreventionData): Promise<VatSubmissionReceipt>;
}

export interface HmrcAuth {
  vrn: string;
  accessToken?: string;
  /** Demo provider: which periods have already been filed, so obligations come back with the right status. */
  filed?: { periodKey: string; submittedAt: string }[];
  /** Demo provider: first day of the tenant's first VAT period. */
  firstPeriodStart?: string;
}

// ---------------------------------------------------------------- Open Banking (account information)

export interface FeedAccount {
  id: string;
  name: string;
  sortCode?: string;
  accountNumber?: string;
  currency: string;
  balance: string;
}

export interface FeedTransaction {
  id: string;
  date: string;
  description: string;
  reference: string | null;
  /** Signed: money in is positive. */
  amount: string;
}

export interface BankFeedProvider {
  info(): ProviderInfo;
  authoriseUrl(state: string, redirectUri: string): string | null;
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>;
  accounts(auth: BankAuth): Promise<FeedAccount[]>;
  transactions(auth: BankAuth, accountId: string, from: string, to: string): Promise<FeedTransaction[]>;
}

export interface BankAuth {
  accessToken?: string;
  /** Demo provider: what the bank would know, derived from the company's own payments (see bank-feed.ts). */
  seed?: unknown;
}

// ---------------------------------------------------------------- Companies House and HMRC VAT number check

export interface CompanyProfile {
  companyNumber: string;
  name: string;
  status: string;
  type: string;
  incorporatedOn?: string;
  sicCodes: string[];
  address: { line1?: string; line2?: string; city?: string; postcode?: string; country?: string };
}

export interface CompaniesHouseProvider {
  info(): ProviderInfo;
  search(query: string): Promise<{ companyNumber: string; name: string; status: string; address: string }[]>;
  profile(companyNumber: string): Promise<CompanyProfile | null>;
}

export interface VatCheckResult {
  valid: boolean;
  vatNumber: string;
  name?: string;
  address?: string;
  consultationNumber?: string;
  checkedAt: string;
}

export interface VatCheckProvider {
  info(): ProviderInfo;
  check(vatNumber: string, requesterVrn?: string): Promise<VatCheckResult>;
}

// ---------------------------------------------------------------- email

export interface OutgoingEmail {
  to: string;
  toName?: string;
  from: string;
  fromName: string;
  replyTo?: string;
  subject: string;
  text: string;
}

export interface EmailProvider {
  info(): ProviderInfo;
  send(message: OutgoingEmail): Promise<{ id: string }>;
}

// ---------------------------------------------------------------- exchange rates

export interface FxProvider {
  info(): ProviderInfo;
  /** GBP per one unit of each currency, for one day (the latest published rate on or before it). */
  rates(date: string, currencies: string[]): Promise<{ currency: string; date: string; rate: string }[]>;
}

// ---------------------------------------------------------------- AI

/** What the document reader returns. Amounts are strings with 2 decimals; nothing here is posted without review. */
export interface ExtractedDocument {
  docType: "supplier_invoice" | "freight_invoice" | "customs_entry" | "credit_note" | "other";
  supplierName: string | null;
  supplierVatNumber: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string | null;
  purchaseOrderRef: string | null;
  containerRef: string | null;
  mrn: string | null;
  lines: { description: string; quantity: string | null; unitPrice: string | null; net: string; vatRate: string | null; sku: string | null }[];
  net: string | null;
  vat: string | null;
  total: string | null;
  confidence: number;
  notes: string[];
}

export interface AssistantTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown>;
  /** Plain-English summary of a result, used by the demo assistant (which has no language model). */
  summarise(result: unknown): string;
  /** Words that suggest this tool answers a question (demo assistant routing). */
  keywords: RegExp;
}

export interface AssistantAnswer {
  answer: string;
  toolsUsed: { name: string; args: Record<string, unknown> }[];
  model: string | null;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AiProvider {
  info(): ProviderInfo & { model: string | null };
  extract(doc: { filename: string; mediaType: string; content: string; isBase64: boolean }): Promise<ExtractedDocument & { model: string | null; inputTokens?: number; outputTokens?: number }>;
  ask(question: string, context: { company: string; today: string }, tools: AssistantTool[]): Promise<AssistantAnswer>;
}
