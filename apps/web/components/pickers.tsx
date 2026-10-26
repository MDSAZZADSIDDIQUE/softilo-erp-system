"use client";

import { useApi } from "@/lib/api";
import { VAT_CODES } from "@/lib/format";

export interface ContactOption { id: string; name: string; currency: string; payment_terms_days: number }
export interface ProductOption { id: string; sku: string; name: string; sales_price: string; sales_vat_code: string; purchase_vat_code: string; track_stock: boolean; on_hand: string }
export interface AccountOption { code: string; name: string; type: string; is_control: boolean; is_bank: boolean; archived: boolean }

export function useContacts(kind: "customer" | "supplier") {
  return useApi<ContactOption[]>(`/api/contacts?kind=${kind}`).data ?? [];
}

export function useProducts() {
  return useApi<ProductOption[]>("/api/products").data ?? [];
}

export function useAccounts(filter: (a: AccountOption) => boolean = () => true) {
  return (useApi<AccountOption[]>("/api/accounts").data ?? []).filter((a) => !a.archived && filter(a));
}

export function VatSelect({ value, onChange, name }: { value: string; onChange: (v: string) => void; name?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} name={name} aria-label="VAT">
      {VAT_CODES.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}
    </select>
  );
}

export function AccountSelect({ accounts, value, onChange }: { accounts: AccountOption[]; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Account">
      <option value="">Choose account…</option>
      {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
    </select>
  );
}
