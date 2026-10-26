import { ChannelFormatError, type ChannelAdapter, type ChannelKind, type VatTreatment } from "../channels.js";
import { shopifyAdapter } from "./shopify.js";

/** The adapter for a channel. Only Shopify is built so far; the others are on the roadmap (docs/plan.md). */
export function adapterFor(kind: ChannelKind, opts: { vatTreatment?: VatTreatment } = {}): ChannelAdapter {
  switch (kind) {
    case "shopify":
      return shopifyAdapter(opts);
    default:
      throw new ChannelFormatError(`Importing from ${kind} is not available yet`);
  }
}
