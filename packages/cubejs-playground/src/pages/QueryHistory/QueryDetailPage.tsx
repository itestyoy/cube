import { useEffect, useState } from 'react';
import { Link, useHistory, useParams } from 'react-router-dom';
import { Descriptions, Empty, PageHeader, Spin, Tabs, Tag } from 'antd';

import { cacheTag, fmtMs, fmtTs, getJson } from '../monitoring/common';

const { TabPane } = Tabs;

export function QueryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const history = useHistory();
  const [loading, setLoading] = useState(true);
  const [row, setRow] = useState<any | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    getJson(`playground/pre-agg-monitor/query?id=${encodeURIComponent(id)}`)
      .then((r) => {
        if (active) setRow(r.row || null);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [id]);

  const usedKeys = row && row.used_pre_aggregations ? Object.keys(row.used_pre_aggregations) : [];

  return (
    <div style={{ padding: '16px 24px' }}>
      <PageHeader
        onBack={() => history.push('/query-history')}
        title="Request"
        subTitle={row ? row.request_id : id}
        tags={row ? (cacheTag(row) ?? undefined) : undefined}
      />

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : !row ? (
        <Empty description="Query not found (telemetry may be disabled or the row has been purged by retention)." />
      ) : (
        <>
            <Descriptions bordered size="small" column={4} style={{ marginBottom: 24 }}>
              <Descriptions.Item label="Duration">{fmtMs(row.duration_ms)}</Descriptions.Item>
              <Descriptions.Item label="Type">Query</Descriptions.Item>
              <Descriptions.Item label="Client">{(row.api_type || '—').toUpperCase()}</Descriptions.Item>
              <Descriptions.Item label="Cache">{cacheTag(row)}</Descriptions.Item>
              <Descriptions.Item label="Time">{fmtTs(row.ts)}</Descriptions.Item>
              <Descriptions.Item label="Status">{row.status}</Descriptions.Item>
              <Descriptions.Item label="DB type" span={2}>
                {row.db_type ? JSON.stringify(row.db_type) : '—'}
              </Descriptions.Item>
            </Descriptions>

            <Tabs defaultActiveKey="query">
              <TabPane tab="Query" key="query">
                <pre style={{ whiteSpace: 'pre-wrap' }}>
                  {row.query ? JSON.stringify(row.query, null, 2) : '—'}
                </pre>
              </TabPane>

              <TabPane tab="SQL" key="sql">
                {row.sql && (
                  <>
                    <p><b>Inbound SQL</b> (from the client):</p>
                    <pre style={{ whiteSpace: 'pre-wrap' }}>{row.sql}</pre>
                  </>
                )}
                {Array.isArray(row.generated_sql) && row.generated_sql.length > 0 && (
                  <>
                    <p><b>Generated SQL</b> (sent to the data source):</p>
                    {row.generated_sql.map((s: string, i: number) => (
                      <pre key={i} style={{ whiteSpace: 'pre-wrap' }}>{s}</pre>
                    ))}
                  </>
                )}
                {!row.sql && !(row.generated_sql && row.generated_sql.length) && <Empty description="No SQL captured" />}
              </TabPane>

              <TabPane tab="Pre-Aggregation" key="preaggs">
                {usedKeys.length ? (
                  <div>
                    <p>This request was accelerated by:</p>
                    {usedKeys.map((k) => (
                      <div key={k} style={{ marginBottom: 8 }}>
                        <Link to={`/pre-agg-monitor/${encodeURIComponent(k)}`}>{k}</Link>
                      </div>
                    ))}
                    <pre style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>
                      {JSON.stringify(row.used_pre_aggregations, null, 2)}
                    </pre>
                  </div>
                ) : (
                  <Empty description="Not accelerated — served from the data source." />
                )}
              </TabPane>

              {row.status === 'error' && (
                <TabPane tab={<span><Tag color="red">!</Tag>Error</span>} key="error">
                  <pre style={{ whiteSpace: 'pre-wrap', color: '#c0392b' }}>{row.error || '—'}</pre>
                </TabPane>
              )}

              <TabPane tab="Security Context" key="security">
                <pre style={{ whiteSpace: 'pre-wrap' }}>
                  {row.security_context ? JSON.stringify(row.security_context, null, 2) : '—'}
                </pre>
              </TabPane>
            </Tabs>
          </>
        )}
    </div>
  );
}
