import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Row,
  Select,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
} from 'antd';
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

import { playgroundFetch } from '../../shared/helpers';

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

const fmtMs = (v: number | null) => (v == null ? '—' : `${v} ms`);
const fmtTs = (v: string | null) => (v ? new Date(v).toLocaleString() : '—');

async function getJson(url: string) {
  const res = await playgroundFetch(url);
  return res.json();
}

export function PreAggMonitorPage() {
  const [windowHours, setWindowHours] = useState<number>(24);
  const [loading, setLoading] = useState<boolean>(true);
  const [enabled, setEnabled] = useState<boolean>(true);
  const [summary, setSummary] = useState<Summary>(null);
  const [usedBy, setUsedBy] = useState<any[]>([]);
  const [queryLog, setQueryLog] = useState<any[]>([]);
  const [buildHistory, setBuildHistory] = useState<any[]>([]);
  const [queue, setQueue] = useState<any[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const w = `?windowHours=${windowHours}`;
      const [s, u, q, b, qq] = await Promise.all([
        getJson(`playground/pre-agg-monitor/summary${w}`),
        getJson('playground/pre-agg-monitor/used-by'),
        getJson('playground/pre-agg-monitor/query-log?limit=200'),
        getJson(`playground/pre-agg-monitor/build-history${w}`),
        getJson('playground/pre-agg-monitor/queue').catch(() => ({ queue: [] })),
      ]);
      setEnabled(Boolean(s.enabled));
      setSummary(s.summary || null);
      setUsedBy(u.rows || []);
      setQueryLog(q.rows || []);
      setBuildHistory(b.rows || []);
      setQueue(Array.isArray(qq.queue) ? qq.queue : []);
    } finally {
      setLoading(false);
    }
  }, [windowHours]);

  useEffect(() => {
    load();
  }, [load]);

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
        .map((r, i) => ({
          name: r.target_table || String(i),
          duration: r.duration_ms || 0,
        })),
    [buildHistory]
  );

  const usedByColumns = [
    { title: 'Pre-Aggregation', dataIndex: 'pre_aggregation', key: 'pre_aggregation' },
    { title: 'Queries', dataIndex: 'query_count', key: 'query_count', sorter: (a: any, b: any) => a.query_count - b.query_count, defaultSortOrder: 'descend' as const },
    { title: 'p50', dataIndex: 'p50_ms', key: 'p50_ms', render: fmtMs },
    { title: 'Last used', dataIndex: 'last_used', key: 'last_used', render: fmtTs },
  ];

  const queryLogColumns = [
    { title: 'Time', dataIndex: 'ts', key: 'ts', render: fmtTs, width: 180 },
    { title: 'API', dataIndex: 'api_type', key: 'api_type', width: 80 },
    { title: 'Duration', dataIndex: 'duration_ms', key: 'duration_ms', render: fmtMs, sorter: (a: any, b: any) => (a.duration_ms || 0) - (b.duration_ms || 0) },
    {
      title: 'Accelerated',
      dataIndex: 'queries_with_pre_aggregations',
      key: 'acc',
      width: 110,
      render: (v: number) =>
        v > 0 ? <Tag color="green">pre-agg</Tag> : <Tag>raw db</Tag>,
    },
    {
      title: 'Pre-Aggregations',
      dataIndex: 'used_pre_aggregations',
      key: 'used',
      render: (v: any) =>
        v && Object.keys(v).length
          ? Object.keys(v).map((k) => <Tag key={k}>{k}</Tag>)
          : '—',
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
    { title: 'Table', dataIndex: ['queryKey', 1], key: 'table', render: (_: any, row: any) => row.preAggregation || JSON.stringify(row.queryKey)?.slice(0, 80) },
    { title: 'Status', dataIndex: 'status', key: 'status', render: (s: string) => <Tag color={s === 'active' ? 'blue' : 'default'}>{s}</Tag> },
    { title: 'Request', dataIndex: 'requestId', key: 'requestId' },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <h1 style={{ margin: 0 }}>Pre-Aggregations Monitor</h1>
        </Col>
        <Col>
          <Select
            value={windowHours}
            onChange={setWindowHours}
            options={WINDOW_OPTIONS}
            style={{ width: 140, marginRight: 8 }}
          />
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
          description="Set CUBEJS_TELEMETRY_DB_URL to enable query log and build history. The live build queue still works without it."
        />
      )}

      <Spin spinning={loading}>
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col span={6}>
            <Card>
              <Statistic title={`Queries (${windowHours}h)`} value={summary?.total_queries ?? 0} />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic title="Pre-Agg hit rate" value={hitRate} suffix="%" />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic title="p50 latency" value={summary?.p50_ms ?? 0} suffix="ms" />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic title="p95 latency" value={summary?.p95_ms ?? 0} suffix="ms" />
            </Card>
          </Col>
        </Row>

        <Tabs defaultActiveKey="used-by">
          <TabPane tab="Used By" key="used-by">
            <Table
              rowKey={(r: any) => r.pre_aggregation}
              dataSource={usedBy}
              columns={usedByColumns}
              size="small"
              pagination={{ pageSize: 20 }}
            />
          </TabPane>

          <TabPane tab="Query Log" key="query-log">
            <Table
              rowKey={(r: any) => r.id}
              dataSource={queryLog}
              columns={queryLogColumns}
              size="small"
              pagination={{ pageSize: 25 }}
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
              pagination={{ pageSize: 25 }}
            />
          </TabPane>

          <TabPane tab={`Build Queue (${queue.length})`} key="queue">
            <Table
              rowKey={(r: any, i?: number) => `${r.requestId}-${i}`}
              dataSource={queue}
              columns={queueColumns}
              size="small"
              pagination={false}
            />
          </TabPane>
        </Tabs>
      </Spin>
    </div>
  );
}
