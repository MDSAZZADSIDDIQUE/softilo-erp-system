"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Small SVG charts in the house style: thin marks, recessive grid, one axis, hover tooltips on every mark,
 * and series colours from --series-1 / --series-2 (validated against both surfaces). Text uses text tokens.
 */

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.floor(e!.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** Clean tick values: 0 / 10K / 20K style. */
function ticks(min: number, max: number, count = 4): number[] {
  if (max === min) max = min + 1;
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  let v = Math.floor(min / step) * step;
  out.push(Math.round(v * 100) / 100);
  // Keep going until a tick sits at or above the highest value, so no mark rises above the top gridline.
  while (v < max - step * 1e-6) { v += step; out.push(Math.round(v * 100) / 100); }
  return out;
}

export const compact = (v: number) => {
  const a = Math.abs(v);
  const s = a >= 1_000_000 ? `${(a / 1_000_000).toFixed(1).replace(/\.0$/, "")}M` : a >= 10_000 ? `${Math.round(a / 1000)}K` : a >= 1000 ? `${(a / 1000).toFixed(1).replace(/\.0$/, "")}K` : `${Math.round(a)}`;
  return `${v < 0 ? "−" : ""}£${s}`;
};

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(8, x + 12), width - 228);
  return <div className="viz-tip" style={{ left, top: Math.max(0, y - 10) }} role="status">{children}</div>;
}

export interface Point { label: string; value: number; detail?: ReactNode }

/** One series over time, e.g. projected cash. Marks the lowest point; crosshair and tooltip on hover. */
export function LineChart({ points, height = 220, format = compact, zeroLine = true, ariaLabel }: {
  points: Point[]; height?: number; format?: (v: number) => string; zeroLine?: boolean; ariaLabel: string;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length) return null;
  const pad = { l: 52, r: 16, t: 14, b: 28 };
  const values = points.map((p) => p.value);
  const lo = Math.min(...values, zeroLine ? 0 : Infinity);
  const hi = Math.max(...values);
  const t = ticks(lo, hi);
  const y0 = t[0]!;
  const y1 = t.at(-1)!;
  const x = (i: number) => pad.l + (points.length === 1 ? 0 : (i / (points.length - 1)) * (width - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0 || 1)) * (height - pad.t - pad.b);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const area = `${path}L${x(points.length - 1)},${y(Math.max(y0, 0))}L${x(0)},${y(Math.max(y0, 0))}Z`;
  const low = values.indexOf(Math.min(...values));
  const every = Math.ceil(points.length / Math.max(2, Math.floor((width - pad.l) / 70)));

  function move(e: React.PointerEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    const i = Math.round(((px - pad.l) / (width - pad.l - pad.r)) * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, i)));
  }

  return (
    <div className="viz" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel} onPointerMove={move} onPointerLeave={() => setHover(null)}>
        {t.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} className={v === 0 ? "viz-zero" : "viz-grid"} />
            <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" className="viz-tick">{format(v)}</text>
          </g>
        ))}
        {points.map((p, i) => i % every === 0 && <text key={i} x={x(i)} y={height - 8} textAnchor="middle" className="viz-tick">{p.label}</text>)}
        <path d={area} className="viz-area" />
        <path d={path} className="viz-line" />
        <circle cx={x(low)} cy={y(values[low]!)} r={5} className="viz-dot" />
        <text x={Math.min(x(low), width - 90)} y={y(values[low]!) + 20} className="viz-label">Low {format(values[low]!)}</text>
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} className="viz-cross" />
            <circle cx={x(hover)} cy={y(values[hover]!)} r={5} className="viz-dot" />
          </>
        )}
      </svg>
      {hover !== null && (
        <Tooltip x={x(hover)} y={y(values[hover]!)} width={width}>
          <strong>{points[hover]!.label}</strong>
          <span>{format(values[hover]!)}</span>
          {points[hover]!.detail}
        </Tooltip>
      )}
    </div>
  );
}

/** Two measures on one axis per period (money in and money out), side by side, with a legend. */
export function PairedColumns({ rows, labels, height = 200, ariaLabel }: {
  rows: { label: string; a: number; b: number; detail?: ReactNode }[]; labels: [string, string]; height?: number; ariaLabel: string;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 52, r: 12, t: 10, b: 28 };
  const t = ticks(0, Math.max(1, ...rows.flatMap((r) => [r.a, r.b])));
  const top = t.at(-1)!;
  const band = (width - pad.l - pad.r) / Math.max(1, rows.length);
  const bar = Math.min(16, Math.max(3, band / 2 - 4));
  const y = (v: number) => pad.t + (1 - v / top) * (height - pad.t - pad.b);
  const every = Math.ceil(rows.length / Math.max(2, Math.floor((width - pad.l) / 60)));
  // A column with a 4px rounded top, square at the baseline.
  const col = (cx: number, v: number) => {
    const h = Math.max(0, y(0) - y(v));
    if (h < 1) return "";
    const r = Math.min(4, h, bar / 2);
    const x0 = cx;
    const x1 = cx + bar;
    const yt = y(v);
    return `M${x0},${y(0)}V${yt + r}Q${x0},${yt} ${x0 + r},${yt}H${x1 - r}Q${x1},${yt} ${x1},${yt + r}V${y(0)}Z`;
  };
  return (
    <div className="viz" ref={ref}>
      <div className="viz-legend"><span><i className="s1" />{labels[0]}</span><span><i className="s2" />{labels[1]}</span></div>
      <svg width={width} height={height} role="img" aria-label={ariaLabel} onPointerLeave={() => setHover(null)}>
        {t.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} className={v === 0 ? "viz-zero" : "viz-grid"} />
            <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" className="viz-tick">{compact(v)}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const cx = pad.l + i * band + band / 2;
          return (
            <g key={i} onPointerEnter={() => setHover(i)}>
              <rect x={cx - band / 2} y={pad.t} width={band} height={height - pad.t - pad.b} fill="transparent" />
              <path d={col(cx - bar - 1, r.a)} className="viz-s1" opacity={hover === null || hover === i ? 1 : 0.45} />
              <path d={col(cx + 1, r.b)} className="viz-s2" opacity={hover === null || hover === i ? 1 : 0.45} />
              {i % every === 0 && <text x={cx} y={height - 8} textAnchor="middle" className="viz-tick">{r.label}</text>}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <Tooltip x={pad.l + hover * band + band / 2} y={y(Math.max(rows[hover]!.a, rows[hover]!.b))} width={width}>
          <strong>{rows[hover]!.label}</strong>
          <span><i className="s1" />{labels[0]}: {compact(rows[hover]!.a)}</span>
          <span><i className="s2" />{labels[1]}: {compact(rows[hover]!.b)}</span>
          {rows[hover]!.detail}
        </Tooltip>
      )}
    </div>
  );
}

/** Ranked horizontal bars for one measure, value at the tip. */
export function BarList({ rows, format = compact, ariaLabel }: {
  rows: { label: string; value: number; sub?: string; detail?: ReactNode }[]; format?: (v: number) => string; ariaLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <div className="viz-bars" role="img" aria-label={ariaLabel} onPointerLeave={() => setHover(null)}>
      {rows.map((r, i) => (
        <div key={i} className="viz-barrow" onPointerEnter={() => setHover(i)} data-active={hover === i || undefined}>
          <span className="viz-barlabel">{r.label}{r.sub && <small>{r.sub}</small>}</span>
          <span className="viz-bartrack">
            {/* A loss draws in the second series colour; the value beside it carries the sign. */}
            <i className={r.value < 0 ? "neg" : undefined} style={{ width: `${(Math.abs(r.value) / max) * 100}%` }} />
            <b>{format(r.value)}</b>
          </span>
          {hover === i && r.detail && <div className="viz-tip inline" role="status">{r.detail}</div>}
        </div>
      ))}
    </div>
  );
}
