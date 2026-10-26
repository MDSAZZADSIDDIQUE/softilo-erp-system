"use client";

import { addDays, date } from "@/lib/format";

/** Hours keyed by `${date}|${rateType}`. */
export type HoursMap = Record<string, string>;

export function toEntries(hours: HoursMap) {
  return Object.entries(hours)
    .filter(([, h]) => h !== "" && Number(h) > 0)
    .map(([key, h]) => {
      const [d, rateType] = key.split("|") as [string, string];
      return { date: d, rateType, hours: h };
    });
}

export function fromEntries(entries: { date: string; rate_type: string; hours: string }[]): HoursMap {
  return Object.fromEntries(entries.map((e) => [`${e.date}|${e.rate_type}`, String(Number(e.hours))]));
}

/** A week of days (columns) by rate type (rows). */
export function HoursGrid({ weekEnding, rateTypes, hours, onChange, readOnly }: {
  weekEnding: string; rateTypes: string[]; hours: HoursMap; onChange?: (h: HoursMap) => void; readOnly?: boolean;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekEnding, i - 6));
  const total = (pred: (key: string) => boolean) =>
    Object.entries(hours).filter(([k]) => pred(k)).reduce((s, [, h]) => s + Math.round(Number(h || 0) * 100), 0) / 100;
  return (
    <div className="table-wrap">
      <table className="hours-grid">
        <thead>
          <tr>
            <th>Rate</th>
            {days.map((d) => <th key={d}>{new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short" })}<div className="faint">{date(d).slice(0, 6)}</div></th>)}
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {rateTypes.map((rt) => (
            <tr key={rt}>
              <td style={{ textTransform: "capitalize" }}>{rt}</td>
              {days.map((d) => {
                const key = `${d}|${rt}`;
                return (
                  <td key={d}>
                    {readOnly ? (hours[key] ?? "") : (
                      <input aria-label={`${rt} hours on ${d}`} inputMode="decimal" value={hours[key] ?? ""}
                        onChange={(e) => onChange?.({ ...hours, [key]: e.target.value })} />
                    )}
                  </td>
                );
              })}
              <td className="num">{total((k) => k.endsWith(`|${rt}`)).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
