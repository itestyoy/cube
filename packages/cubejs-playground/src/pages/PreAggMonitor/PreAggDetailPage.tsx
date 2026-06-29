import { useEffect, useState } from 'react';
import { useHistory, useParams } from 'react-router-dom';
import { Card, Col, Descriptions, Empty, PageHeader, Row, Spin, Statistic, Table, Tabs, Tag } from 'antd';

import { CodeBlock, PercentilePicker, QueryChips, fmtMs, fmtTs, getJson, pctLabel, preAggStatusTag, rangeParams, useSharedRange } from '../monitoring/common';
import { TimeWindow } from '../monitoring/TimeWindow';

const { TabPane } = Tabs;

export function PreAggDetailPage() {
  const { id } = useParams<{ id: string }>();
  const history = useHistory();
  const [range, setRange] = useSharedRange();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any | null>(null);
  const [latencyPct, setLatencyPct] = useState(0.95);

  // Partitions are a heavy orchestrator call — load lazily on first tab open.
  const [parts, setParts] = useState<any | null>(null);
  const [partsLoading, setPartsLoading] = useState(false);

  // "Used By" is server-paginated (the served-query set can be huge).
  const USEDBY_PAGE = 25;
  const [activeTab, setActiveTab] = useState('overview');
  const emptyPage = { rows: [] as any[], total: 0, page: 1, loading: false };
  const [usedBy, setUsedBy] = useState(emptyPage);
  const [builds, setBuilds] = useState(emptyPage);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setParts(null);
    getJson(`playground/pre-agg-monitor/preagg?id=${encodeURIComponent(id)}&percentile=${latencyPct}&${rangeParams(range)}`)
      .then((r) => {
        if (active) setData(r && r.found ? r : null);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [id, latencyPct, range]);

  // (Re)load the Used By page whenever its tab is active and the underlying
  // data (pre-agg / window) changes — back to page 1.
  useEffect(() => {
    if (!data || !data.preAgg) return;
    if (activeTab === 'used-by' && data.preAgg.usageKey) loadUsedBy(1);
    if (activeTab === 'builds') loadBuilds(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, data]);

  const loadPartitions = () => {
    if (parts || partsLoading) return;
    setPartsLoading(true);
    getJson(`playground/pre-agg-monitor/preagg-partitions?id=${encodeURIComponent(id)}`)
      .then((r) => setParts(r || { partitions: [] }))
      .finally(() => setPartsLoading(false));
  };

  const loadUsedBy = (page: number) => {
    const key = data && data.preAgg && data.preAgg.usageKey;
    if (!key) {
      setUsedBy({ rows: [], total: 0, page: 1, loading: false });
      return;
    }
    setUsedBy((s) => ({ ...s, loading: true }));
    getJson(`playground/pre-agg-monitor/preagg-queries?key=${encodeURIComponent(key)}&${rangeParams(range)}&limit=${USEDBY_PAGE}&offset=${(page - 1) * USEDBY_PAGE}`)
      .then((r) => setUsedBy({ rows: r.rows || [], total: r.total || 0, page, loading: false }))
      .catch(() => setUsedBy((s) => ({ ...s, loading: false })));
  };

  const loadBuilds = (page: number) => {
    const name = data && data.preAgg && data.preAgg.name;
    if (!name) {
      setBuilds({ rows: [], total: 0, page: 1, loading: false });
      return;
    }
    setBuilds((s) => ({ ...s, loading: true }));
    getJson(`playground/pre-agg-monitor/build-history?preAgg=${encodeURIComponent(name)}&${rangeParams(range)}&limit=${USEDBY_PAGE}&offset=${(page - 1) * USEDBY_PAGE}`)
      .then((r) => setBuilds({ rows: r.rows || [], total: r.total || 0, page, loading: false }))
      .catch(() => setBuilds((s) => ({ ...s, loading: false })));
  };

  const partStatusTag = (s: string) => {
    if (s === 'ready') return <Tag color="green">ready</Tag>;
    if (s === 'building') return <Tag color="processing">building</Tag>;
    return <Tag color="default">not built</Tag>;
  };

  const partitionColumns = [
    { title: 'Status', dataIndex: 'status', key: 'status', width: 110, render: (s: string) => partStatusTag(s) },
    { title: 'Partition table', dataIndex: 'tableName', key: 'tableName', ellipsis: true },
    { title: 'Range start', dataIndex: 'buildRangeStart', key: 'buildRangeStart', width: 200, render: (v: string) => v || '—' },
    { title: 'Range end', dataIndex: 'buildRangeEnd', key: 'buildRangeEnd', width: 200, render: (v: string) => v || '—' },
    { title: 'Last built', dataIndex: 'lastBuilt', key: 'lastBuilt', width: 180, render: fmtTs },
    { title: 'Versions', dataIndex: 'versionCount', key: 'versionCount', width: 90, render: (v: number) => v || '—' },
    { title: 'TZ', dataIndex: 'timezone', key: 'timezone', width: 80 },
  ];

  const p = data ? data.preAgg : null;

  const queryColumns = [
    { title: 'Time', dataIndex: 'ts', key: 'ts', render: fmtTs, width: 180 },
    { title: 'API', dataIndex: 'api_type', key: 'api_type', width: 70 },
    { title: 'Duration', dataIndex: 'duration_ms', key: 'duration_ms', render: fmtMs, width: 110, sorter: (a: any, b: any) => (a.duration_ms || 0) - (b.duration_ms || 0) },
    { title: 'Query', dataIndex: 'query', key: 'query', render: (q: any) => <QueryChips query={q} /> },
  ];

  const buildColumns = [
    { title: 'Time', dataIndex: 'ts', key: 'ts', render: fmtTs, width: 180 },
    { title: 'Target table', dataIndex: 'target_table', key: 'target_table' },
    { title: 'Range end', dataIndex: 'build_range_end', key: 'build_range_end' },
    { title: 'Build time', dataIndex: 'duration_ms', key: 'duration_ms', render: fmtMs, width: 120, sorter: (a: any, b: any) => (a.duration_ms || 0) - (b.duration_ms || 0) },
  ];

  const fieldColumns = [
    { title: 'Member', dataIndex: 'member', key: 'member' },
    { title: 'Kind', dataIndex: 'kind', key: 'kind', width: 130, render: (k: string) => <Tag>{k}</Tag> },
    {
      title: 'Uses',
      dataIndex: 'uses',
      key: 'uses',
      width: 140,
      defaultSortOrder: 'ascend' as const,
      sorter: (a: any, b: any) => a.uses - b.uses,
      render: (v: number) => (v > 0 ? v : <Tag color="red">never used</Tag>),
    },
  ];

  return (
    <div style={{ padding: '16px 24px' }}>
      <PageHeader
        onBack={() => history.push('/pre-agg-monitor')}
        title={p ? p.cube : 'Pre-Aggregation'}
        subTitle={p ? p.name : id}
        tags={p ? (preAggStatusTag(p) ?? undefined) : undefined}
        extra={[
          <PercentilePicker key="pct" value={latencyPct} onChange={setLatencyPct} />,
          <TimeWindow key="tw" value={range} onChange={setRange} />,
        ]}
      />

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : !p ? (
        <Empty description="Pre-aggregation not found in the data model." />
      ) : (
        <>
          <Row gutter={16} style={{ marginBottom: 24 }}>
            <Col span={6}><Card><Statistic title="Hits" value={p.hits} /></Card></Col>
            <Col span={6}><Card><Statistic title={`${pctLabel(latencyPct)} latency`} value={(p.p_ms ?? 0) / 1000} precision={2} suffix="s" /></Card></Col>
            <Col span={6}><Card><Statistic title="Builds" value={p.build_count} /></Card></Col>
            <Col span={6}><Card><Statistic title="Avg build" value={(p.avg_build_ms ?? 0) / 1000} precision={2} suffix="s" /></Card></Col>
          </Row>

          <Tabs
            defaultActiveKey="overview"
            onChange={(k) => {
              setActiveTab(k);
              if (k === 'partitions') loadPartitions();
            }}
          >
            <TabPane tab="Overview" key="overview">
              <Descriptions bordered size="small" column={2}>
                <Descriptions.Item label="Id">{p.id}</Descriptions.Item>
                <Descriptions.Item label="Type">{p.type}</Descriptions.Item>
                <Descriptions.Item label="Granularity">{p.granularity || '—'}</Descriptions.Item>
                <Descriptions.Item label="External (Cube Store)">{String(p.external)}</Descriptions.Item>
                <Descriptions.Item label="Scheduled refresh">{String(p.scheduledRefresh)}</Descriptions.Item>
                <Descriptions.Item label="Matched usage key">{p.usageKey || '—'}</Descriptions.Item>
                <Descriptions.Item label="Last used">{fmtTs(p.last_used)}</Descriptions.Item>
                <Descriptions.Item label="Last build">{fmtTs(p.last_build)}</Descriptions.Item>
              </Descriptions>
            </TabPane>

            <TabPane tab="Definition" key="definition">
              <CodeBlock code={JSON.stringify(p.definition, null, 2)} language="json" />
            </TabPane>

            <TabPane tab="Indexes" key="indexes">
              {p.indexes && Object.keys(p.indexes).length ? (
                <CodeBlock code={JSON.stringify(p.indexes, null, 2)} language="json" />
              ) : (
                <Empty description="No indexes defined." />
              )}
            </TabPane>

            <TabPane tab={`Fields (${(data.fields || []).length})`} key="fields">
              <p style={{ color: '#888' }}>
                Members this pre-aggregation materializes, annotated with how often each is queried.
                <b> never-used</b> fields are dead weight — dropping them shrinks build time and storage.
              </p>
              <Table
                rowKey={(r: any) => `${r.kind}:${r.member}`}
                dataSource={data.fields || []}
                columns={fieldColumns}
                size="small"
                pagination={false}
              />
            </TabPane>

            <TabPane tab={`Used By (${p.hits ?? 0})`} key="used-by">
              <Table
                rowKey={(r: any) => r.id}
                dataSource={usedBy.rows}
                columns={queryColumns}
                size="small"
                loading={usedBy.loading}
                pagination={{
                  current: usedBy.page,
                  pageSize: USEDBY_PAGE,
                  total: usedBy.total || p.hits || 0,
                  showSizeChanger: false,
                  onChange: (pg: number) => loadUsedBy(pg),
                }}
                onRow={(record) => ({ onClick: () => history.push(`/query-history/${record.id}`), style: { cursor: 'pointer' } })}
              />
            </TabPane>

            <TabPane tab="Partitions" key="partitions">
              {partsLoading ? (
                <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
              ) : !parts || !parts.found ? (
                <Empty description="Partition info unavailable." />
              ) : (
                <>
                  <div style={{ marginBottom: 12 }}>
                    <Tag color="blue">{parts.total || 0} partitions</Tag>
                    <Tag color="green">{parts.ready || 0} ready</Tag>
                    {parts.building ? <Tag color="processing">{parts.building} building</Tag> : null}
                    {parts.partitionGranularity ? (
                      <span style={{ color: '#888', marginLeft: 8 }}>partitioned by <b>{parts.partitionGranularity}</b></span>
                    ) : (
                      <span style={{ color: '#888', marginLeft: 8 }}>single (non-partitioned) rollup</span>
                    )}
                  </div>
                  <Table
                    rowKey={(r: any) => r.tableName}
                    dataSource={parts.partitions || []}
                    columns={partitionColumns}
                    size="small"
                    pagination={{ defaultPageSize: 25, showSizeChanger: true, pageSizeOptions: ["10","25","50","100"] }}
                    expandable={{
                      expandedRowRender: (r: any) => (
                        <Descriptions size="small" column={2} bordered>
                          <Descriptions.Item label="Table">{r.tableName}</Descriptions.Item>
                          <Descriptions.Item label="Type">{r.type}</Descriptions.Item>
                          <Descriptions.Item label="Data source">{r.dataSource || '—'}</Descriptions.Item>
                          <Descriptions.Item label="Built">{String(r.built)}</Descriptions.Item>
                          <Descriptions.Item label="Content version">{r.contentVersion || '—'}</Descriptions.Item>
                          <Descriptions.Item label="Structure version">{r.structureVersion || '—'}</Descriptions.Item>
                        </Descriptions>
                      ),
                    }}
                  />
                </>
              )}
            </TabPane>

            <TabPane tab={`Build History (${p.build_count ?? 0})`} key="builds">
              <Table
                rowKey={(r: any) => r.id}
                dataSource={builds.rows}
                columns={buildColumns}
                size="small"
                loading={builds.loading}
                pagination={{
                  current: builds.page,
                  pageSize: USEDBY_PAGE,
                  total: builds.total || p.build_count || 0,
                  showSizeChanger: false,
                  onChange: (pg: number) => loadBuilds(pg),
                }}
                onRow={(record) => ({ onClick: () => history.push(`/builds/${record.id}`), style: { cursor: 'pointer' } })}
              />
            </TabPane>
          </Tabs>
        </>
      )}
    </div>
  );
}
