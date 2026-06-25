import { useCallback, useEffect, useMemo, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { Alert, Button, Col, Radio, Row, Select, Switch, Table, Tabs, Tag } from 'antd';
import { ReloadOutlined, ArrowRightOutlined } from '@ant-design/icons';

import { CodeBlock, cacheTag, fmtMs, fmtTs, getJson } from '../monitoring/common';

const { TabPane } = Tabs;

const WINDOW_OPTIONS = [
  { label: 'Last 1h', value: 1 },
  { label: 'Last 6h', value: 6 },
  { label: 'Last 24h', value: 24 },
  { label: 'Last 7d', value: 168 },
];

const fmtTotal = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

function shapeSummary(shape: any) {
  if (!shape) return <span style={{ color: '#999' }}>—</span>;
  const m = shape.measures || [];
  const d = shape.dimensions || [];
  const f = shape.filters || [];
  const td = shape.timeDimensions || [];
  const first = [...m, ...d].slice(0, 2).join(', ');
  return (
    <span>
      <Tag color="blue">{m.length}m</Tag>
      <Tag color="purple">{d.length}d</Tag>
      {td.length ? <Tag>{td.length}td</Tag> : null}
      {f.length ? <Tag color="orange">{f.length}f</Tag> : null}
      <span style={{ color: '#666', marginLeft: 6 }}>{first}</span>
    </span>
  );
}

export function InsightsPage() {
  const history = useHistory();
  const [windowHours, setWindowHours] = useState(24);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [order, setOrder] = useState<'total' | 'count'>('total');
  const [onlyUnused, setOnlyUnused] = useState(false);

  const [top, setTop] = useState<any[]>([]);
  const [recs, setRecs] = useState<any[]>([]);
  const [errors, setErrors] = useState<any[]>([]);
  const [measures, setMeasures] = useState<any[]>([]);
  const [dimensions, setDimensions] = useState<any[]>([]);

  // Lazily-loaded individual queries per fingerprint (Top Queries / Recs drill-in).
  const [hashQueries, setHashQueries] = useState<Record<string, any[]>>({});
  const [hashLoading, setHashLoading] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setHashQueries({});
    try {
      const w = `windowHours=${windowHours}`;
      const [t, r, e, mu] = await Promise.all([
        getJson(`playground/insights/top-queries?${w}&order=${order}`),
        getJson(`playground/insights/recommendations?${w}`),
        getJson(`playground/insights/errors?${w}`),
        getJson(`playground/insights/model-usage?${w}`),
      ]);
      setEnabled(Boolean(t.enabled));
      setTop(t.rows || []);
      setRecs(r.rows || []);
      setErrors(e.rows || []);
      setMeasures(mu.measures || []);
      setDimensions(mu.dimensions || []);
    } finally {
      setLoading(false);
    }
  }, [windowHours, order]);

  useEffect(() => {
    load();
  }, [load]);

  const loadHash = useCallback(
    (hash: string) => {
      if (!hash || hashQueries[hash]) return;
      setHashLoading((s) => ({ ...s, [hash]: true }));
      getJson(`playground/insights/hash-queries?hash=${encodeURIComponent(hash)}&windowHours=${windowHours}`)
        .then((r) => setHashQueries((s) => ({ ...s, [hash]: r.rows || [] })))
        .finally(() => setHashLoading((s) => ({ ...s, [hash]: false })));
    },
    [windowHours, hashQueries]
  );

  const drillColumns = [
    { title: 'Time', dataIndex: 'ts', key: 'ts', render: fmtTs, width: 180 },
    { title: 'API', dataIndex: 'api_type', key: 'api_type', width: 70 },
    { title: 'Duration', dataIndex: 'duration_ms', key: 'duration_ms', render: fmtMs, width: 110, sorter: (a: any, b: any) => (a.duration_ms || 0) - (b.duration_ms || 0) },
    { title: 'Cache', key: 'cache', width: 120, render: (_: any, r: any) => cacheTag(r) },
  ];

  // Expanded row for a fingerprint: its shape + the individual executions,
  // each clickable through to the full Request detail.
  const renderHashDetail = (r: any) => (
    <>
      <CodeBlock code={JSON.stringify(r.shape || {}, null, 2)} language="json" />
      <Table
        style={{ marginTop: 12 }}
        rowKey={(rec: any) => rec.id}
        loading={hashLoading[r.query_hash]}
        dataSource={hashQueries[r.query_hash] || []}
        columns={drillColumns}
        size="small"
        pagination={{ pageSize: 10 }}
        onRow={(rec: any) => ({ onClick: () => history.push(`/query-history/${rec.id}`), style: { cursor: 'pointer' } })}
      />
    </>
  );

  const hashExpandable = {
    expandedRowRender: renderHashDetail,
    onExpand: (expanded: boolean, record: any) => {
      if (expanded) loadHash(record.query_hash);
    },
  };

  const topColumns = [
    { title: 'Query (fields)', key: 'shape', render: (_: any, r: any) => shapeSummary(r.shape) },
    { title: 'Executions', dataIndex: 'executions', key: 'executions', width: 110, sorter: (a: any, b: any) => a.executions - b.executions },
    { title: 'Avg', dataIndex: 'avg_ms', key: 'avg_ms', width: 90, render: fmtMs },
    { title: 'p95', dataIndex: 'p95_ms', key: 'p95_ms', width: 90, render: fmtMs },
    { title: 'Total time', dataIndex: 'total_ms', key: 'total_ms', width: 110, render: (v: number) => fmtTotal(Number(v)), sorter: (a: any, b: any) => Number(a.total_ms) - Number(b.total_ms) },
    { title: 'Hit-rate', dataIndex: 'hit_rate', key: 'hit_rate', width: 100, render: (v: number) => <Tag color={v >= 80 ? 'green' : v > 0 ? 'orange' : 'red'}>{v}%</Tag> },
    { title: 'Errors', dataIndex: 'errors', key: 'errors', width: 80, render: (v: number) => (v ? <Tag color="red">{v}</Tag> : '—') },
    { title: 'Last seen', dataIndex: 'last_seen', key: 'last_seen', width: 170, render: fmtTs },
  ];

  const recColumns = [
    { title: 'Query (fields)', key: 'shape', render: (_: any, r: any) => shapeSummary(r.shape) },
    { title: 'Executions', dataIndex: 'executions', key: 'executions', width: 110, sorter: (a: any, b: any) => a.executions - b.executions },
    { title: 'Avg', dataIndex: 'avg_ms', key: 'avg_ms', width: 90, render: fmtMs },
    { title: 'p95', dataIndex: 'p95_ms', key: 'p95_ms', width: 90, render: fmtMs },
    { title: 'Total time', dataIndex: 'total_ms', key: 'total_ms', width: 110, render: (v: number) => fmtTotal(Number(v)), defaultSortOrder: 'descend' as const, sorter: (a: any, b: any) => Number(a.total_ms) - Number(b.total_ms) },
    { title: 'Last seen', dataIndex: 'last_seen', key: 'last_seen', width: 170, render: fmtTs },
  ];

  const errorColumns = [
    { title: 'Error', dataIndex: 'error', key: 'error', ellipsis: true, render: (e: string) => <code style={{ color: '#c0392b' }}>{e}</code> },
    { title: 'Count', dataIndex: 'count', key: 'count', width: 90, sorter: (a: any, b: any) => a.count - b.count },
    { title: 'API', dataIndex: 'api_type', key: 'api_type', width: 80 },
    { title: 'Last seen', dataIndex: 'last_seen', key: 'last_seen', width: 170, render: fmtTs },
  ];

  const memberColumns = [
    { title: 'Member', dataIndex: 'member', key: 'member' },
    { title: 'Cube', dataIndex: 'cube', key: 'cube', width: 180 },
    { title: 'Type', dataIndex: 'type', key: 'type', width: 110 },
    {
      title: 'Uses',
      dataIndex: 'uses',
      key: 'uses',
      width: 110,
      defaultSortOrder: 'descend' as const,
      sorter: (a: any, b: any) => a.uses - b.uses,
      render: (v: number) => (v > 0 ? v : <Tag color="red">never used</Tag>),
    },
  ];

  const filteredMeasures = useMemo(() => (onlyUnused ? measures.filter((m) => !m.uses) : measures), [measures, onlyUnused]);
  const filteredDimensions = useMemo(() => (onlyUnused ? dimensions.filter((d) => !d.uses) : dimensions), [dimensions, onlyUnused]);
  const deadCount = useMemo(
    () => measures.filter((m) => !m.uses).length + dimensions.filter((d) => !d.uses).length,
    [measures, dimensions]
  );

  return (
    <div style={{ padding: 24 }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <h1 style={{ margin: 0 }}>Insights</h1>
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
          description="Set CUBEJS_TELEMETRY_DB_URL to enable query analytics."
        />
      )}

      <Tabs defaultActiveKey="top">
        <TabPane tab="Top Queries" key="top">
          <div style={{ marginBottom: 12 }}>
            <Radio.Group value={order} onChange={(e) => setOrder(e.target.value)} optionType="button">
              <Radio.Button value="total">By total time</Radio.Button>
              <Radio.Button value="count">By executions</Radio.Button>
            </Radio.Group>
            <span style={{ color: '#888', marginLeft: 12 }}>
              Identical query shapes (same fields, any filter values) are grouped — find the heaviest recurring queries.
            </span>
          </div>
          <Table
            rowKey={(r: any) => r.query_hash}
            dataSource={top}
            columns={topColumns}
            size="small"
            loading={loading}
            pagination={{ defaultPageSize: 25, showSizeChanger: true }}
            expandable={hashExpandable}
          />
        </TabPane>

        <TabPane tab="Recommendations" key="recs">
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="Pre-aggregation candidates"
            description="Frequent / slow query shapes that were NOT accelerated by any pre-aggregation. Building a rollup for the top rows would cut the most data-source time."
          />
          <Table
            rowKey={(r: any) => r.query_hash}
            dataSource={recs}
            columns={recColumns}
            size="small"
            loading={loading}
            pagination={{ defaultPageSize: 25, showSizeChanger: true }}
            expandable={hashExpandable}
          />
        </TabPane>

        <TabPane tab={`Errors (${errors.length})`} key="errors">
          <Table
            rowKey={(r: any, i?: number) => `${i}-${r.count}`}
            dataSource={errors}
            columns={errorColumns}
            size="small"
            loading={loading}
            pagination={{ defaultPageSize: 25, showSizeChanger: true }}
            expandable={{
              expandedRowRender: (r: any) => (
                <>
                  <pre style={{ whiteSpace: 'pre-wrap', color: '#c0392b' }}>{r.error}</pre>
                  {r.sample_id != null && (
                    <Button
                      type="link"
                      style={{ paddingLeft: 0 }}
                      onClick={() => history.push(`/query-history/${r.sample_id}`)}
                    >
                      Open latest failing request <ArrowRightOutlined />
                    </Button>
                  )}
                  {r.sample_query ? <CodeBlock code={JSON.stringify(r.sample_query, null, 2)} language="json" /> : null}
                </>
              ),
            }}
          />
        </TabPane>

        <TabPane tab="Model Usage" key="model">
          <div style={{ marginBottom: 12 }}>
            <Switch checked={onlyUnused} onChange={setOnlyUnused} /> <span style={{ marginRight: 12 }}>Only never-used</span>
            <Tag color={deadCount ? 'red' : 'green'}>{deadCount} never-used members</Tag>
            <span style={{ color: '#888', marginLeft: 12 }}>Members never queried in this window are candidates for removal from the model.</span>
          </div>
          <Tabs defaultActiveKey="measures" type="card">
            <TabPane tab={`Measures (${filteredMeasures.length})`} key="measures">
              <Table rowKey={(r: any) => r.member} dataSource={filteredMeasures} columns={memberColumns} size="small" loading={loading} pagination={{ defaultPageSize: 25, showSizeChanger: true }} />
            </TabPane>
            <TabPane tab={`Dimensions (${filteredDimensions.length})`} key="dimensions">
              <Table rowKey={(r: any) => r.member} dataSource={filteredDimensions} columns={memberColumns} size="small" loading={loading} pagination={{ defaultPageSize: 25, showSizeChanger: true }} />
            </TabPane>
          </Tabs>
        </TabPane>
      </Tabs>
    </div>
  );
}
