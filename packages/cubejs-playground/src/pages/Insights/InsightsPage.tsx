import { useCallback, useEffect, useMemo, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { Alert, Button, Col, Radio, Row, Switch, Table, Tabs, Tag } from 'antd';
import { ReloadOutlined, ArrowRightOutlined } from '@ant-design/icons';

import { CodeBlock, DEFAULT_RANGE, MemberTag, QueryChips, Range, cacheTag, fmtMs, fmtTs, getJson, rangeParams } from '../monitoring/common';
import { TimeWindow } from '../monitoring/TimeWindow';

const { TabPane } = Tabs;

const fmtTotal = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

// Render a fingerprint shape as member chips (measures / dimensions / time /
// filters), truncated, mirroring the table chip style.
function shapeSummary(shape: any) {
  if (!shape) return <span style={{ color: '#999' }}>—</span>;
  const chips: any[] = [];
  (shape.measures || []).forEach((m: string) => chips.push(<MemberTag key={`m${m}`} member={m} color="green" />));
  (shape.dimensions || []).forEach((d: string) => chips.push(<MemberTag key={`d${d}`} member={d} color="blue" />));
  (shape.timeDimensions || []).forEach((t: string, i: number) =>
    chips.push(<MemberTag key={`t${i}`} member={String(t).replace(':', ' · ')} color="geekblue" />));
  (shape.filters || []).forEach((f: string, i: number) => chips.push(<MemberTag key={`f${i}`} member={f} color="orange" />));
  const shown = chips.slice(0, 6);
  const more = chips.length - shown.length;
  return (
    <span>
      {shown.length ? shown : <span style={{ color: '#999' }}>—</span>}
      {more > 0 ? <Tag>+{more}</Tag> : null}
    </span>
  );
}

export function InsightsPage() {
  const history = useHistory();
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [order, setOrder] = useState<'total' | 'count'>('total');
  const [onlyUnused, setOnlyUnused] = useState(false);

  const [top, setTop] = useState<any[]>([]);
  const [recs, setRecs] = useState<any[]>([]);
  const [errors, setErrors] = useState<any[]>([]);
  const [measures, setMeasures] = useState<any[]>([]);
  const [dimensions, setDimensions] = useState<any[]>([]);
  const [removePreAggs, setRemovePreAggs] = useState<any[]>([]);
  const [trimFields, setTrimFields] = useState<any[]>([]);

  // Lazily-loaded individual queries per fingerprint (Top Queries / Recs drill-in).
  const [hashQueries, setHashQueries] = useState<Record<string, any[]>>({});
  const [hashLoading, setHashLoading] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setHashQueries({});
    try {
      const w = rangeParams(range);
      const [t, r, e, mu, adv] = await Promise.all([
        getJson(`playground/insights/top-queries?${w}&order=${order}`),
        getJson(`playground/insights/recommendations?${w}`),
        getJson(`playground/insights/errors?${w}`),
        getJson(`playground/insights/model-usage?${w}`),
        getJson(`playground/insights/pre-agg-advice?${w}`).catch(() => ({ removePreAggs: [], trimFields: [] })),
      ]);
      setEnabled(Boolean(t.enabled));
      setTop(t.rows || []);
      setRecs(r.rows || []);
      setErrors(e.rows || []);
      setMeasures(mu.measures || []);
      setDimensions(mu.dimensions || []);
      setRemovePreAggs(adv.removePreAggs || []);
      setTrimFields(adv.trimFields || []);
    } finally {
      setLoading(false);
    }
  }, [range, order]);

  useEffect(() => {
    load();
  }, [load]);

  const loadHash = useCallback(
    (hash: string) => {
      if (!hash || hashQueries[hash]) return;
      setHashLoading((s) => ({ ...s, [hash]: true }));
      getJson(`playground/insights/hash-queries?hash=${encodeURIComponent(hash)}&${rangeParams(range)}`)
        .then((r) => setHashQueries((s) => ({ ...s, [hash]: r.rows || [] })))
        .finally(() => setHashLoading((s) => ({ ...s, [hash]: false })));
    },
    [range, hashQueries]
  );

  const drillColumns = [
    { title: 'Time', dataIndex: 'ts', key: 'ts', render: fmtTs, width: 180 },
    { title: 'API', dataIndex: 'api_type', key: 'api_type', width: 70 },
    { title: 'Duration', dataIndex: 'duration_ms', key: 'duration_ms', render: fmtMs, width: 110, sorter: (a: any, b: any) => (a.duration_ms || 0) - (b.duration_ms || 0) },
    { title: 'Cache', key: 'cache', width: 120, render: (_: any, r: any) => cacheTag(r) },
    { title: 'Query', dataIndex: 'query', key: 'query', render: (q: any) => <QueryChips query={q} max={4} /> },
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
          <TimeWindow value={range} onChange={setRange} />
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
          <Tabs defaultActiveKey="add" type="card">
            <TabPane tab="➕ Add pre-aggregation" key="add">
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="Pre-aggregation candidates"
                description="Frequent / slow query shapes NOT accelerated by any pre-aggregation. Building a rollup over these fields would cut the most data-source time. Expand a row to see the exact fields to include."
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

            <TabPane tab={`➖ Remove (${removePreAggs.length})`} key="remove">
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="Unused pre-aggregations"
                description="Defined pre-aggregations with no queries in this window. Those marked 'Built but never used' cost build time and storage for nothing — candidates for removal."
              />
              <Table
                rowKey={(r: any) => r.id}
                dataSource={removePreAggs}
                size="small"
                loading={loading}
                pagination={{ defaultPageSize: 25, showSizeChanger: true }}
                onRow={(rec: any) => ({ onClick: () => history.push(`/pre-agg-monitor/${encodeURIComponent(rec.id)}`), style: { cursor: 'pointer' } })}
                columns={[
                  { title: 'Cube', dataIndex: 'cube', key: 'cube', width: 200 },
                  { title: 'Pre-Aggregation', dataIndex: 'name', key: 'name' },
                  { title: 'Builds', dataIndex: 'build_count', key: 'build_count', width: 90, render: (v: number) => v || '—' },
                  { title: 'Avg build', dataIndex: 'avg_build_ms', key: 'avg_build_ms', width: 110, render: fmtMs },
                  { title: 'Reason', dataIndex: 'reason', key: 'reason', render: (v: string) => <Tag color={v?.startsWith('Built') ? 'orange' : 'red'}>{v}</Tag> },
                ]}
              />
            </TabPane>

            <TabPane tab={`✂️ Trim fields (${trimFields.length})`} key="trim">
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="Fields to drop from used pre-aggregations"
                description="These pre-aggregations are used, but materialize members that are never queried. Removing the listed fields shrinks build time and storage without affecting any query."
              />
              <Table
                rowKey={(r: any) => r.id}
                dataSource={trimFields}
                size="small"
                loading={loading}
                pagination={{ defaultPageSize: 15, showSizeChanger: true }}
                expandable={{
                  expandedRowRender: (r: any) => (
                    <span>
                      {r.fields.map((f: any) => (
                        <Tag key={`${f.kind}:${f.member}`} color="red" style={{ margin: 2 }}>
                          {f.member} <span style={{ opacity: 0.6 }}>({f.kind})</span>
                        </Tag>
                      ))}
                    </span>
                  ),
                }}
                columns={[
                  { title: 'Cube', dataIndex: 'cube', key: 'cube', width: 200 },
                  { title: 'Pre-Aggregation', dataIndex: 'name', key: 'name' },
                  { title: 'Never-used fields', key: 'count', width: 160, render: (_: any, r: any) => <Tag color="red">{r.fields.length}</Tag> },
                  { title: '', key: 'go', width: 60, render: (_: any, r: any) => <Button type="link" size="small" onClick={(e: any) => { e.stopPropagation(); history.push(`/pre-agg-monitor/${encodeURIComponent(r.id)}`); }}>open</Button> },
                ]}
              />
            </TabPane>
          </Tabs>
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
