import { CSSProperties } from 'react';
import { Tag } from 'antd';
import { ThunderboltFilled } from '@ant-design/icons';
// Prism core must load before the grammar components register on it.
import 'prismjs';
// Prism theme + the grammars we render (registered as a side effect on the
// shared Prism instance used by PrismCode).
import 'prismjs/themes/prism.css';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-json';

import PrismCode from '../../PrismCode';
import { playgroundFetch } from '../../shared/helpers';

export const fmtMs = (v: number | null | undefined) => (v == null ? '—' : `${v} ms`);

export const fmtTs = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : '—');

export async function getJson(url: string) {
  const res = await playgroundFetch(url);
  return res.json();
}

/**
 * Syntax-highlighted, scrollable code block used across the monitoring detail
 * views. Reuses the playground's PrismCode (prismjs) with the sql/json grammars
 * loaded above.
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
  return (
    <PrismCode
      code={code}
      language={language}
      style={{
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: '70vh',
        overflow: 'auto',
        margin: 0,
        ...style,
      }}
    />
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
