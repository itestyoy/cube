import { Tag } from 'antd';
import { ThunderboltFilled } from '@ant-design/icons';

import { playgroundFetch } from '../../shared/helpers';

export const fmtMs = (v: number | null | undefined) => (v == null ? '—' : `${v} ms`);

export const fmtTs = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : '—');

export async function getJson(url: string) {
  const res = await playgroundFetch(url);
  return res.json();
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
