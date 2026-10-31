"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { money } from "@/lib/format";
import { InboxIcon, type SoftiloIcon } from "@/components/softilo-icons";

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children && <div className="actions">{children}</div>}
    </div>
  );
}

export function Card({ title, actions, children, pad = false }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean }) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-header">
          {typeof title === "string" ? <h2>{title}</h2> : title}
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      {pad ? <div className="card-pad">{children}</div> : children}
    </section>
  );
}

export function Stat({ icon: Icon, label, value, sub, alert, href }: { icon?: SoftiloIcon; label: string; value: ReactNode; sub?: ReactNode; alert?: boolean; href?: string }) {
  const body = (
    <div className={`card stat${alert ? " alert" : ""}`}>
      <div className="label">{Icon && <Icon size={18} />}{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
  return href ? <Link href={href} style={{ textDecoration: "none" }}>{body}</Link> : body;
}

export function Money({ value, currency }: { value: string | number | null | undefined; currency?: string }) {
  return <span className="mono">{money(value, currency)}</span>;
}

const STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "" },
  approved: { label: "Approved", tone: "solid" },
  part_received: { label: "Part received", tone: "signal" },
  received: { label: "Received", tone: "quiet ok" },
  cancelled: { label: "Cancelled", tone: "quiet" },
  open: { label: "Open", tone: "signal" },
  costed: { label: "Costed", tone: "quiet ok" },
  paid: { label: "Paid", tone: "quiet ok" },
  unpaid: { label: "Unpaid", tone: "" },
  part_paid: { label: "Part paid", tone: "" },
  overdue: { label: "Overdue", tone: "signal" },
  unreconciled: { label: "To reconcile", tone: "signal" },
  reconciled: { label: "Reconciled", tone: "quiet ok" },
  finalised: { label: "Finalised", tone: "solid" },
  submitted: { label: "Submitted", tone: "quiet ok" },
  credit: { label: "Credit note", tone: "" },
};

export function Status({ value }: { value: string }) {
  const s = STATUS[value] ?? { label: value, tone: "" };
  return <span className={`pill ${s.tone}`}>{s.label}</span>;
}

export function paymentStatus(doc: { total: string; amount_paid: string; overdue?: boolean; kind?: string }) {
  if (Number(doc.amount_paid) >= Number(doc.total)) return doc.kind === "credit" ? "credit" : "paid";
  if (doc.overdue) return "overdue";
  return Number(doc.amount_paid) > 0 ? "part_paid" : "unpaid";
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><InboxIcon size={32} /><strong>{title}</strong>{children}</div>;
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="card-pad stack" style={{ gap: 12 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />)}
    </div>
  );
}

export function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null;
  return <div className="banner error" role="alert">{message}</div>;
}

export interface Column<T> {
  key: string;
  label: string;
  num?: boolean;
  render: (row: T) => ReactNode;
}

export function DataTable<T>({ rows, columns, href, empty, footer }: {
  rows: T[] | undefined;
  columns: Column<T>[];
  href?: (row: T) => string;
  empty?: ReactNode;
  footer?: ReactNode;
}) {
  const router = useRouter();
  if (!rows) return <Loading />;
  if (!rows.length) return <>{empty ?? <Empty title="Nothing here yet" />}</>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>{columns.map((c) => <th key={c.key} className={c.num ? "num" : undefined}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={href ? "clickable" : undefined} onClick={href ? (e) => {
              if ((e.target as HTMLElement).closest("a, button, input, select")) return;
              router.push(href(r));
            } : undefined}>
              {columns.map((c) => <td key={c.key} className={c.num ? "num" : undefined}>{c.render(r)}</td>)}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: string }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={active === t.id} className={active === t.id ? "active" : undefined} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** The product's line-art scene, shown at the top of the dashboard. */
export function ArtBand() {
  return <div className="art-band" aria-hidden="true"><img className="scene-light" src="/art/scene.svg" alt="" width={1200} height={190} /><img className="scene-dark" src="/art/scene-dark.svg" alt="" width={1200} height={190} /></div>;
}
