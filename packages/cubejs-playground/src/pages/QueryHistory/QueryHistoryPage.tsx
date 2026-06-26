import { useCallback, useEffect, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { Alert, Button, Card, Col, InputNumber, Radio, Row, Select, Table } from 'antd';
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

import { DEFAULT_RANGE, PercentilePicker, QueryChips, Range, cacheTag, fmtMs, fmtTs, getJson, pctLabel, rangeParams } from '../monitoring/common';
import { TimeWindow } from '../monitoring/TimeWindow';

const fmtBucket = (v: string) => {
  const d = new Date(v);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// Recharts Y-axis ticks are in ms; render them as seconds.
const fmtSecAxis = (v: number) => `${Math.round(v / 1000)}`;

export function QueryHistoryPage() {
  const history = useHistory();
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [rows, setRows] = useState<any[]>([]);
  const [series, setSeries] = useState<any[]>([]);
  const [showCharts, setShowCharts] = useState(true);

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
    </div>
  );
}
