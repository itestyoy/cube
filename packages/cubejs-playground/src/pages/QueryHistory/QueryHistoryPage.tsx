import { useCallback, useEffect, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { Alert, Button, Card, Col, InputNumber, Radio, Row, Select, Table } from 'antd';
import { ReloadOutlined, LineChartOutlined } from '@ant-design/icons';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { DEFAULT_RANGE, QueryChips, Range, cacheTag, fmtMs, fmtTs, getJson, rangeParams } from '../monitoring/common';
import { TimeWindow } from '../monitoring/TimeWindow';

const fmtBucket = (v: string) => {
  const d = new Date(v);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function QueryHistoryPage() {
  const history = useHistory();
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [rows, setRows] = useState<any[]>([]);
  const [series, setSeries] = useState<any[]>([]);
  const [showCharts, setShowCharts] = useState(true);

  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
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
      if (minDuration != null) params.set('minDurationMs', String(minDuration));
      const qs = `${rangeParams(range)}&${params.toString()}`;
      const [json, ts] = await Promise.all([
        getJson(`playground/query-history?${qs}`),
        getJson(`playground/query-history/timeseries?${rangeParams(range)}`).catch(() => ({ rows: [] })),
      ]);
      setEnabled(Boolean(json.enabled));
      setRows(json.rows || []);
      setSeries(ts.rows || []);
    } finally {
      setLoading(false);
    }
  }, [range, order, status, cache, apiType, minDuration]);

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
            <Card title="Requests" size="small">
              <div style={{ height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={series}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="bucket" tickFormatter={fmtBucket} minTickGap={40} />
                    <YAxis allowDecimals={false} />
                    <RechartsTooltip labelFormatter={fmtBucket} />
                    <Bar dataKey="total" name="Requests" fill="#7A77FF" stackId="a" />
                    <Bar dataKey="errors" name="Errors" fill="#e0245e" stackId="a" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </Col>
          <Col span={12}>
            <Card title="Average response time" size="small">
              <div style={{ height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="bucket" tickFormatter={fmtBucket} minTickGap={40} />
                    <YAxis unit="ms" />
                    <RechartsTooltip labelFormatter={fmtBucket} />
                    <Line type="monotone" dataKey="avg_ms" name="Avg" stroke="#7A77FF" dot={false} />
                    <Line type="monotone" dataKey="p95_ms" name="p95" stroke="#faad14" dot={false} />
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
          <InputNumber placeholder="Min ms" value={minDuration} onChange={(v) => setMinDuration(typeof v === 'number' ? v : undefined)} style={{ width: 110 }} min={0} />
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
