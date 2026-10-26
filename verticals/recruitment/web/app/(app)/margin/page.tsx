"use client";

import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, PageHeader, Tabs } from "@/components/ui";
import { useApi } from "@/lib/api";
import { money, percent } from "@/lib/format";

interface Row { key: string; label: string; hours: string; charge: string; cost: string; margin: string; marginPct: string | null; marginPerHour: string | null }

export default function MarginPage() {
  const [by, setBy] = useState("client");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const qs = new URLSearchParams({ by, ...(from ? { from } : {}), ...(to ? { to } : {}) });
  const { data, error } = useApi<{ rows: Row[]; total: Row }>(`/api/rec/margin?${qs}`);
  const t = data?.total;
  return (
    <div className="stack">
      <PageHeader title="Gross margin" subtitle="Charge to clients less worker pay, holiday accrual and on-costs, from approved timesheets (by week ending).">
        <label className="field" style={{ margin: 0 }}><span>From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field" style={{ margin: 0 }}><span>To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card>
        <div className="card-pad" style={{ paddingBottom: 0 }}>
          <Tabs active={by} onChange={setBy} tabs={[{ id: "client", label: "By client" }, { id: "consultant", label: "By consultant" }, { id: "placement", label: "By placement" }]} />
        </div>
        <DataTable rows={data?.rows}
          empty={<Empty title="No approved hours in this period" />}
          footer={t && (
            <tr>
              <td><strong>Total</strong></td>
              <td className="num">{Number(t.hours).toFixed(2)}</td>
              <td className="num">{money(t.charge)}</td>
              <td className="num">{money(t.cost)}</td>
              <td className="num"><strong>{money(t.margin)}</strong></td>
              <td className="num">{percent(t.marginPct)}</td>
              <td className="num">{money(t.marginPerHour)}</td>
            </tr>
          )}
          columns={[
            { key: "l", label: by === "client" ? "Client" : by === "consultant" ? "Consultant" : "Placement", render: (r) => r.label },
            { key: "h", label: "Hours", num: true, render: (r) => Number(r.hours).toFixed(2) },
            { key: "c", label: "Sales", num: true, render: (r) => money(r.charge) },
            { key: "k", label: "Cost", num: true, render: (r) => money(r.cost) },
            { key: "m", label: "Margin", num: true, render: (r) => <strong>{money(r.margin)}</strong> },
            { key: "p", label: "Margin %", num: true, render: (r) => percent(r.marginPct) },
            { key: "ph", label: "Per hour", num: true, render: (r) => money(r.marginPerHour) },
          ]} />
      </Card>
    </div>
  );
}
