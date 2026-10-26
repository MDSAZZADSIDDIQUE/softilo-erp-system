"use client";

import { useRef } from "react";

export const CHANNEL_LABEL: Record<string, string> = {
  shopify: "Shopify", woocommerce: "WooCommerce", amazon: "Amazon UK", ebay: "eBay", tiktok: "TikTok Shop",
};

export const FEE_VAT_LABEL: Record<string, string> = {
  S20: "UK VAT charged (20%)", RC20: "Reverse charge (overseas supplier)", EX: "Exempt", OS: "Outside the scope",
};

/** Pick a JSON export (orders or payout) from the user's computer and hand back the parsed file. */
export function JsonFileButton({ label, onFile, onError, disabled }: {
  label: string; onFile: (payload: unknown, name: string) => void; onError: (message: string) => void; disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={input} type="file" accept="application/json,.json" hidden onChange={async (e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        try {
          onFile(JSON.parse(await file.text()), file.name);
        } catch {
          onError(`${file.name} is not a JSON file`);
        }
      }} />
      <button type="button" className="btn" disabled={disabled} onClick={() => input.current?.click()}>{label}</button>
    </>
  );
}

/** Contribution before fees: net sales less cost of goods. */
export function margin(net: string, cost: string): { value: number; pct: string } {
  const value = (Math.round(Number(net) * 100) - Math.round(Number(cost) * 100)) / 100;
  return { value, pct: Number(net) ? `${Math.round((value / Number(net)) * 1000) / 10}%` : "–" };
}
