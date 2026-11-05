"use client";

import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { DOC_STATUS, DOC_TYPE } from "@/lib/documents";
import { dateTime, money } from "@/lib/format";

interface Doc {
  id: string; filename: string; status: string; doc_type: string | null; confidence: string | null; warnings: string[];
  supplier_name: string | null; total: string | null; currency: string | null; invoice_number: string | null; bill_number: string | null;
  created_at: string; source: string; error: string | null;
}

/** Read a file into what the API stores: plain text as is, anything else base64. */
async function encode(file: File): Promise<{ mediaType: string; content: string }> {
  const mediaType = file.type || (file.name.endsWith(".txt") ? "text/plain" : "application/octet-stream");
  if (mediaType.startsWith("text/")) return { mediaType, content: await file.text() };
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mediaType, content: btoa(bin) };
}

export default function InboxPage() {
  const { data, error, reload } = useApi<Doc[]>("/api/documents");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [uploadError, setUploadError] = useState<string>();

  async function upload(files: FileList) {
    setBusy(true);
    setUploadError(undefined);
    let n = 0;
    try {
      for (const file of Array.from(files)) {
        if (file.size > 4_000_000) throw new Error(`${file.name} is larger than 4 MB`);
        await api("/api/documents", { body: { filename: file.name, ...(await encode(file)) } });
        n++;
      }
      setMsg(`Read ${n} document${n === 1 ? "" : "s"}. Check each draft, then post it.`);
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setBusy(false);
      await reload();
    }
  }

  const waiting = data?.filter((d) => ["extracted", "needs_review", "received", "failed"].includes(d.status)).length ?? 0;
  return (
    <div className="stack">
      <PageHeader title="Document inbox" subtitle="Supplier invoices, freight bills and customs paperwork. Each is read, matched to the supplier, order and shipment, and turned into a draft for you to check. Nothing is posted until you approve it.">
        <label className="btn primary">
          {busy ? "Reading…" : "Upload documents"}
          <input type="file" multiple hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,application/pdf,image/*,text/plain" disabled={busy}
            onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ""; }} />
        </label>
      </PageHeader>
      {msg && <div className="banner ok">{msg}</div>}
      <ErrorBanner message={uploadError ?? error} />
      <Card title={`To deal with${data ? ` (${waiting})` : ""}`}>
        <DataTable rows={data} href={(d) => `/inbox/${d.id}`}
          empty={<Empty title="The inbox is empty">Upload a PDF, a photo or a text file of an invoice. Freight and duty bills are coded ready to land on their shipment.</Empty>}
          columns={[
            { key: "f", label: "Document", render: (d) => <span>{d.filename}<br /><small className="faint">{d.doc_type ? DOC_TYPE[d.doc_type] : "Not read yet"} · {dateTime(d.created_at)}</small></span> },
            { key: "s", label: "From", render: (d) => d.supplier_name ?? <span className="faint">–</span> },
            { key: "r", label: "Their ref", render: (d) => d.invoice_number ?? <span className="faint">–</span> },
            { key: "t", label: "Total", num: true, render: (d) => (d.total ? money(d.total, d.currency ?? "GBP") : "–") },
            { key: "c", label: "Read with", num: true, render: (d) => (d.confidence === null ? "–" : `${Math.round(Number(d.confidence) * 100)}%`) },
            { key: "st", label: "Status", render: (d) => <span><span className={`pill ${DOC_STATUS[d.status]?.tone ?? ""}`}>{DOC_STATUS[d.status]?.label ?? d.status}</span>{d.bill_number && <small className="faint"> {d.bill_number}</small>}{d.warnings?.length ? <small className="warn"> {d.warnings.length} to check</small> : null}</span> },
          ]} />
      </Card>
    </div>
  );
}
