import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Col,
  Drawer,
  InputNumber,
  Radio,
  Row,
  Select,
  Table,
  Tabs,
  Tag,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

import { playgroundFetch } from '../../shared/helpers';

const { TabPane } = Tabs;

const fmtMs = (v: number | null) => (v == null ? '—' : `${v} ms`);
const fmtTs = (v: string | null) => (v ? new Date(v).toLocaleString() : '—');

function cacheTag(row: any) {
  if (row.status === 'error') {
    return <Tag color="red">error</Tag>;
  }
  if (row.external) {
    return <Tag color="gold">Cube Store</Tag>;
  }
  if (row.queries_with_pre_aggregations > 0) {
    return <Tag color="green">pre-agg</Tag>;
  }
  return <Tag>raw db</Tag>;
}

export function QueryHistoryPage() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [rows, setRows] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);

  const [order, setOrder] = useState<'recent' | 'top'>('recent');
  const [windowHours, setWindowHours] = useState(24);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [cache, setCache] = useState<string | undefined>(undefined);
  const [apiType, setApiType] = useState<string | undefined>(undefined);
  const [minDuration, setMinDuration] = useState<number | undefined>(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ order, windowHours: String(windowHours), limit: '300' });
      if (status) params.set('status', status);
      if (cache) params.set('cache', cache);
      if (apiType) params.set('apiType', apiType);
      if (minDuration != null) params.set('minDurationMs', String(minDuration));
      const res = await playgroundFetch(`playground/query-history?${params.toString()}`);
      const json = await res.json();
      setEnabled(Boolean(json.enabled));
      setRows(json.rows || []);
    } finally {
      setLoading(false);
    }
  }, [order, windowHours, status, cache, apiType, minDuration]);

  useEffect(() => {
    load();
  }, [load]);

  const columns = [
    { title: 'Time', dataIndex: 'ts', key: 'ts', render: fmtTs, width: 180 },
    { title: 'API', dataIndex: 'api_type', key: 'api_type', width: 70 },
    {
      title: 'Duration',
      dataIndex: 'duration_ms',
      key: 'duration_ms',
      width: 110,
      render: fmtMs,
      sorter: (a: any, b: any) => (a.duration_ms || 0) - (b.duration_ms || 0),
    },
    { title: 'Cache', key: 'cache', width: 110, render: (_: any, row: any) => cacheTag(row) },
    {
      title: 'Query',
      dataIndex: 'query',
      key: 'query',
      ellipsis: true,
      render: (q: any) => <code>{q ? JSON.stringify(q).slice(0, 120) : '—'}</code>,
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <h1 style={{ margin: 0 }}>Query History</h1>
        </Col>
        <Col>
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
          description="Set CUBEJS_TELEMETRY_DB_URL to capture query history."
        />
      )}

      <Row gutter={8} style={{ marginBottom: 16 }} align="middle">
        <Col>
          <Radio.Group value={order} onChange={(e) => setOrder(e.target.value)} optionType="button">
            <Radio.Button value="recent">All (recent)</Radio.Button>
            <Radio.Button value="top">Top (slowest)</Radio.Button>
          </Radio.Group>
        </Col>
        <Col>
          <Select
            value={windowHours}
            onChange={setWindowHours}
            style={{ width: 120 }}
            options={[
              { label: 'Last 1h', value: 1 },
              { label: 'Last 6h', value: 6 },
              { label: 'Last 24h', value: 24 },
              { label: 'Last 7d', value: 168 },
            ]}
          />
        </Col>
        <Col>
          <Select
            allowClear
            placeholder="Status"
            value={status}
            onChange={setStatus}
            style={{ width: 120 }}
            options={[
              { label: 'Success', value: 'success' },
              { label: 'Error', value: 'error' },
            ]}
          />
        </Col>
        <Col>
          <Select
            allowClear
            placeholder="Cache"
            value={cache}
            onChange={setCache}
            style={{ width: 140 }}
            options={[
              { label: 'Pre-aggregation', value: 'preagg' },
              { label: 'Raw DB', value: 'raw' },
            ]}
          />
        </Col>
        <Col>
          <Select
            allowClear
            placeholder="API type"
            value={apiType}
            onChange={setApiType}
            style={{ width: 120 }}
            options={[
              { label: 'load', value: 'load' },
              { label: 'sql', value: 'sql' },
              { label: 'graphql', value: 'graphql' },
            ]}
          />
        </Col>
        <Col>
          <InputNumber
            placeholder="Min ms"
            value={minDuration}
            onChange={(v) => setMinDuration(typeof v === 'number' ? v : undefined)}
            style={{ width: 110 }}
            min={0}
          />
        </Col>
      </Row>

      <Table
        rowKey={(r: any) => r.id}
        dataSource={rows}
        columns={columns}
        size="small"
        loading={loading}
        pagination={{ pageSize: 25 }}
        onRow={(record) => ({ onClick: () => setSelected(record), style: { cursor: 'pointer' } })}
      />

      <Drawer
        title="Query details"
        width={640}
        visible={Boolean(selected)}
        onClose={() => setSelected(null)}
      >
        {selected && (
          <Tabs defaultActiveKey="query">
            <TabPane tab="Overview" key="overview">
              <p><b>Time:</b> {fmtTs(selected.ts)}</p>
              <p><b>Request ID:</b> {selected.request_id || '—'}</p>
              <p><b>API type:</b> {selected.api_type || '—'}</p>
              <p><b>Duration:</b> {fmtMs(selected.duration_ms)}</p>
              <p><b>Status:</b> {selected.status} {cacheTag(selected)}</p>
              <p><b>DB type:</b> {selected.db_type ? JSON.stringify(selected.db_type) : '—'}</p>
            </TabPane>
            <TabPane tab="Query" key="query">
              <pre style={{ whiteSpace: 'pre-wrap' }}>
                {selected.query ? JSON.stringify(selected.query, null, 2) : '—'}
              </pre>
            </TabPane>
            <TabPane tab="SQL" key="sql">
              {selected.sql && (
                <>
                  <p><b>Inbound SQL</b> (from the client):</p>
                  <pre style={{ whiteSpace: 'pre-wrap' }}>{selected.sql}</pre>
                </>
              )}
              {Array.isArray(selected.generated_sql) && selected.generated_sql.length > 0 && (
                <>
                  <p><b>Generated SQL</b> (sent to the data source):</p>
                  {selected.generated_sql.map((s: string, i: number) => (
                    <pre key={i} style={{ whiteSpace: 'pre-wrap' }}>{s}</pre>
                  ))}
                </>
              )}
              {!selected.sql && !(selected.generated_sql && selected.generated_sql.length) && <p>—</p>}
            </TabPane>
            <TabPane tab="Pre-Aggregations" key="preaggs">
              {selected.used_pre_aggregations && Object.keys(selected.used_pre_aggregations).length ? (
                <pre style={{ whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(selected.used_pre_aggregations, null, 2)}
                </pre>
              ) : (
                <p>Not accelerated — served from the data source.</p>
              )}
            </TabPane>
            <TabPane tab="Security Context" key="security">
              <pre style={{ whiteSpace: 'pre-wrap' }}>
                {selected.security_context ? JSON.stringify(selected.security_context, null, 2) : '—'}
              </pre>
            </TabPane>
            {selected.status === 'error' && (
              <TabPane tab="Error" key="error">
                <pre style={{ whiteSpace: 'pre-wrap', color: '#c0392b' }}>{selected.error || '—'}</pre>
              </TabPane>
            )}
          </Tabs>
        )}
      </Drawer>
    </div>
  );
}
