import { useCallback, useEffect, useMemo, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { Alert, Button, Col, Radio, Row, Switch, Table, Tabs, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

import { ChipList, CodeBlock, DEFAULT_RANGE, MemberTag, QueryChips, Range, ShapeChips, cacheTag, fmtMs, fmtTs, getJson, rangeParams } from '../monitoring/common';
import { TimeWindow } from '../monitoring/TimeWindow';

const { TabPane } = Tabs;

const fmtTotal = (ms: number) => fmtMs(ms);

const shortName = (id: string) => { const i = String(id).indexOf('.'); return i >= 0 ? String(id).slice(i + 1) : id; };

const ACTION_META: Record<string, { color: string; label: string }> = {
  create: { color: 'green', label: 'New rollup' },
  edit: { color: 'blue', label: 'Edit rollup' },
  fix: { color: 'orange', label: 'Fix rollup' },
  drop: { color: 'red', label: 'Drop rollup' },
};

// The member diff an action proposes: +added (green/blue) and −removed (red),
// all expandable via the shared ChipList so long diffs don't flood the row.
function ActionChange({ a }: { a: any }) {
  const chips: any[] = [];
  (a.add || []).forEach((m: any) =>
    chips.push(<MemberTag key={`+${m.member}`} member={`+ ${m.member}`} color={m.kind === 'measure' ? 'green' : 'blue'} />));
  (a.remove || []).forEach((m: any) =>
    chips.push(<MemberTag key={`-${m.member}`} member={`− ${m.member}${m.uses ? ` (${m.uses}×)` : ''}`} color="red" />));
  if (!chips.length) return <span style={{ color: '#999' }}>—</span>;
  return <ChipList chips={chips} max={6} />;
}

export function InsightsPage() {
  const history = useHistory();
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [order, setOrder] = useState<'total' | 'count'>('total');
  const [onlyUnused, setOnlyUnused] = useState(false);
  // Recommendation engine knobs (quantile-based, no magic thresholds):
  // slowness = a shape is a candidate when avg duration ≥ this percentile of
  // the workload; rarity = a rollup member counts as dead weight below this
  // percentile of member usage.
  const [recPct, setRecPct] = useState(0.9);
  const [rarityPct, setRarityPct] = useState(0.1);
  const [actionType, setActionType] = useState<'all' | 'create' | 'edit' | 'fix' | 'drop'>('all');

  const [top, setTop] = useState<any[]>([]);
  const [actions, setActions] = useState<any[]>([]);
  const [thresholds, setThresholds] = useState<any | null>(null);
  const [errors, setErrors] = useState<any[]>([]);
  const [measures, setMeasures] = useState<any[]>([]);
  const [dimensions, setDimensions] = useState<any[]>([]);

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
      const [t, r, e, mu] = await Promise.all([
        getJson(`playground/insights/top-queries?${w}&order=${order}`),
        getJson(`playground/insights/recommendations?${w}&percentile=${recPct}&rarityPct=${rarityPct}`),
        getJson(`playground/insights/errors?${w}`),
        getJson(`playground/insights/model-usage?${w}`),
      ]);
      setEnabled(Boolean(t.enabled));
      setTop(t.rows || []);
      setActions(r.actions || []);
      setThresholds(r.thresholds || null);
      setErrors(e.rows || []);
      setMeasures(mu.measures || []);
      setDimensions(mu.dimensions || []);
    } finally {
      setLoading(false);
    }
  }, [range, order, recPct, rarityPct]);

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

  const actionColumns = [
    {
      title: 'Action',
      key: 'type',
      width: 130,
      render: (_: any, a: any) => {
        const m = ACTION_META[a.type] || { color: 'default', label: a.type };
        return <Tag color={m.color}>{m.label}</Tag>;
      },
    },
    {
      title: 'Target',
      key: 'target',
      width: 260,
      render: (_: any, a: any) =>
        a.rollup ? (
          <a onClick={(e) => { e.stopPropagation(); history.push(`/pre-agg-monitor/${encodeURIComponent(a.rollup)}`); }}>
            <span style={{ opacity: 0.55 }}>{a.cube} · </span>{shortName(a.rollup)}
          </a>
        ) : (
          <span><span style={{ opacity: 0.55 }}>{a.cube} · </span>{a.proposedName || 'new rollup'}{a.granularity ? ` · ${a.granularity}` : ''}</span>
        ),
    },
    { title: 'Change', key: 'change', render: (_: any, a: any) => <ActionChange a={a} /> },
    {
      title: 'Impact',
      key: 'impact',
      width: 150,
      render: (_: any, a: any) =>
        a.benefitMs ? (
          <span>
            <b>{fmtTotal(Number(a.benefitMs))}</b>
            <div style={{ color: '#888', fontSize: 12 }}>{a.shapesCovered} shape(s) · {a.executions}×</div>
          </span>
        ) : <span style={{ color: '#999' }}>—</span>,
    },
    {
      title: 'Confidence',
      dataIndex: 'confidence',
      key: 'confidence',
      width: 110,
      render: (v: number) => <Tag color={v >= 0.8 ? 'green' : v >= 0.4 ? 'orange' : 'default'}>{Math.round((v || 0) * 100)}%</Tag>,
    },
    {
      title: 'Score',
      dataIndex: 'score',
      key: 'score',
      width: 100,
      defaultSortOrder: 'descend' as const,
      sorter: (a: any, b: any) => (a.score || 0) - (b.score || 0),
      render: (v: number) => Math.round(v || 0).toLocaleString(),
    },
  ];

  // Expanded action row: the human explanation + (when it ties to a workload
  // shape) the individual queries behind it, clickable through to detail.
  const renderActionDetail = (a: any) => (
    <div>
      <div style={{ marginBottom: 8 }}>{a.detail}</div>
      {a.reason ? <Tag color="orange" style={{ marginBottom: 8 }}>reason: {a.reason}</Tag> : null}
      {a.sampleHash ? (
        <Table
          rowKey={(rec: any) => rec.id}
          loading={hashLoading[a.sampleHash]}
          dataSource={hashQueries[a.sampleHash] || []}
          columns={drillColumns}
          size="small"
          pagination={{ pageSize: 10 }}
          onRow={(rec: any) => ({ onClick: () => history.push(`/query-history/${rec.id}`), style: { cursor: 'pointer' } })}
        />
      ) : null}
    </div>
  );

  const actionExpandable = {
    expandedRowRender: renderActionDetail,
    onExpand: (expanded: boolean, a: any) => {
      if (expanded && a.sampleHash) loadHash(a.sampleHash);
    },
  };

  const filteredActions = useMemo(
    () => (actionType === 'all' ? actions : actions.filter((a) => a.type === actionType)),
    [actions, actionType]
  );
  const actionCounts = useMemo(() => {
    const c: Record<string, number> = { create: 0, edit: 0, fix: 0, drop: 0 };
    actions.forEach((a) => { c[a.type] = (c[a.type] || 0) + 1; });
    return c;
  }, [actions]);

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

        <TabPane tab={`Recommendations (${actions.length})`} key="recs">
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="Action Center"
            description="One ranked list of pre-aggregation actions: create a rollup for slow uncovered queries, edit a rollup (add the fields it's missing, drop rarely-used ones), fix a rollup that covers a query but doesn't accelerate it, or drop an unused rollup. Granularity- and additivity-aware. Ranked by benefit (data-source time addressed) × confidence (how often the query runs). Expand a row for the reason and the queries behind it."
          />
          <Row align="middle" gutter={[8, 8]} style={{ marginBottom: 12 }}>
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
            {thresholds?.slownessMs != null && (
              <Col style={{ color: '#888' }}>≈ <b>{fmtMs(thresholds.slownessMs)}</b></Col>
            )}
            <Col style={{ color: '#888', marginLeft: 16 }}>Rare ≤</Col>
            <Col>
              <Radio.Group value={rarityPct} onChange={(e: any) => setRarityPct(e.target.value)} optionType="button" size="small">
                <Radio.Button value={0.05}>p5</Radio.Button>
                <Radio.Button value={0.1}>p10</Radio.Button>
                <Radio.Button value={0.25}>p25</Radio.Button>
              </Radio.Group>
            </Col>
            {thresholds?.rarityUses != null && (
              <Col style={{ color: '#888' }}>≈ <b>{thresholds.rarityUses}×</b></Col>
            )}
          </Row>
          <Row style={{ marginBottom: 12 }}>
            <Radio.Group value={actionType} onChange={(e: any) => setActionType(e.target.value)} optionType="button" size="small">
              <Radio.Button value="all">All ({actions.length})</Radio.Button>
              <Radio.Button value="create">New ({actionCounts.create})</Radio.Button>
              <Radio.Button value="edit">Edit ({actionCounts.edit})</Radio.Button>
              <Radio.Button value="fix">Fix ({actionCounts.fix})</Radio.Button>
              <Radio.Button value="drop">Drop ({actionCounts.drop})</Radio.Button>
            </Radio.Group>
          </Row>
          <Table
            rowKey={(a: any, i?: number) => `${a.type}-${a.rollup || a.proposedName}-${i}`}
            dataSource={filteredActions}
            columns={actionColumns}
            size="small"
            loading={loading}
            pagination={{ defaultPageSize: 25, showSizeChanger: true }}
            expandable={actionExpandable}
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
