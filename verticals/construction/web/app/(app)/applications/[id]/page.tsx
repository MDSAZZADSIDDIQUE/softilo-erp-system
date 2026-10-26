"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { percent, stageLabel } from "@/components/cons";
import { ErrorBanner, Loading, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money } from "@/lib/format";

interface Application {
  reference: string; application_no: number; stage: string; date: string; period_end: string; invoice_number: string;
  gross_to_date: string; retention_rate: string; retention_to_date: string; net_to_date: string; previous_net: string; amount_due: string;
  vat_code: string; vat: string; total: string; due_date: string; final_date: string; payment_notice_by: string; pay_less_by: string; outstanding: string;
  reverseCharge: boolean;
  project: { id: string; code: string; name: string; customer_name: string; site_address: string | null };
  supplier: { name: string; vat_number: string | null; company_number: string | null };
}

export default function ApplicationPage() {
  const { id } = useParams<{ id: string }>();
  const { data: a, error } = useApi<Application>(`/api/construction/applications/${id}`);
  if (!a) return <div className="stack"><ErrorBanner message={error} />{!error && <Loading rows={6} />}</div>;
  return (
    <div className="stack">
      <PageHeader title={a.reference} subtitle={<><Link href={`/projects/${a.project.id}`}>{a.project.code} · {a.project.name}</Link> · {stageLabel(a.stage)}</>}>
        <button className="btn no-print" onClick={() => window.print()}>Print</button>
      </PageHeader>
      <article className="document">
        <header>
          <div>
            <div className="doc-title">Application for payment no. {a.application_no}</div>
            <p className="muted" style={{ margin: "6px 0 0" }}>Tax invoice {a.invoice_number} · {date(a.date)}</p>
          </div>
          <div style={{ textAlign: "right" }}>
            <img src="/brand/logo.svg" alt="Softilo" />
            <div className="accent-rule" />
          </div>
        </header>
        <div className="grid-2" style={{ marginBottom: 28 }}>
          <dl className="meta">
            <dt>From</dt><dd>{a.supplier.name}</dd>
            <dt>VAT number</dt><dd>{a.supplier.vat_number ? `GB${a.supplier.vat_number}` : "–"}</dd>
            {a.supplier.company_number && <><dt>Company number</dt><dd>{a.supplier.company_number}</dd></>}
          </dl>
          <dl className="meta">
            <dt>To</dt><dd>{a.project.customer_name}</dd>
            <dt>Project</dt><dd>{a.project.name}</dd>
            {a.project.site_address && <><dt>Site</dt><dd>{a.project.site_address}</dd></>}
            <dt>Valuation to</dt><dd>{date(a.period_end)}</dd>
          </dl>
        </div>
        <div className="calc" style={{ maxWidth: 480, marginLeft: "auto" }}>
          <span>Gross valuation to date</span><span>{money(a.gross_to_date)}</span>
          <span>Less retention at {percent(a.retention_rate)}</span><span>({money(a.retention_to_date)})</span>
          <span className="rule" />
          <span>Net valuation to date</span><span>{money(a.net_to_date)}</span>
          <span>Less previously applied for</span><span>({money(a.previous_net)})</span>
          <span className="rule" />
          <span className="strong">Amount due, excluding VAT</span><span className="strong">{money(a.amount_due)}</span>
          {a.reverseCharge ? (
            <><span>VAT at 20% (reverse charge, {money(a.vat)})</span><span>{money(0)}</span></>
          ) : (
            <><span>VAT ({a.vat_code})</span><span>{money(a.vat)}</span></>
          )}
          <span className="rule" />
          <span className="strong">Total payable</span><span className="strong">{money(a.total)}</span>
        </div>
        {a.reverseCharge && (
          <p style={{ marginTop: 20, fontWeight: 500 }}>Reverse charge: VAT Act 1994 Section 55A applies. Customer to account to HMRC for the VAT of {money(a.vat)}.</p>
        )}
        <table className="data" style={{ marginTop: 28 }}>
          <thead><tr><th>Payment timetable</th><th>Date</th></tr></thead>
          <tbody>
            <tr><td>Due date</td><td>{date(a.due_date)}</td></tr>
            <tr><td>Payer&apos;s payment notice by</td><td>{date(a.payment_notice_by)}</td></tr>
            <tr><td>Pay-less notice no later than</td><td>{date(a.pay_less_by)}</td></tr>
            <tr><td>Final date for payment</td><td>{date(a.final_date)}</td></tr>
          </tbody>
        </table>
        <p className="muted" style={{ marginTop: 16 }}>Outstanding: {money(a.outstanding)}</p>
      </article>
    </div>
  );
}
