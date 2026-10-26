/**
 * Sales channels (Shopify, WooCommerce, Amazon, eBay, TikTok Shop) behind one interface.
 * Adapters turn a channel's own order and payout formats into these normalised types.
 * They are pure functions, so each one is tested from fixture files without live credentials.
 * All amounts are decimal strings in the order's currency; they never pass through a float.
 */
export type ChannelKind = "shopify" | "woocommerce" | "amazon" | "ebay" | "tiktok";

export const CHANNEL_KINDS: ChannelKind[] = ["shopify", "woocommerce", "amazon", "ebay", "tiktok"];

/**
 * Who accounts for UK VAT on the sale.
 * - seller: the brand charges and pays the VAT (UK-established sellers today).
 * - marketplace: the marketplace is the deemed supplier and keeps the VAT (overseas sellers; £135 imports).
 * - export: goods leave the UK; zero-rated with evidence of export.
 */
export type VatTreatment = "seller" | "marketplace" | "export";

export interface ChannelOrderLine {
  externalId: string;
  sku: string | null;
  title: string;
  quantity: string;
  /** What the shopper paid for the line after discounts. Includes tax when the order's prices include tax. */
  gross: string;
  /** Tax the channel charged on the line. */
  tax: string;
  /** Tax rate as a fraction, e.g. "0.2". */
  taxRate: string;
}

export interface ChannelShippingLine {
  title: string;
  gross: string;
  tax: string;
  taxRate: string;
}

export interface ChannelOrder {
  channel: ChannelKind;
  externalId: string;
  /** The number the shopper sees, e.g. "#1001". */
  orderNumber: string;
  date: string;
  currency: string;
  customer: { name: string; email?: string };
  shipCountry?: string;
  pricesIncludeTax: boolean;
  /** Payment state on the channel; only paid orders are imported. */
  financialStatus: string;
  lines: ChannelOrderLine[];
  shipping: ChannelShippingLine[];
  /** Order total as the channel reports it, used to check the adapter's arithmetic. */
  total: string;
  vatTreatment: VatTreatment;
}

export type PayoutLineKind = "order" | "refund" | "fee" | "reserve" | "adjustment";

export interface ChannelPayoutLine {
  kind: PayoutLineKind;
  /** The channel's order id, for order and refund lines (and fees charged on an order). */
  orderRef?: string;
  /** Signed effect on the payout: sales are positive; refunds and fees negative; reserves either way. */
  amount: string;
  description: string;
}

export interface ChannelPayout {
  channel: ChannelKind;
  externalId: string;
  date: string;
  currency: string;
  /** The amount that reaches the bank. */
  amount: string;
  lines: ChannelPayoutLine[];
}

export interface ChannelAdapter {
  kind: ChannelKind;
  parseOrders(payload: unknown): ChannelOrder[];
  parsePayout(payload: unknown): ChannelPayout;
}

/** The payload is not in the channel's format, or its own totals don't add up. */
export class ChannelFormatError extends Error {}
