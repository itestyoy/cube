import { useCallback, useEffect, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { Alert, Button, Col, InputNumber, Radio, Row, Select, Table } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

import { cacheTag, fmtMs, fmtTs, getJson } from '../monitoring/common';

export function QueryHistoryPage() {
  const history = useHistory();
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [rows, setRows] = useState<any[]>([]);

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
      const json = await getJson(`playground/query-history?${params.toString()}`);
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
    { title: 'Cache', key: 'cache', width: 120, render: (_: any, row: any) => cacheTag(row) },
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
        pagination={{ defaultPageSize: 25, showSizeChanger: true, pageSizeOptions: ["10","15","25","50","100"] }}
        onRow={(record) => ({ onClick: () => history.push(`/query-history/${record.id}`), style: { cursor: 'pointer' } })}
      />
    </div>
  );
}
