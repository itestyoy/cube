import { useEffect, useState } from 'react';
import { Link, useHistory, useParams } from 'react-router-dom';
import { Card, Col, Descriptions, Empty, PageHeader, Row, Spin, Statistic, Tag } from 'antd';

import { fmtTs, getJson } from '../monitoring/common';

export function BuildDetailPage() {
  const { id } = useParams<{ id: string }>();
  const history = useHistory();
  const [loading, setLoading] = useState(true);
  const [row, setRow] = useState<any | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    getJson(`playground/pre-agg-monitor/build?id=${encodeURIComponent(id)}`)
      .then((r) => {
        if (active) setRow(r.row || null);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [id]);

  return (
    <div style={{ padding: '16px 24px' }}>
      <PageHeader
        onBack={() => history.goBack()}
        title="Build"
        subTitle={row ? `${row.pre_aggregation || row.target_table} #${row.id}` : id}
      />

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : !row ? (
        <Empty description="Build not found (telemetry may be disabled or the row has been purged by retention)." />
      ) : (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={6}>
              <Card>
                <Statistic
                  title="Status"
                  value={row.status}
                  valueStyle={{ color: row.status === 'completed' ? '#3f8600' : '#cf1322' }}
                />
              </Card>
            </Col>
            <Col span={6}><Card><Statistic title="Duration" value={row.duration_ms ?? 0} suffix="ms" /></Card></Col>
            <Col span={6}>
              <Card>
                <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: 14 }}>Build started at</div>
                <div style={{ fontSize: 18 }}>{fmtTs(row.ts)}</div>
              </Card>
            </Col>
            <Col span={6}>
              <Card>
                <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: 14 }}>Triggered</div>
                <div style={{ fontSize: 18 }}>Refresh Worker</div>
              </Card>
            </Col>
          </Row>

          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="Pre-aggregation">
              {row.pre_aggregation ? (
                <Link to={`/pre-agg-monitor/${encodeURIComponent(row.pre_aggregation)}`}>{row.pre_aggregation}</Link>
              ) : (
                '—'
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Table name">
              <code>{row.target_table || '—'}</code>
            </Descriptions.Item>
            <Descriptions.Item label="Build range end">{row.build_range_end || '—'}</Descriptions.Item>
            <Descriptions.Item label="Request id">{row.request_id || '—'}</Descriptions.Item>
            <Descriptions.Item label="Status" span={2}>
              <Tag color={row.status === 'completed' ? 'green' : 'red'}>{row.status}</Tag>
            </Descriptions.Item>
          </Descriptions>
        </>
      )}
    </div>
  );
}
