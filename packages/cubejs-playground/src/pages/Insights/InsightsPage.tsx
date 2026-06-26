import { useCallback, useEffect, useMemo, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { Alert, Button, Col, Radio, Row, Switch, Table, Tabs, Tag, Tooltip } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

import { CodeBlock, DEFAULT_RANGE, MemberTag, QueryChips, Range, ShapeChips, cacheTag, fmtMs, fmtTs, getJson, rangeParams } from '../monitoring/common';
import { TimeWindow } from '../monitoring/TimeWindow';

const { TabPane } = Tabs;

const fmtTotal = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

const shortName = (id: string) => { const i = String(id).indexOf('.'); return i >= 0 ? String(id).slice(i + 1) : id; };

// "Extend <preAgg> +N fields" suggestion where "+N fields" expands inline to
// show exactly which members to add, in the same chip style as everywhere else.
function ExtendSuggestion({ s, onOpen }: { s: any; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const missing: string[] = s.missing || [];
  const toggle = (e: any) => { e.stopPropagation(); setOpen((v) => !v); };
  return (
    <span>
      <Tag color="blue">
        Extend{' '}
        <a onClick={(e) => { e.stopPropagation(); onOpen(s.preAgg); }}>{shortName(s.preAgg)}</a>
      </Tag>
      {open ? missing.map((m) => <MemberTag key={m} member={m} color="blue" />) : null}
      <Tag style={{ cursor: 'pointer', borderStyle: 'dashed' }} onClick={toggle}>
        {open ? 'show less' : `+${missing.length} field${missing.length === 1 ? '' : 's'}`}
      </Tag>
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
  // Recommendations "slowness" quantile: a shape is a candidate when its avg
  // duration is at/above this percentile of all query durations in the window.
  const [recPct, setRecPct] = useState(0.9);
  const [recThreshold, setRecThreshold] = useState<number | null>(null);

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

  // Lazily-loaded member co-occurrence (Model Usage drill-in).
  const [cooc, setCooc] = useState<Record<string, any>>({});
  const [coocLoading, setCoocLoading] = useState<Record<string, boolean>>({});

  // Lazily-loaded individual failing requests per error message (Errors drill-in).
  const [errorQueries, setErrorQueries] = useState<Record<string, any[]>>({});
  const [errorQueriesLoading, setErrorQueriesLoading] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setHashQueries({});
    setCooc({});
    setErrorQueries({});
    try {
      const w = rangeParams(range);
      const [t, r, e, mu, adv] = await Promise.all([
        getJson(`playground/insights/top-queries?${w}&order=${order}`),
        getJson(`playground/insights/recommendations?${w}&percentile=${recPct}`),
        getJson(`playground/insights/errors?${w}`),
        getJson(`playground/insights/model-usage?${w}`),
        getJson(`playground/insights/pre-agg-advice?${w}`).catch(() => ({ removePreAggs: [], trimFields: [] })),
      ]);
      setEnabled(Boolean(t.enabled));
      setTop(t.rows || []);
      setRecs(r.rows || []);
      setRecThreshold(typeof r.thresholdMs === 'number' ? r.thresholdMs : null);
      setErrors(e.rows || []);
      setMeasures(mu.measures || []);
      setDimensions(mu.dimensions || []);
      setRemovePreAggs(adv.removePreAggs || []);
      setTrimFields(adv.trimFields || []);
    } finally {
      setLoading(false);
    }
  }, [range, order, recPct]);

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

  const loadCooc = useCallback(
    (member: string) => {
      if (!member || cooc[member]) return;
      setCoocLoading((s) => ({ ...s, [member]: true }));
      getJson(`playground/insights/cooccurrence?member=${encodeURIComponent(member)}&${rangeParams(range)}`)
        .then((r) => setCooc((s) => ({ ...s, [member]: r })))
        .finally(() => setCoocLoading((s) => ({ ...s, [member]: false })));
    },
    [range, cooc]
  );

  const loadErrorQueries = useCallback(
    (error: string) => {
      if (!error || errorQueries[error]) return;
      setErrorQueriesLoading((s) => ({ ...s, [error]: true }));
      getJson(`playground/insights/error-queries?error=${encodeURIComponent(error)}&${rangeParams(range)}`)
        .then((r) => setErrorQueries((s) => ({ ...s, [error]: r.rows || [] })))
        .finally(() => setErrorQueriesLoading((s) => ({ ...s, [error]: false })));
    },
    [range, errorQueries]
  );

  const memberExpandable = {
    onExpand: (expanded: boolean, record: any) => {
      if (expanded) loadCooc(record.member);
    },
    expandedRowRender: (r: any) => {
      const data = cooc[r.member];
      if (coocLoading[r.member]) return <span style={{ color: '#999' }}>Loading…</span>;
      if (!data || !data.rows || !data.rows.length) {
        return <span style={{ color: '#999' }}>No co-occurring members in this window.</span>;
      }
      return (
        <div>
          <span style={{ color: '#888', marginRight: 8 }}>Most often queried together ({data.coQueries} queries):</span>
          {data.rows.map((c: any) => (
            <Tag key={c.member} style={{ margin: 2 }}>
              {c.member} <span style={{ opacity: 0.6 }}>{c.pct}%</span>
            </Tag>
          ))}
        </div>
      );
    },
  };

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
    { title: 'Query (fields)', key: 'shape', render: (_: any, r: any) => <ShapeChips shape={r.shape} /> },
    { title: 'Executions', dataIndex: 'executions', key: 'executions', width: 110, sorter: (a: any, b: any) => a.executions - b.executions },
    { title: 'Avg', dataIndex: 'avg_ms', key: 'avg_ms', width: 90, render: fmtMs },
    { title: 'p95', dataIndex: 'p95_ms', key: 'p95_ms', width: 90, render: fmtMs },
    { title: 'Total time', dataIndex: 'total_ms', key: 'total_ms', width: 110, render: (v: number) => fmtTotal(Number(v)), sorter: (a: any, b: any) => Number(a.total_ms) - Number(b.total_ms) },
    { title: 'Hit-rate', dataIndex: 'hit_rate', key: 'hit_rate', width: 100, render: (v: number) => <Tag color={v >= 80 ? 'green' : v > 0 ? 'orange' : 'red'}>{v}%</Tag> },
    { title: 'Errors', dataIndex: 'errors', key: 'errors', width: 80, render: (v: number) => (v ? <Tag color="red">{v}</Tag> : '—') },
    { title: 'Last seen', dataIndex: 'last_seen', key: 'last_seen', width: 170, render: fmtTs },
  ];

  const recColumns = [
    { title: 'Query (fields)', key: 'shape', render: (_: any, r: any) => <ShapeChips shape={r.shape} /> },
    { title: 'Executions', dataIndex: 'executions', key: 'executions', width: 110, sorter: (a: any, b: any) => a.executions - b.executions },
    { title: 'Avg', dataIndex: 'avg_ms', key: 'avg_ms', width: 90, render: fmtMs },
    { title: 'p95', dataIndex: 'p95_ms', key: 'p95_ms', width: 90, render: fmtMs },
    { title: 'Total time', dataIndex: 'total_ms', key: 'total_ms', width: 110, render: (v: number) => fmtTotal(Number(v)), defaultSortOrder: 'descend' as const, sorter: (a: any, b: any) => Number(a.total_ms) - Number(b.total_ms) },
    {
      title: 'Suggestion',
      key: 'suggestion',
      width: 280,
      render: (_: any, r: any) => {
        const s = r.suggestion || { action: 'create' };
        const openPreAgg = (id: string) => history.push(`/pre-agg-monitor/${encodeURIComponent(id)}`);
        if (s.action === 'create') {
          return <Tag color="green">New rollup</Tag>;
        }
        if (s.action === 'matches') {
          return (
            <Tooltip title="An existing pre-agg covers all these fields but didn't accelerate the query — check granularity / segments / non-additive measures.">
              <Tag color="orange">
                Check{' '}
                <a onClick={(e) => { e.stopPropagation(); openPreAgg(s.preAgg); }}>{shortName(s.preAgg)}</a>
              </Tag>
            </Tooltip>
          );
        }
        return <ExtendSuggestion s={s} onOpen={openPreAgg} />;
      },
    },
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
            <TabPane tab="Add pre-aggregation" key="add">
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="Pre-aggregation candidates"
                description="Unaccelerated query shapes whose average duration is at/above the chosen percentile of all queries in the window. Ranked by total data-source time (the time a rollup would save). Expand a row for the exact fields; the Suggestion column says whether to extend an existing rollup or create a new one."
              />
              <Row align="middle" gutter={8} style={{ marginBottom: 12 }}>
                <Col style={{ color: '#888' }}>Slowness ≥</Col>
                <Col>
                  <Radio.Group value={recPct} onChange={(e: any) => setRecPct(e.target.value)} optionType="button" size="small">
                    <Radio.Button value={0.5}>p50</Radio.Button>
                    <Radio.Button value={0.75}>p75</Radio.Button>
                    <Radio.Button value={0.9}>p90</Radio.Button>
                    <Radio.Button value={0.95}>p95</Radio.Button>
                    <Radio.Button value={0.99}>p99</Radio.Button>
                  </Radio.Group>
                </Col>
                {recThreshold != null && (
                  <Col style={{ color: '#888' }}>
                    = queries slower than <b>{recThreshold} ms</b>
                  </Col>
                )}
              </Row>
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

            <TabPane tab={`Remove (${removePreAggs.length})`} key="remove">
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

            <TabPane tab={`Trim fields (${trimFields.length})`} key="trim">
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="Fields to drop from used pre-aggregations"
                description="These pre-aggregations are used, but materialize members that are never queried — or queried in under 5% of their queries (rare dead weight). Dropping them shrinks build time and storage with little or no impact. Expand a row to see each field and its usage."
              />
              <Table
                rowKey={(r: any) => r.id}
                dataSource={trimFields}
                size="small"
                loading={loading}
                pagination={{ defaultPageSize: 15, showSizeChanger: true }}
                expandable={{
                  expandedRowRender: (r: any) => (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                      {r.fields.map((f: any) => (
                        <Tag key={`${f.kind}:${f.member}`} color={f.tier === 'never' ? 'red' : 'orange'} style={{ margin: 0 }}>
                          {f.member} <span style={{ opacity: 0.6 }}>({f.kind}, {f.tier === 'never' ? 'never' : `${f.uses}×`})</span>
                        </Tag>
                      ))}
                    </div>
                  ),
                }}
                columns={[
                  { title: 'Cube', dataIndex: 'cube', key: 'cube', width: 200 },
                  { title: 'Pre-Aggregation', dataIndex: 'name', key: 'name' },
                  { title: 'Pre-agg hits', dataIndex: 'hits', key: 'hits', width: 100 },
                  { title: 'Trim candidates', key: 'count', width: 200, render: (_: any, r: any) => (
                    <span>
                      {r.neverCount ? <Tag color="red">{r.neverCount} never</Tag> : null}
                      {r.rareCount ? <Tag color="orange">{r.rareCount} rare</Tag> : null}
                    </span>
                  ) },
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
              onExpand: (expanded: boolean, record: any) => {
                if (expanded) loadErrorQueries(record.error);
              },
              expandedRowRender: (r: any) => (
                <>
                  <pre style={{ whiteSpace: 'pre-wrap', color: '#c0392b' }}>{r.error}</pre>
                  <div style={{ color: '#888', margin: '4px 0 8px' }}>
                    All {r.count} failing request{r.count === 1 ? '' : 's'} (newest first) — click a row to open it:
                  </div>
                  <Table
                    rowKey={(rec: any) => rec.id}
                    loading={errorQueriesLoading[r.error]}
                    dataSource={errorQueries[r.error] || []}
                    columns={drillColumns}
                    size="small"
                    pagination={{ pageSize: 10 }}
                    onRow={(rec: any) => ({ onClick: () => history.push(`/query-history/${rec.id}`), style: { cursor: 'pointer' } })}
                  />
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
              <Table rowKey={(r: any) => r.member} dataSource={filteredMeasures} columns={memberColumns} size="small" loading={loading} pagination={{ defaultPageSize: 25, showSizeChanger: true }} expandable={memberExpandable} />
            </TabPane>
            <TabPane tab={`Dimensions (${filteredDimensions.length})`} key="dimensions">
              <Table rowKey={(r: any) => r.member} dataSource={filteredDimensions} columns={memberColumns} size="small" loading={loading} pagination={{ defaultPageSize: 25, showSizeChanger: true }} expandable={memberExpandable} />
            </TabPane>
          </Tabs>
        </TabPane>
      </Tabs>
    </div>
  );
}
