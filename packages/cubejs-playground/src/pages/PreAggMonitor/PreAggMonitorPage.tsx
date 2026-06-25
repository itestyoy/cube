import { useCallback, useEffect, useMemo, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { Alert, Button, Card, Col, Row, Select, Statistic, Table, Tabs, Tag, Tooltip } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { fmtMs, fmtTs, getJson, preAggStatusTag } from '../monitoring/common';

const { TabPane } = Tabs;

type Summary = {
  total_queries: number;
  accelerated_queries: number;
  p50_ms: number;
  p95_ms: number;
} | null;

const WINDOW_OPTIONS = [
  { label: 'Last 1h', value: 1 },
  { label: 'Last 6h', value: 6 },
  { label: 'Last 24h', value: 24 },
  { label: 'Last 7d', value: 168 },
];

export function PreAggMonitorPage() {
  const history = useHistory();
  const [windowHours, setWindowHours] = useState<number>(24);
  const [loading, setLoading] = useState<boolean>(true);
  const [enabled, setEnabled] = useState<boolean>(true);
  const [summary, setSummary] = useState<Summary>(null);
  const [catalog, setCatalog] = useState<any[]>([]);
  const [buildHistory, setBuildHistory] = useState<any[]>([]);
  const [queue, setQueue] = useState<any[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const w = `?windowHours=${windowHours}`;
      const [s, c, b, qq] = await Promise.all([
        getJson(`playground/pre-agg-monitor/summary${w}`),
        getJson(`playground/pre-agg-monitor/catalog${w}`),
        getJson(`playground/pre-agg-monitor/build-history${w}`),
        getJson('playground/pre-agg-monitor/queue').catch(() => ({ queue: [] })),
      ]);
      setEnabled(Boolean(s.enabled));
      setSummary(s.summary || null);
      setCatalog(c.rows || []);
      setBuildHistory(b.rows || []);
      setQueue(Array.isArray(qq.queue) ? qq.queue : []);
    } finally {
      setLoading(false);
    }
  }, [windowHours]);

  useEffect(() => {
    load();
  }, [load]);

  const stats = useMemo(() => {
    const defined = catalog.length;
    const used = catalog.filter((r) => r.hits > 0).length;
    return { defined, used, unused: defined - used };
  }, [catalog]);

  const hitRate = useMemo(() => {
    if (!summary || !summary.total_queries) {
      return 0;
    }
    return Math.round((summary.accelerated_queries / summary.total_queries) * 100);
  }, [summary]);

  const buildChartData = useMemo(
    () =>
      buildHistory
        .slice(0, 40)
        .reverse()
        .map((r, i) => ({ name: r.target_table || String(i), duration: r.duration_ms || 0 })),
    [buildHistory]
  );

  const catalogColumns = [
    { title: 'Cube', dataIndex: 'cube', key: 'cube', width: 160 },
    { title: 'Pre-Aggregation', dataIndex: 'name', key: 'name' },
    {
      title: 'Type',
      key: 'type',
      width: 150,
      render: (_: any, r: any) => (
        <span>
          {r.type}
          {r.granularity ? <Tag style={{ marginLeft: 6 }}>{r.granularity}</Tag> : null}
        </span>
      ),
    },
    { title: 'Status', key: 'status', width: 130, render: (_: any, r: any) => preAggStatusTag(r) },
    {
      title: 'Hits',
      dataIndex: 'hits',
      key: 'hits',
      width: 90,
      defaultSortOrder: 'descend' as const,
      sorter: (a: any, b: any) => a.hits - b.hits,
    },
    { title: 'p50', dataIndex: 'p50_ms', key: 'p50_ms', width: 90, render: fmtMs },
    { title: 'Last used', dataIndex: 'last_used', key: 'last_used', width: 180, render: fmtTs },
    {
      title: 'Builds',
      key: 'builds',
      width: 100,
      render: (_: any, r: any) =>
        r.build_count > 0 ? (
          <Tooltip title={`avg ${fmtMs(r.avg_build_ms)} · max ${fmtMs(r.max_build_ms)} · last ${fmtTs(r.last_build)}`}>
            <span>{r.build_count}×</span>
          </Tooltip>
        ) : (
          '—'
        ),
    },
  ];

  const buildColumns = [
    { title: 'Time', dataIndex: 'ts', key: 'ts', render: fmtTs, width: 180 },
    { title: 'Target table', dataIndex: 'target_table', key: 'target_table' },
    { title: 'Pre-Aggregation', dataIndex: 'pre_aggregation', key: 'pre_aggregation' },
    { title: 'Range end', dataIndex: 'build_range_end', key: 'build_range_end' },
    { title: 'Build time', dataIndex: 'duration_ms', key: 'duration_ms', render: fmtMs, sorter: (a: any, b: any) => (a.duration_ms || 0) - (b.duration_ms || 0) },
  ];

  const queueColumns = [
    { title: 'Table', key: 'table', render: (_: any, row: any) => row.preAggregation || (row.queryKey ? JSON.stringify(row.queryKey).slice(0, 80) : '—') },
    { title: 'Status', dataIndex: 'status', key: 'status', render: (s: string) => <Tag color={s === 'active' ? 'blue' : 'default'}>{s}</Tag> },
    { title: 'Request', dataIndex: 'requestId', key: 'requestId' },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <h1 style={{ margin: 0 }}>Pre-Aggregations</h1>
        </Col>
        <Col>
          <Select value={windowHours} onChange={setWindowHours} options={WINDOW_OPTIONS} style={{ width: 140, marginRight: 8 }} />
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            Refresh
          </Button>
        </Col>
      </Row>

      {!enabled && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="Telemetry store not configured"
          description="Set CUBEJS_TELEMETRY_DB_URL to see usage/build stats. The catalog and live build queue still work without it."
        />
      )}

      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={6}><Card><Statistic title="Defined pre-aggs" value={stats.defined} /></Card></Col>
        <Col span={6}><Card><Statistic title="Used" value={stats.used} valueStyle={{ color: '#3f8600' }} /></Card></Col>
        <Col span={6}><Card><Statistic title="Unused" value={stats.unused} valueStyle={{ color: stats.unused ? '#cf1322' : undefined }} /></Card></Col>
        <Col span={6}><Card><Statistic title={`Pre-Agg hit rate (${windowHours}h)`} value={hitRate} suffix="%" /></Card></Col>
      </Row>

      <Tabs defaultActiveKey="catalog">
        <TabPane tab="Catalog" key="catalog">
          <Table
            rowKey={(r: any) => r.id}
            dataSource={catalog}
            columns={catalogColumns}
            size="small"
            loading={loading}
            pagination={{ defaultPageSize: 25, showSizeChanger: true, pageSizeOptions: ["10","15","25","50","100"] }}
            onRow={(record) => ({ onClick: () => history.push(`/pre-agg-monitor/${encodeURIComponent(record.id)}`), style: { cursor: 'pointer' } })}
          />
        </TabPane>

        <TabPane tab="Build History" key="build-history">
          {buildChartData.length > 0 && (
            <div style={{ height: 220, marginBottom: 16 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={buildChartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" hide />
                  <YAxis unit="ms" />
                  <RechartsTooltip />
                  <Bar dataKey="duration" fill="#7A77FF" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <Table
            rowKey={(r: any) => r.id}
            dataSource={buildHistory}
            columns={buildColumns}
            size="small"
            loading={loading}
            pagination={{ defaultPageSize: 25, showSizeChanger: true, pageSizeOptions: ["10","15","25","50","100"] }}
            onRow={(record) => ({ onClick: () => history.push(`/builds/${record.id}`), style: { cursor: 'pointer' } })}
          />
        </TabPane>

        <TabPane tab={`Build Queue (${queue.length})`} key="queue">
          <Table rowKey={(r: any, i?: number) => `${r.requestId}-${i}`} dataSource={queue} columns={queueColumns} size="small" loading={loading} pagination={false} />
        </TabPane>
      </Tabs>
    </div>
  );
}
