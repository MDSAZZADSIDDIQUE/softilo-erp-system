/** Labels for the document inbox. */
export const DOC_STATUS: Record<string, { label: string; tone: string }> = {
  received: { label: "Waiting to be read", tone: "" },
  extracted: { label: "Ready to post", tone: "solid" },
  needs_review: { label: "Needs a look", tone: "signal" },
  converted: { label: "Posted", tone: "quiet ok" },
  rejected: { label: "Rejected", tone: "quiet" },
  failed: { label: "Could not read", tone: "signal" },
};
export const DOC_TYPE: Record<string, string> = {
  supplier_invoice: "Supplier invoice", freight_invoice: "Freight invoice", customs_entry: "Customs and duty", credit_note: "Credit note", other: "Other",
};

