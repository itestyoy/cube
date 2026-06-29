import { useCallback, useEffect, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { Alert, Button, Card, Col, InputNumber, Popconfirm, Radio, Row, Select, Table, Tabs, Tag, message } from 'antd';
import { ReloadOutlined, LineChartOutlined } from '@ant-design/icons';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { CodeBlock, DEFAULT_RANGE, PercentilePicker, QueryChips, Range, cacheTag, fmtMs, fmtTs, getJson, pctLabel, postJson, rangeParams } from '../monitoring/common';
import { TimeWindow } from '../monitoring/TimeWindow';

const fmtBucket = (v: string) => {
  const d = new Date(v);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// Recharts Y-axis ticks are in ms; render them as seconds.
const fmtSecAxis = (v: number) => `${Math.round(v / 1000)}`;

const { TabPane } = Tabs;

export function QueryHistoryPage() {
  const history = useHistory();
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [rows, setRows] = useState<any[]>([]);
  const [series, setSeries] = useState<any[]>([]);
  const [showCharts, setShowCharts] = useState(true);
  const [queueRows, setQueueRows] = useState<any[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);

  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const [latencyPct, setLatencyPct] = useState(0.95);
  const [order, setOrder] = useState<'recent' | 'top'>('recent');
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [cache, setCache] = useState<string | undefined>(undefined);
  const [apiType, setApiType] = useState<string | undefined>(undefined);
  const [minDuration, setMinDuration] = useState<number | undefined>(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ order, limit: '300' });
      if (status) params.set('status', status);
      if (cache) params.set('cache', cache);
      if (apiType) params.set('apiType', apiType);
      if (minDuration != null) params.set('minDurationMs', String(Math.round(minDuration * 1000)));
      const qs = `${rangeParams(range)}&${params.toString()}`;
      const [json, ts] = await Promise.all([
        getJson(`playground/query-history?${qs}`),
        getJson(`playground/query-history/timeseries?${rangeParams(range)}&percentile=${latencyPct}`).catch(() => ({ rows: [] })),
      ]);
      setEnabled(Boolean(json.enabled));
      setRows(json.rows || []);
      setSeries(ts.rows || []);
    } finally {
      setLoading(false);
    }
  }, [range, order, status, cache, apiType, minDuration, latencyPct]);

  useEffect(() => {
    load();
  }, [load]);

  const cancelQueueQuery = (requestId: string) => {
    postJson(`playground/query-history/queue/cancel?requestId=${encodeURIComponent(requestId)}`)
      .then((r) => {
        message.success(r && r.cancelled ? `Cancelled ${r.cancelled} query(ies)` : 'Cancel requested');
        loadQueue();
      })
      .catch(() => message.error('Failed to cancel query'));
  };

  const loadQueue = useCallback(() => {
    setQueueLoading(true);
    getJson('playground/query-history/queue')
      .then((r) => setQueueRows(Array.isArray(r.queue) ? r.queue : []))
      .catch(() => setQueueRows([]))
      .finally(() => setQueueLoading(false));
  }, []);

  const queueColumns = [
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 200,
      render: (s: string[]) => (Array.isArray(s) ? s : []).map((x) => (
        <Tag key={x} color={x === 'active' ? 'processing' : x === 'toProcess' ? 'blue' : x === 'orphaned' ? 'orange' : 'red'}>{x}</Tag>
      )),
    },
    { title: 'Request ID', dataIndex: 'requestId', key: 'requestId', width: 260, ellipsis: true, render: (v: string) => v || '—' },
    {
      title: 'Query',
      key: 'query',
      render: (_: any, r: any) => {
        const q = r.query || {};
        const sql = q.sql || (Array.isArray(q) ? null : q.query);
        if (typeof sql === 'string') return <code style={{ fontSize: 12 }}>{sql.slice(0, 160)}</code>;
        return <QueryChips query={q} max={4} />;
      },
    },
    {
      title: 'In queue',
      dataIndex: 'addedToQueueTime',
      key: 'addedToQueueTime',
      width: 170,
      render: (v: number) => (v ? fmtTs(new Date(v).toISOString()) : '—'),
    },
    {
      title: '',
      key: 'cancel',
      width: 90,
      render: (_: any, r: any) =>
        r.requestId ? (
          <Popconfirm
            title="Cancel this query?"
            okText="Cancel query"
            okButtonProps={{ danger: true }}
            cancelText="No"
            onConfirm={() => cancelQueueQuery(r.requestId)}
          >
            <Button danger type="link" size="small">Cancel</Button>
          </Popconfirm>
        ) : null,
    },
  ];

  const columns = [
    { title: 'Time', dataIndex: 'ts', key: 'ts', render: fmtTs, width: 175 },
    { title: 'API', dataIndex: 'api_type', key: 'api_type', width: 64 },
    {
      title: 'Duration',
      dataIndex: 'duration_ms',
      key: 'duration_ms',
      width: 105,
      render: fmtMs,
      sorter: (a: any, b: any) => (a.duration_ms || 0) - (b.duration_ms || 0),
    },
    { title: 'Cache', key: 'cache', width: 115, render: (_: any, row: any) => cacheTag(row) },
    { title: 'Query', dataIndex: 'query', key: 'query', render: (q: any) => <QueryChips query={q} /> },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <h1 style={{ margin: 0 }}>Query History</h1>
        </Col>
        <Col>
          <span style={{ marginRight: 8 }}><PercentilePicker value={latencyPct} onChange={setLatencyPct} /></span>
          <TimeWindow value={range} onChange={setRange} />
          <Button
            icon={<LineChartOutlined />}
            type={showCharts ? 'primary' : 'default'}
            ghost={showCharts}
            style={{ marginLeft: 8 }}
            onClick={() => setShowCharts((v) => !v)}
          >
            Charts
          </Button>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading} style={{ marginLeft: 8 }}>
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
          description="Set CUBEJS_TELEMETRY_DB_URL to capture query history."
        />
      )}

      <Tabs defaultActiveKey="history" onChange={(k) => k === 'queue' && loadQueue()}>
        <TabPane tab="Query history" key="history">
      {showCharts && series.length > 0 && (
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col span={12}>
            <Card title="Requests — pre-agg vs raw DB" size="small">
              <div style={{ height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={series}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="bucket" tickFormatter={fmtBucket} minTickGap={40} />
                    <YAxis allowDecimals={false} />
                    <RechartsTooltip labelFormatter={fmtBucket} />
                    <Legend />
                    {/* covered (accelerated) vs not covered, stacked = total */}
                    <Bar dataKey="accelerated" name="Pre-agg" fill="#52c41a" stackId="a" />
                    <Bar dataKey="not_accelerated" name="Raw DB" fill="#7A77FF" stackId="a" />
                    <Line type="monotone" dataKey="errors" name="Errors" stroke="#e0245e" dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </Col>
          <Col span={12}>
            <Card title="Avg response time — pre-agg vs raw DB (s)" size="small">
              <div style={{ height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="bucket" tickFormatter={fmtBucket} minTickGap={40} />
                    <YAxis unit="s" tickFormatter={fmtSecAxis} />
                    <RechartsTooltip labelFormatter={fmtBucket} formatter={(v: any) => `${(Number(v) / 1000).toFixed(2)} s`} />
                    <Legend />
                    <Line type="monotone" dataKey="avg_ms_accelerated" name="Pre-agg" stroke="#52c41a" dot={false} />
                    <Line type="monotone" dataKey="avg_ms_not_accelerated" name="Raw DB" stroke="#7A77FF" dot={false} />
                    <Line type="monotone" dataKey="p_ms" name={`${pctLabel(latencyPct)} (all)`} stroke="#faad14" strokeDasharray="4 2" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </Col>
        </Row>
      )}

      <Row gutter={8} style={{ marginBottom: 16 }} align="middle">
        <Col>
          <Radio.Group value={order} onChange={(e) => setOrder(e.target.value)} optionType="button">
            <Radio.Button value="recent">All (recent)</Radio.Button>
            <Radio.Button value="top">Top (slowest)</Radio.Button>
          </Radio.Group>
        </Col>
        <Col>
          <Select allowClear placeholder="Status" value={status} onChange={setStatus} style={{ width: 120 }}
            options={[{ label: 'Success', value: 'success' }, { label: 'Error', value: 'error' }]} />
        </Col>
        <Col>
          <Select allowClear placeholder="Cache" value={cache} onChange={setCache} style={{ width: 150 }}
            options={[{ label: 'Pre-aggregation', value: 'preagg' }, { label: 'Raw DB', value: 'raw' }]} />
        </Col>
        <Col>
          <Select allowClear placeholder="API type" value={apiType} onChange={setApiType} style={{ width: 120 }}
            options={[{ label: 'load', value: 'load' }, { label: 'sql', value: 'sql' }, { label: 'graphql', value: 'graphql' }]} />
        </Col>
        <Col>
          <InputNumber placeholder="Min s" value={minDuration} onChange={(v) => setMinDuration(typeof v === 'number' ? v : undefined)} style={{ width: 110 }} min={0} step={0.1} />
        </Col>
      </Row>

      <Table
        rowKey={(r: any) => r.id}
        dataSource={rows}
        columns={columns}
        size="small"
        loading={loading}
        pagination={{ defaultPageSize: 25, showSizeChanger: true, pageSizeOptions: ['10', '25', '50', '100'] }}
        onRow={(record) => ({ onClick: () => history.push(`/query-history/${record.id}`), style: { cursor: 'pointer' } })}
      />
        </TabPane>

        <TabPane tab={`In queue (${queueRows.length})`} key="queue">
          <div style={{ marginBottom: 12 }}>
            <Button icon={<ReloadOutlined />} onClick={loadQueue} loading={queueLoading}>Refresh</Button>
            <span style={{ color: '#888', marginLeft: 12 }}>Data queries currently queued or executing in the orchestrator.</span>
          </div>
          <Table
            rowKey={(r: any, i?: number) => `${r.requestId || 'q'}-${i}`}
            dataSource={queueRows}
            columns={queueColumns}
            size="small"
            loading={queueLoading}
            locale={{ emptyText: 'Queue is empty.' }}
            pagination={{ defaultPageSize: 25, showSizeChanger: true }}
            expandable={{
              expandedRowRender: (r: any) => {
                const q = r.query || {};
                const sql = q.sql || (Array.isArray(q) ? null : q.query);
                return (
                  <>
                    {typeof sql === 'string'
                      ? <CodeBlock code={sql} language="sql" />
                      : <CodeBlock code={JSON.stringify(q, null, 2)} language="json" />}
                    {r.requestId ? <div style={{ color: '#888', marginTop: 8 }}>requestId: {r.requestId}</div> : null}
                  </>
                );
              },
            }}
          />
        </TabPane>
      </Tabs>
    </div>
  );
}
