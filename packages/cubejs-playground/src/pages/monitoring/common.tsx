import { CSSProperties, useState } from 'react';
import { Radio, Tag } from 'antd';
import styled from 'styled-components';
import { ThunderboltFilled } from '@ant-design/icons';
// Prism core must load before the grammar components register on it.
import 'prismjs';
// Prism theme + the grammars we render (registered as a side effect on the
// shared Prism instance used by PrismCode).
import 'prismjs/themes/prism.css';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-json';

import { format as formatSql } from 'sql-formatter';

import PrismCode from '../../PrismCode';
import { playgroundFetch } from '../../shared/helpers';

/**
 * Shared analytics time-window presets (relative "last N", fractional hours
 * supported end-to-end). Used by the Pre-Aggregations, Query History and
 * Insights pages so the interval picker is consistent everywhere.
 */
export const WINDOW_OPTIONS = [
  { label: 'Last 15 minutes', value: 0.25 },
  { label: 'Last 30 minutes', value: 0.5 },
  { label: 'Last 1 hour', value: 1 },
  { label: 'Last 4 hours', value: 4 },
  { label: 'Last 12 hours', value: 12 },
  { label: 'Last 24 hours', value: 24 },
  { label: 'Last 3 days', value: 72 },
  { label: 'Last 7 days', value: 168 },
];

/**
 * Analytics time range: a preset (relative windowHours) or an absolute
 * [from, to). `label` is for display in the picker button.
 */
export type Range = { windowHours?: number; from?: string; to?: string; label: string };

export const DEFAULT_RANGE: Range = { windowHours: 24, label: 'Last 24 hours' };

/** Build the query string a range maps to for the monitoring endpoints. */
export function rangeParams(r: Range): string {
  if (r.from && r.to) {
    return `from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}`;
  }
  return `windowHours=${r.windowHours ?? 24}`;
}

/**
 * Format a millisecond duration as seconds (the whole monitoring UI shows
 * seconds). Adaptive precision so sub-second values keep detail and large ones
 * stay readable; very large totals roll up to minutes.
 */
export const fmtMs = (v: number | null | undefined) => {
  if (v == null) return '—';
  const s = v / 1000;
  if (s < 10) return `${s.toFixed(2)} s`;
  if (s < 100) return `${s.toFixed(1)} s`;
  if (s < 600) return `${Math.round(s)} s`;
  return `${(s / 60).toFixed(1)} min`;
};

/** Same scale as fmtMs; kept as an alias for "total time" call sites. */
export const fmtSecs = fmtMs;

export const fmtTs = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : '—');

/**
 * Selectable latency percentiles, shared by every analytics view so the
 * displayed "pXX latency" is never a hard-coded number — the user picks which
 * percentile to look at, the same way the recommendation thresholds work.
 */
export const PERCENTILE_OPTIONS = [0.5, 0.75, 0.9, 0.95, 0.99];
export const pctLabel = (p: number) => `p${Math.round(p * 100)}`;

export function PercentilePicker({
  value,
  onChange,
  size = 'small',
}: {
  value: number;
  onChange: (p: number) => void;
  size?: 'small' | 'middle' | 'large';
}) {
  return (
    <Radio.Group value={value} onChange={(e: any) => onChange(e.target.value)} optionType="button" size={size}>
      {PERCENTILE_OPTIONS.map((p) => (
        <Radio.Button key={p} value={p}>{pctLabel(p)}</Radio.Button>
      ))}
    </Radio.Group>
  );
}

export async function getJson(url: string) {
  const res = await playgroundFetch(url);
  return res.json();
}

export async function postJson(url: string) {
  const res = await playgroundFetch(url, { method: 'POST' });
  return res.json();
}

/**
 * Wraps PrismCode and forces the code to wrap to the container width. The Prism
 * theme sets `white-space: pre` on `code[class*="language-"]`, which overrides
 * a parent <pre> — so we override it here (and on the <pre>) and let the block
 * scroll vertically instead of overflowing the page horizontally.
 */
const CodeWrap = styled.div`
  max-height: 70vh;
  overflow: auto;
  border-radius: 4px;

  pre[class*='language-'],
  code[class*='language-'] {
    white-space: pre-wrap !important;
    word-break: break-word !important;
  }

  pre[class*='language-'] {
    margin: 0;
  }
`;

/**
 * Syntax-highlighted, scrollable, wrapping code block used across the
 * monitoring detail views. Reuses the playground's PrismCode (prismjs) with the
 * sql/json grammars loaded above.
 */
export function CodeBlock({
  code,
  language = 'json',
  style,
}: {
  code: string;
  language?: 'json' | 'sql' | 'javascript';
  style?: CSSProperties;
}) {
  let pretty = code;
  if (language === 'sql' && code) {
    try {
      // Cube prefixes generated SQL with a `/* Cube Query: {json} */` comment.
      // The embedded JSON makes sql-formatter bail (leaving an ugly one-liner),
      // so split it off, pretty-print the JSON, then format the SQL body.
      const m = code.match(/^\s*\/\*\s*Cube Query:\s*([\s\S]*?)\*\/\s*([\s\S]*)$/);
      if (m) {
        let head = m[1].trim();
        try {
          head = JSON.stringify(JSON.parse(head), null, 2);
        } catch (e) {
          /* leave the comment body as-is if it isn't valid JSON */
        }
        pretty = `/* Cube Query:\n${head}\n*/\n\n${formatSql(m[2])}`;
      } else {
        pretty = formatSql(code);
      }
    } catch (e) {
      pretty = code; // best-effort (e.g. BigQuery backticks the formatter dislikes)
    }
  }
  return (
    <CodeWrap style={style}>
      <PrismCode code={pretty} language={language} />
    </CodeWrap>
  );
}

/**
 * Cache/acceleration badge for a query row, mirroring the Cube Cloud
 * "Cache Status" bolt indicator.
 */
export function cacheTag(row: any) {
  if (!row) {
    return null;
  }
  if (row.status === 'error') {
    return <Tag color="red">error</Tag>;
  }
  if (row.external) {
    return (
      <Tag color="gold" icon={<ThunderboltFilled />}>
        Cube Store
      </Tag>
    );
  }
  if (row.queries_with_pre_aggregations > 0) {
    return (
      <Tag color="green" icon={<ThunderboltFilled />}>
        pre-agg
      </Tag>
    );
  }
  return <Tag>raw db</Tag>;
}

/**
 * A single member rendered as a two-tone chip: cube (muted) + member name,
 * mirroring the Cube Cloud query chips.
 */
export function MemberTag({ member, color }: { member: string; color?: string }) {
  const idx = member.indexOf('.');
  const cube = idx > 0 ? member.slice(0, idx) : '';
  const name = idx > 0 ? member.slice(idx + 1) : member;
  return (
    <Tag color={color} style={{ margin: 2 }}>
      {cube ? <span style={{ opacity: 0.55 }}>{cube} </span> : null}
      {name}
    </Tag>
  );
}

function collectFilterMembers(filters: any): string[] {
  const out: string[] = [];
  const walk = (f: any) => {
    if (!f) return;
    if (Array.isArray(f)) { f.forEach(walk); return; }
    if (Array.isArray(f.and)) f.and.forEach(walk);
    if (Array.isArray(f.or)) f.or.forEach(walk);
    const m = f.member || f.dimension;
    if (m) out.push(m);
  };
  walk(filters);
  return out;
}

/**
 * A truncating chip list with an inline "+N" toggle that expands every chip in
 * place (and a "show less" to collapse). The toggle calls stopPropagation so it
 * never triggers a parent row's navigation onClick. Used everywhere chips can
 * overflow — query shapes, suggestion fields, etc. — so expand works the same
 * in every table.
 */
export function ChipList({ chips, max = 6, extra }: { chips: any[]; max?: number; extra?: any }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? chips : chips.slice(0, max);
  const more = chips.length - shown.length;
  const toggle = (e: any) => { e.stopPropagation(); setExpanded((v) => !v); };
  return (
    <span>
      {shown.length ? shown : <span style={{ color: '#999' }}>—</span>}
      {more > 0 ? (
        <Tag style={{ cursor: 'pointer' }} onClick={toggle}>+{more}</Tag>
      ) : null}
      {expanded && chips.length > max ? (
        <Tag style={{ cursor: 'pointer' }} onClick={toggle}>show less</Tag>
      ) : null}
      {extra}
    </span>
  );
}

/**
 * Render a Cube query as compact chips (measures / dimensions / time dims /
 * filters) instead of raw JSON — clearer at a glance in tables. Truncates to
 * `max` chips with an expandable "+N" overflow.
 */
export function QueryChips({ query, max = 6 }: { query: any; max?: number }) {
  if (!query || typeof query !== 'object') {
    return <span style={{ color: '#999' }}>—</span>;
  }
  const chips: any[] = [];
  (query.measures || []).forEach((m: string) => chips.push(<MemberTag key={`m${m}`} member={m} color="green" />));
  (query.dimensions || []).forEach((d: string) => chips.push(<MemberTag key={`d${d}`} member={d} color="blue" />));
  (query.timeDimensions || []).forEach((t: any, i: number) =>
    chips.push(<MemberTag key={`t${i}`} member={`${t.dimension}${t.granularity ? ` · ${t.granularity}` : ''}`} color="geekblue" />));
  (query.segments || []).forEach((s: string) => chips.push(<MemberTag key={`s${s}`} member={s} />));
  // A multi-value filter emits one clause per value (and OR groups repeat the
  // member) — collapse duplicates into a single chip with a "×N" count so the
  // same field isn't shown many times.
  const filterCounts = new Map<string, number>();
  collectFilterMembers(query.filters).forEach((m) => filterCounts.set(m, (filterCounts.get(m) || 0) + 1));
  Array.from(filterCounts.entries()).forEach(([m, n], i) =>
    chips.push(<MemberTag key={`f${i}`} member={n > 1 ? `${m} ×${n}` : m} color="orange" />));

  return (
    <ChipList chips={chips} max={max} extra={query.limit != null ? <Tag color="default">LIMIT {query.limit}</Tag> : null} />
  );
}

/**
 * Render a fingerprint shape (the normalized query: measures / dimensions /
 * time dims as `dimension:granularity` / filter member names) as expandable
 * chips. Mirrors QueryChips so Top Queries / Recommendations look identical.
 */
export function ShapeChips({ shape, max = 6 }: { shape: any; max?: number }) {
  if (!shape) return <span style={{ color: '#999' }}>—</span>;
  const chips: any[] = [];
  (shape.measures || []).forEach((m: string) => chips.push(<MemberTag key={`m${m}`} member={m} color="green" />));
  (shape.dimensions || []).forEach((d: string) => chips.push(<MemberTag key={`d${d}`} member={d} color="blue" />));
  (shape.timeDimensions || []).forEach((t: string, i: number) =>
    chips.push(<MemberTag key={`t${i}`} member={String(t).replace(':', ' · ')} color="geekblue" />));
  (shape.filters || []).forEach((f: string, i: number) => chips.push(<MemberTag key={`f${i}`} member={f} color="orange" />));
  return <ChipList chips={chips} max={max} />;
}

/**
 * Status badge for a defined pre-aggregation in the catalog / detail header.
 */
export function preAggStatusTag(row: { hits?: number; build_count?: number }) {
  if ((row.hits || 0) > 0) {
    return <Tag color="green">used</Tag>;
  }
  if ((row.build_count || 0) > 0) {
    return <Tag color="orange">built · 0 hits</Tag>;
  }
  return <Tag color="red">unused</Tag>;
}
