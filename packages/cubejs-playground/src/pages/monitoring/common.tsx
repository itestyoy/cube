import { CSSProperties } from 'react';
import { Tag } from 'antd';
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

export const fmtMs = (v: number | null | undefined) => (v == null ? '—' : `${v} ms`);

export const fmtTs = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : '—');

export async function getJson(url: string) {
  const res = await playgroundFetch(url);
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
      pretty = formatSql(code);
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
 * Render a Cube query as compact chips (measures / dimensions / time dims /
 * filters) instead of raw JSON — clearer at a glance in tables. Truncates to
 * `max` chips with a "+N" overflow.
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
  collectFilterMembers(query.filters).forEach((m, i) => chips.push(<MemberTag key={`f${i}`} member={m} color="orange" />));

  const shown = chips.slice(0, max);
  const more = chips.length - shown.length;
  return (
    <span>
      {shown.length ? shown : <span style={{ color: '#999' }}>—</span>}
      {more > 0 ? <Tag>+{more}</Tag> : null}
      {query.limit != null ? <Tag color="default">LIMIT {query.limit}</Tag> : null}
    </span>
  );
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
