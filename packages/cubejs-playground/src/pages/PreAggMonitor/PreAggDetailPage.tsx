import { useEffect, useState } from 'react';
import { useHistory, useParams } from 'react-router-dom';
import { Card, Col, Descriptions, Empty, PageHeader, Row, Spin, Statistic, Table, Tabs } from 'antd';

import { CodeBlock, fmtMs, fmtTs, getJson, preAggStatusTag } from '../monitoring/common';

const { TabPane } = Tabs;

export function PreAggDetailPage() {
  const { id } = useParams<{ id: string }>();
  const history = useHistory();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    getJson(`playground/pre-agg-monitor/preagg?id=${encodeURIComponent(id)}`)
      .then((r) => {
        if (active) setData(r && r.found ? r : null);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [id]);

  const p = data ? data.preAgg : null;

  const queryColumns = [
    { title: 'Time', dataIndex: 'ts', key: 'ts', render: fmtTs, width: 180 },
    { title: 'API', dataIndex: 'api_type', key: 'api_type', width: 70 },
    { title: 'Duration', dataIndex: 'duration_ms', key: 'duration_ms', render: fmtMs, width: 110, sorter: (a: any, b: any) => (a.duration_ms || 0) - (b.duration_ms || 0) },
    { title: 'Query', dataIndex: 'query', key: 'query', ellipsis: true, render: (q: any) => <code>{q ? JSON.stringify(q).slice(0, 100) : '—'}</code> },
  ];

  const buildColumns = [
    { title: 'Time', dataIndex: 'ts', key: 'ts', render: fmtTs, width: 180 },
    { title: 'Target table', dataIndex: 'target_table', key: 'target_table' },
    { title: 'Range end', dataIndex: 'build_range_end', key: 'build_range_end' },
    { title: 'Build time', dataIndex: 'duration_ms', key: 'duration_ms', render: fmtMs, width: 120, sorter: (a: any, b: any) => (a.duration_ms || 0) - (b.duration_ms || 0) },
  ];

  return (
    <div style={{ padding: '16px 24px' }}>
      <PageHeader
        onBack={() => history.push('/pre-agg-monitor')}
        title={p ? p.cube : 'Pre-Aggregation'}
        subTitle={p ? p.name : id}
        tags={p ? (preAggStatusTag(p) ?? undefined) : undefined}
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
            <Col span={6}><Card><Statistic title={`Hits (${data.windowHours}h)`} value={p.hits} /></Card></Col>
            <Col span={6}><Card><Statistic title="p50 latency" value={p.p50_ms ?? 0} suffix="ms" /></Card></Col>
            <Col span={6}><Card><Statistic title="Builds" value={p.build_count} /></Card></Col>
            <Col span={6}><Card><Statistic title="Avg build" value={p.avg_build_ms ?? 0} suffix="ms" /></Card></Col>
          </Row>

          <Tabs defaultActiveKey="overview">
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

            <TabPane tab={`Used By (${data.queries.length})`} key="used-by">
              <Table
                rowKey={(r: any) => r.id}
                dataSource={data.queries}
                columns={queryColumns}
                size="small"
                pagination={{ defaultPageSize: 15, showSizeChanger: true, pageSizeOptions: ["10","15","25","50","100"] }}
                onRow={(record) => ({ onClick: () => history.push(`/query-history/${record.id}`), style: { cursor: 'pointer' } })}
              />
            </TabPane>

            <TabPane tab={`Build History (${data.builds.length})`} key="builds">
              <Table
                rowKey={(r: any) => r.id}
                dataSource={data.builds}
                columns={buildColumns}
                size="small"
                pagination={{ defaultPageSize: 15, showSizeChanger: true, pageSizeOptions: ["10","15","25","50","100"] }}
                onRow={(record) => ({ onClick: () => history.push(`/builds/${record.id}`), style: { cursor: 'pointer' } })}
              />
            </TabPane>
          </Tabs>
        </>
      )}
    </div>
  );
}
