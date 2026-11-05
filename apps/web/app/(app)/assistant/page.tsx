"use client";

import { useState } from "react";
import { Card, Empty, ErrorBanner, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";

interface Answer { answer: string; toolsUsed: { name: string }[]; model: string | null; provider: string }
interface Past { id: string; question: string; answer: string; tools_used: { name: string }[]; model: string | null; created_at: string }
interface Integrations { providers: { ai: { mode: string; name: string; model?: string | null } } }

const SUGGESTIONS = [
  "When is cash tightest over the next three months?",
  "Which products make the best margin, and which the worst?",
  "Who owes us money and how late are they?",
  "What should I reorder this week?",
  "How exposed are we to the dollar?",
  "Is anything in the books worth checking before month end?",
  "Which supplier has the longest lead time?",
];

const TOOL_NAMES: Record<string, string> = {
  margin_by_product: "Margin by product", margin_by_customer: "Margin by customer", cash_forecast: "Cash forecast",
  aged_debtors: "Aged debtors", stock_health: "Stock health", fx_exposure: "Currency exposure",
  supplier_performance: "Supplier performance", landed_cost_by_shipment: "Landed cost", key_ratios: "Key ratios", anomalies: "Month-end checks",
};

/** Answers are plain text; strip any Markdown emphasis a model adds anyway and show list markers as bullets. */
function Answer({ text }: { text: string }) {
  const clean = text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/^#+\s*/gm, "").replace(/^\s*[*-]\s+/gm, "• ");
  return <div className="answer">{clean}</div>;
}

export default function AssistantPage() {
  const { data: history, reload } = useApi<Past[]>("/api/assistant/history");
  const { data: info } = useApi<Integrations>("/api/integrations");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [current, setCurrent] = useState<(Answer & { question: string }) | null>(null);

  async function ask(q: string) {
    if (q.trim().length < 3) return;
    setBusy(true);
    setError(undefined);
    try {
      const a = await api<Answer>("/api/assistant/ask", { body: { question: q } });
      setCurrent({ ...a, question: q });
      setQuestion("");
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ai = info?.providers.ai;
  return (
    <div className="stack">
      <PageHeader title="Ask Softilo" subtitle={
        ai ? (ai.mode === "live" ? `Answers come from your books, worked out by ${ai.name}${ai.model ? ` (${ai.model})` : ""}. It can read but never post, pay or send.`
          : "Running without an AI model: questions are matched to the built-in reports. Add GEMINI_API_KEY to ask anything in your own words.") : undefined
      } />
      <Card pad>
        <form className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); void ask(question); }}>
          <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={2} style={{ minHeight: 0, resize: "vertical" }} placeholder="Ask about cash, margins, stock, customers, suppliers or VAT"
            aria-label="Your question" onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(question); } }} />
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <div className="chips">{SUGGESTIONS.map((s) => <button type="button" key={s} onClick={() => void ask(s)} disabled={busy}>{s}</button>)}</div>
            <button className="btn primary" disabled={busy || question.trim().length < 3}>{busy ? "Working it out…" : "Ask"}</button>
          </div>
        </form>
      </Card>
      <ErrorBanner message={error} />
      {current && (
        <Card title={current.question}>
          <div className="card-pad stack" style={{ gap: 12 }}>
            <Answer text={current.answer} />
            <p className="faint" style={{ margin: 0, fontSize: 12 }}>
              {current.toolsUsed.length ? `Worked out from: ${[...new Set(current.toolsUsed.map((t) => TOOL_NAMES[t.name] ?? t.name))].join(", ")}. ` : ""}
              {current.model ? `Model: ${current.model}.` : "Built-in reports, no AI model."} Check figures against the reports before acting on them.
            </p>
          </div>
        </Card>
      )}
      <Card title="Earlier questions">
        {!history?.length ? <Empty title="No questions yet">Your questions and the answers are kept here, and in the audit of AI use.</Empty> : (
          <div className="rows">
            {history.filter((h) => !current || h.question !== current.question || h !== history[0]).map((h) => (
              <details key={h.id} style={{ padding: "12px 20px", borderTop: "1px solid var(--border)" }}>
                <summary style={{ cursor: "pointer" }}>{h.question} <small className="faint">· {dateTime(h.created_at)}</small></summary>
                <div style={{ marginTop: 8 }}><Answer text={h.answer} /></div>
              </details>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
