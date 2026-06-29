/* eslint-disable no-console */
import crypto from 'crypto';
import type { Pool as PgPool, PoolClient } from 'pg';

/**
 * Normalize a Cube query into a stable "shape" capturing the FIELDS used —
 * measures, dimensions, time-dimension members + granularity, segments, and
 * filter members — but NOT operators or concrete values (filter values/operators,
 * dateRange, limit, order). The operator doesn't change whether a pre-aggregation
 * can serve the query, so two queries that filter the same field with different
 * operators/values share one fingerprint: fundamentally the same query.
 */
export function normalizeQueryShape(query: any): {
  measures: string[];
  dimensions: string[];
  timeDimensions: string[];
  segments: string[];
  filters: string[];
} | null {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    return null;
  }
  if (
    !query.measures && !query.dimensions && !query.timeDimensions &&
    !query.filters && !query.segments
  ) {
    // e.g. an inbound-SQL-only payload ({ sql: ... }) — no field shape.
    return null;
  }
  const filterMembers: string[] = [];
  const walk = (f: any) => {
    if (!f) return;
    if (Array.isArray(f)) { f.forEach(walk); return; }
    if (Array.isArray(f.and)) f.and.forEach(walk);
    if (Array.isArray(f.or)) f.or.forEach(walk);
    const member = f.member || f.dimension;
    if (member) filterMembers.push(String(member));
  };
  walk(query.filters || []);
  return {
    measures: [...(query.measures || [])].map(String).sort(),
    dimensions: [...(query.dimensions || [])].map(String).sort(),
    timeDimensions: (query.timeDimensions || [])
      .map((t: any) => `${t.dimension}:${t.granularity || ''}`)
      .sort(),
    segments: [...(query.segments || [])].map(String).sort(),
    filters: Array.from(new Set(filterMembers)).sort(),
  };
}

export function queryFingerprint(shape: any): string {
  return crypto.createHash('sha1').update(JSON.stringify(shape)).digest('hex').slice(0, 16);
}

/**
 * Postgres transport for the Cube logger.
 *
 * Captures a small, fixed set of structured logger events into a Postgres
 * database so the playground "Pre-Aggregations Monitor" page can render
 * historical data (query log / "Used By", pre-aggregation build history).
 *
 * Design notes:
 *  - Fully optional. Enabled only when CUBEJS_TELEMETRY_DB_URL (or the
 *    discrete CUBEJS_TELEMETRY_DB_* vars) is set. When disabled the transport
 *    is never installed into the logger chain (see server.ts), so there is
 *    zero overhead on the query path.
 *  - Never throws into the logger. All DB work is buffered and flushed
 *    asynchronously; failures are logged once and the buffer is dropped.
 *  - Shared across all Cube processes (api replicas + refresh worker), which
 *    is why a real Postgres is used rather than an in-process SQLite file.
 */

export type TelemetryEvent = { msg: string; params: Record<string, any> };

/** Relative window (last N hours, fractional ok) or an absolute [from, to). */
export type TimeRange = { windowHours?: number; from?: string; to?: string };

export type QueryHistoryFilters = {
  limit?: number;
  offset?: number;
  order?: 'recent' | 'top';
  status?: 'success' | 'error';
  cache?: 'preagg' | 'raw';
  apiType?: string;
  minDurationMs?: number;
  windowHours?: number;
  from?: string;
  to?: string;
};

type QueryLogRow = {
  ts: Date;
  requestId: string | null;
  apiType: string | null;
  durationMs: number | null;
  queries: number | null;
  queriesWithPreAggregations: number | null;
  usedPreAggregations: any;
  dbType: any;
  isPlayground: boolean;
  query: any;
  status: string;
  error: string | null;
  external: boolean | null;
  securityContext: any;
  sql: string | null;
  generatedSql: any;
  queryHash: string | null;
  queryShape: any;
};

type BuildLogRow = {
  ts: Date;
  requestId: string | null;
  targetTable: string | null;
  preAggregation: string | null;
  buildRangeEnd: string | null;
  durationMs: number | null;
  status: string;
};

// Time-based flush: drain whatever has accumulated at most this often.
const FLUSH_INTERVAL_MS = 2000;
// Size-based flush: as soon as this many rows pile up, flush immediately
// (on the next tick) instead of waiting for the timer. Keeps each INSERT a
// bounded, efficient multi-row batch under bursty load.
const MAX_BATCH = 250;
// Hard ceiling on how many rows we hold in memory if Postgres is slow/down.
// Beyond this the oldest rows are dropped so telemetry never grows unbounded
// or back-pressures the query path.
const MAX_BUFFER = 10000;

export class PostgresLogTransport {
  private pool: PgPool | null = null;

  private ready: Promise<void> | null = null;

  private queryBuffer: QueryLogRow[] = [];

  private buildBuffer: BuildLogRow[] = [];

  // Pending pre-aggregation builds keyed by requestId, used to attach a
  // duration once the matching "Performing query completed" event arrives.
  private pendingBuilds = new Map<string, { ts: Date; targetTable: string | null; preAggregation: string | null; buildRangeEnd: string | null }>();

  private flushTimer: NodeJS.Timeout | null = null;

  // Ensures only one flush runs at a time so a slow Postgres can't cause
  // overlapping inserts / a pile-up of pooled connections.
  private flushing = false;

  private disabled = false;

  private warnedOnce = false;

  private retentionTimer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly connectionString: string,
    private readonly schema: string = 'telemetry',
    // Rows older than this many days are purged. <= 0 disables retention.
    private readonly retentionDays: number = 3,
  ) {}

  /**
   * Lazily create the pg pool and ensure the schema/tables exist.
   */
  private async init(): Promise<void> {
    if (this.ready) {
      return this.ready;
    }
    this.ready = (async () => {
      // Require lazily so environments without the `pg` module (it is a
      // dependency of cubejs-server-core) still start.
      // eslint-disable-next-line global-require
      const { Pool } = require('pg');
      const pool: PgPool = new Pool({
        connectionString: this.connectionString,
        max: 4,
        // Keep the monitoring DB from ever stalling Cube startup.
        connectionTimeoutMillis: 5000,
      });
      this.pool = pool;
      const client: PoolClient = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${this.schema}.query_log (
            id                            BIGSERIAL PRIMARY KEY,
            ts                            TIMESTAMPTZ NOT NULL DEFAULT now(),
            request_id                    TEXT,
            api_type                      TEXT,
            duration_ms                   INTEGER,
            queries                       INTEGER,
            queries_with_pre_aggregations INTEGER,
            used_pre_aggregations         JSONB,
            db_type                       JSONB,
            is_playground                 BOOLEAN,
            query                         JSONB,
            status                        TEXT NOT NULL DEFAULT 'success',
            error                         TEXT,
            external                      BOOLEAN,
            security_context              JSONB,
            sql                           TEXT,
            generated_sql                 JSONB,
            query_hash                    TEXT,
            query_shape                   JSONB
          )
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${this.schema}.preagg_build_log (
            id              BIGSERIAL PRIMARY KEY,
            ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
            request_id      TEXT,
            target_table    TEXT,
            pre_aggregation TEXT,
            build_range_end TEXT,
            duration_ms     INTEGER,
            status          TEXT NOT NULL
          )
        `);
        // Idempotent migrations so a pre-existing table (created by an earlier
        // build) gains any columns added later. CREATE TABLE IF NOT EXISTS does
        // not alter existing tables, so without this newer columns would be
        // missing and inserts would fail.
        await client.query(`
          ALTER TABLE ${this.schema}.query_log
            ADD COLUMN IF NOT EXISTS request_id                    TEXT,
            ADD COLUMN IF NOT EXISTS api_type                      TEXT,
            ADD COLUMN IF NOT EXISTS duration_ms                   INTEGER,
            ADD COLUMN IF NOT EXISTS queries                       INTEGER,
            ADD COLUMN IF NOT EXISTS queries_with_pre_aggregations INTEGER,
            ADD COLUMN IF NOT EXISTS used_pre_aggregations         JSONB,
            ADD COLUMN IF NOT EXISTS db_type                       JSONB,
            ADD COLUMN IF NOT EXISTS is_playground                 BOOLEAN,
            ADD COLUMN IF NOT EXISTS query                         JSONB,
            ADD COLUMN IF NOT EXISTS status                        TEXT NOT NULL DEFAULT 'success',
            ADD COLUMN IF NOT EXISTS error                         TEXT,
            ADD COLUMN IF NOT EXISTS external                      BOOLEAN,
            ADD COLUMN IF NOT EXISTS security_context              JSONB,
            ADD COLUMN IF NOT EXISTS sql                           TEXT,
            ADD COLUMN IF NOT EXISTS generated_sql                 JSONB,
            ADD COLUMN IF NOT EXISTS query_hash                    TEXT,
            ADD COLUMN IF NOT EXISTS query_shape                   JSONB
        `);
        await client.query(`
          ALTER TABLE ${this.schema}.preagg_build_log
            ADD COLUMN IF NOT EXISTS request_id      TEXT,
            ADD COLUMN IF NOT EXISTS target_table    TEXT,
            ADD COLUMN IF NOT EXISTS pre_aggregation TEXT,
            ADD COLUMN IF NOT EXISTS build_range_end TEXT,
            ADD COLUMN IF NOT EXISTS duration_ms     INTEGER
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS query_log_ts_idx ON ${this.schema}.query_log (ts DESC)`);
        await client.query(`CREATE INDEX IF NOT EXISTS query_log_hash_idx ON ${this.schema}.query_log (query_hash)`);
        await client.query(`CREATE INDEX IF NOT EXISTS preagg_build_log_ts_idx ON ${this.schema}.preagg_build_log (ts DESC)`);
        await client.query(`CREATE INDEX IF NOT EXISTS preagg_build_log_table_idx ON ${this.schema}.preagg_build_log (target_table)`);
      } finally {
        client.release();
      }
      this.scheduleRetention();
    })().catch((e) => {
      this.disabled = true;
      console.error(`[telemetry] Postgres transport disabled: ${(e && e.message) || e}`);
    });
    return this.ready;
  }

  /**
   * Periodically purge rows older than the retention window. Runs once shortly
   * after init and then on a fixed interval. No-op when retention is disabled.
   */
  private scheduleRetention(): void {
    if (this.retentionTimer || !(this.retentionDays > 0)) {
      return;
    }
    const runCleanup = () => {
      this.cleanup().catch(() => {});
    };
    // Once on startup, then every 6 hours.
    setTimeout(runCleanup, 10000).unref?.();
    this.retentionTimer = setInterval(runCleanup, 6 * 60 * 60 * 1000);
    if (typeof this.retentionTimer.unref === 'function') {
      this.retentionTimer.unref();
    }
  }

  private async cleanup(): Promise<void> {
    if (this.disabled || !this.pool || !(this.retentionDays > 0)) {
      return;
    }
    const interval = `${this.retentionDays} days`;
    await this.pool.query(`DELETE FROM ${this.schema}.query_log WHERE ts < now() - $1::interval`, [interval]);
    await this.pool.query(`DELETE FROM ${this.schema}.preagg_build_log WHERE ts < now() - $1::interval`, [interval]);
  }

  /**
   * Logger entry point. Called for every event; cheap no-op for events we
   * don't care about. Never throws.
   */
  public record(msg: string, params: Record<string, any>): void {
    if (this.disabled) {
      return;
    }
    try {
      switch (msg) {
        case 'Load Request Success':
          // The SQL API emits this from the Rust layer with only the raw SQL
          // and no pre-aggregation info, and also for non-data statements
          // (SET SESSION, etc.). We capture the richer 'SQL API Load Success'
          // event instead, so skip the SQL variant here to avoid duplicates.
          if (params.apiType === 'sql') {
            return;
          }
          this.recordQuery(params);
          break;
        case 'SQL API Load Success':
          this.recordQuery(params);
          break;
        case 'Internal Server Error':
        case 'Orchestrator error':
        case 'User Error':
          this.recordQueryError(msg, params);
          break;
        case 'Executing Load Pre Aggregation SQL':
          this.recordBuildStart(params);
          break;
        case 'Performing query completed':
          this.recordBuildCompletion(params);
          break;
        default:
          return;
      }
      this.maybeFlush();
    } catch (e) {
      // Telemetry must never break the query path.
      if (!this.warnedOnce) {
        this.warnedOnce = true;
        console.error(`[telemetry] record() error (suppressed further): ${(e as Error).message}`);
      }
    }
  }

  private recordQuery(params: Record<string, any>): void {
    this.queryBuffer.push({
      ts: new Date(),
      requestId: params.requestId || null,
      apiType: params.apiType || null,
      durationMs: typeof params.duration === 'number' ? params.duration : null,
      queries: typeof params.queries === 'number' ? params.queries : null,
      queriesWithPreAggregations:
        typeof params.queriesWithPreAggregations === 'number' ? params.queriesWithPreAggregations : null,
      usedPreAggregations: params.usedPreAggregations ?? null,
      dbType: params.dbType ?? null,
      isPlayground: Boolean(params.isPlayground),
      query: params.query ?? null,
      status: 'success',
      error: null,
      external: typeof params.external === 'boolean' ? params.external : null,
      securityContext: params.securityContext ?? null,
      sql: typeof params.sql === 'string' ? params.sql : null,
      generatedSql: params.generatedSql ?? null,
      ...this.shapeOf(params.query),
    });
    this.cap(this.queryBuffer);
  }

  /**
   * Compute the field-level fingerprint of a query for grouping identical
   * query shapes (different filter values collapse to one). Returns nulls when
   * the payload has no field shape (e.g. inbound-SQL-only).
   */
  private shapeOf(query: any): { queryHash: string | null; queryShape: any } {
    try {
      const shape = normalizeQueryShape(query);
      return shape ? { queryHash: queryFingerprint(shape), queryShape: shape } : { queryHash: null, queryShape: null };
    } catch (e) {
      return { queryHash: null, queryShape: null };
    }
  }

  private recordQueryError(msg: string, params: Record<string, any>): void {
    this.queryBuffer.push({
      ts: new Date(),
      requestId: params.requestId || null,
      apiType: params.apiType || null,
      durationMs: typeof params.duration === 'number' ? params.duration : null,
      queries: null,
      queriesWithPreAggregations: null,
      usedPreAggregations: null,
      dbType: null,
      isPlayground: Boolean(params.isPlayground),
      query: params.query ?? null,
      status: 'error',
      error: typeof params.error === 'string' ? params.error : (params.error && String(params.error)) || msg,
      external: null,
      securityContext: params.securityContext ?? null,
      sql: typeof params.sql === 'string' ? params.sql : null,
      generatedSql: null,
      ...this.shapeOf(params.query),
    });
    this.cap(this.queryBuffer);
  }

  private recordBuildStart(params: Record<string, any>): void {
    const requestId = params.requestId || null;
    const entry = {
      ts: new Date(),
      targetTable: params.targetTableName || null,
      preAggregation:
        (params.preAggregation && (params.preAggregation.preAggregationId || params.preAggregation.tableName)) || null,
      buildRangeEnd: params.buildRangeEnd || null,
    };
    if (requestId) {
      // Bound the map so failed builds (which never emit a completion event)
      // can't leak memory.
      if (this.pendingBuilds.size > MAX_BUFFER) {
        const oldest = this.pendingBuilds.keys().next().value;
        if (oldest !== undefined) {
          this.pendingBuilds.delete(oldest);
        }
      }
      this.pendingBuilds.set(requestId, entry);
    }
    // Record the start immediately; duration is backfilled on completion.
    this.buildBuffer.push({
      ts: entry.ts,
      requestId,
      targetTable: entry.targetTable,
      preAggregation: entry.preAggregation,
      buildRangeEnd: entry.buildRangeEnd,
      durationMs: null,
      status: 'started',
    });
    this.cap(this.buildBuffer);
  }

  private recordBuildCompletion(params: Record<string, any>): void {
    const requestId = params.requestId || null;
    if (!requestId) {
      return;
    }
    const pending = this.pendingBuilds.get(requestId);
    if (!pending) {
      // Not a pre-aggregation build (regular query) — ignore.
      return;
    }
    this.pendingBuilds.delete(requestId);
    this.buildBuffer.push({
      ts: new Date(),
      requestId,
      targetTable: pending.targetTable,
      preAggregation: pending.preAggregation,
      buildRangeEnd: pending.buildRangeEnd,
      durationMs: typeof params.duration === 'number' ? params.duration : null,
      status: 'completed',
    });
    this.cap(this.buildBuffer);
  }

  private cap(buffer: unknown[]): void {
    if (buffer.length > MAX_BUFFER) {
      buffer.splice(0, buffer.length - MAX_BUFFER);
    }
  }

  private buffered(): number {
    return this.queryBuffer.length + this.buildBuffer.length;
  }

  /**
   * Decide how to flush after new rows were buffered: immediately (next tick)
   * once a batch-worth has accumulated, otherwise on the periodic timer. Only
   * called when something was actually buffered, so there are no empty flushes.
   */
  private maybeFlush(): void {
    if (this.buffered() >= MAX_BATCH) {
      this.clearTimer();
      // Defer to the next tick so a burst of synchronous log() calls coalesces
      // into a single INSERT rather than one INSERT per event.
      setImmediate(() => this.flush().catch(() => {}));
      return;
    }
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);
    // Don't keep the event loop alive solely for telemetry flushing.
    if (typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref();
    }
  }

  private clearTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private async flush(): Promise<void> {
    if (this.disabled) {
      this.queryBuffer = [];
      this.buildBuffer = [];
      return;
    }
    // Never run two flushes concurrently — if one is already in flight, the
    // remaining rows are picked up by its tail-reschedule below.
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      await this.flushOnce();
    } finally {
      this.flushing = false;
    }
    // If new rows arrived while we were inserting, schedule another pass.
    if (!this.disabled && this.buffered() > 0) {
      this.maybeFlush();
    }
  }

  private async flushOnce(): Promise<void> {
    await this.init();
    if (this.disabled || !this.pool) {
      return;
    }

    const queries = this.queryBuffer;
    const builds = this.buildBuffer;
    this.queryBuffer = [];
    this.buildBuffer = [];

    try {
      if (queries.length) {
        await this.insertQueries(queries);
      }
      if (builds.length) {
        await this.insertBuilds(builds);
      }
    } catch (e) {
      if (!this.warnedOnce) {
        this.warnedOnce = true;
        console.error(`[telemetry] flush error (suppressed further): ${(e as Error).message}`);
      }
    }
  }

  private async insertQueries(rows: QueryLogRow[]): Promise<void> {
    const cols = 18;
    const values: any[] = [];
    const tuples = rows.map((r, i) => {
      const base = i * cols;
      values.push(
        r.ts,
        r.requestId,
        r.apiType,
        r.durationMs,
        r.queries,
        r.queriesWithPreAggregations,
        r.usedPreAggregations === null ? null : JSON.stringify(r.usedPreAggregations),
        r.dbType === null ? null : JSON.stringify(r.dbType),
        r.isPlayground,
        r.query === null ? null : JSON.stringify(r.query),
        r.status,
        r.error,
        r.external,
        r.securityContext === null ? null : JSON.stringify(r.securityContext),
        r.sql,
        r.generatedSql === null ? null : JSON.stringify(r.generatedSql),
        r.queryHash,
        r.queryShape === null ? null : JSON.stringify(r.queryShape),
      );
      return `(${Array.from({ length: cols }, (_, k) => `$${base + k + 1}`).join(',')})`;
    });
    await this.pool!.query(
      `INSERT INTO ${this.schema}.query_log
        (ts, request_id, api_type, duration_ms, queries, queries_with_pre_aggregations, used_pre_aggregations, db_type, is_playground, query, status, error, external, security_context, sql, generated_sql, query_hash, query_shape)
       VALUES ${tuples.join(',')}`,
      values,
    );
  }

  private async insertBuilds(rows: BuildLogRow[]): Promise<void> {
    const cols = 7;
    const values: any[] = [];
    const tuples = rows.map((r, i) => {
      const base = i * cols;
      values.push(r.ts, r.requestId, r.targetTable, r.preAggregation, r.buildRangeEnd, r.durationMs, r.status);
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`;
    });
    await this.pool!.query(
      `INSERT INTO ${this.schema}.preagg_build_log
        (ts, request_id, target_table, pre_aggregation, build_range_end, duration_ms, status)
       VALUES ${tuples.join(',')}`,
      values,
    );
  }

  /**
   * Resolve a window (number of hours, or a TimeRange) to absolute ISO bounds.
   * Presets are converted to [now - hours, now); a custom range passes through.
   */
  private timeBounds(window: number | TimeRange = 24): { from: string; to: string } {
    if (typeof window === 'object' && window.from && window.to) {
      return { from: window.from, to: window.to };
    }
    const hours =
      typeof window === 'number'
        ? window
        : (window.windowHours && window.windowHours > 0 ? window.windowHours : 24);
    const to = new Date();
    const from = new Date(to.getTime() - hours * 3600 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }

  /**
   * Query helpers used by the playground monitoring endpoints.
   */
  public async getSummary(window: number | TimeRange = 24): Promise<any> {
    await this.init();
    if (this.disabled || !this.pool) {
      return null;
    }
    const { from, to } = this.timeBounds(window);
    const { rows } = await this.pool.query(
      `SELECT
         count(*)::int                                            AS total_queries,
         coalesce(sum(queries_with_pre_aggregations),0)::int      AS accelerated_queries,
         coalesce(percentile_disc(0.5) within group (order by duration_ms),0)::int  AS p50_ms,
         coalesce(percentile_disc(0.95) within group (order by duration_ms),0)::int AS p95_ms
       FROM ${this.schema}.query_log
       WHERE ts >= $1 AND ts < $2`,
      [from, to],
    );
    return rows[0];
  }

  /**
   * Time-bucketed series for charts: request volume (total/errors/accelerated)
   * and average duration over the window.
   */
  public async getTimeSeries(window: number | TimeRange = 24, percentile = 0.95): Promise<any[]> {
    await this.init();
    if (this.disabled || !this.pool) {
      return [];
    }
    const { from, to } = this.timeBounds(window);
    const p = Math.min(Math.max(percentile, 0), 0.999);
    const spanMin = (new Date(to).getTime() - new Date(from).getTime()) / 60000;
    const bucketMinutes = Math.max(1, Math.round(spanMin / 48));
    const { rows } = await this.pool.query(
      `SELECT to_timestamp(floor(extract(epoch from ts) / ($3 * 60)) * ($3 * 60)) AS bucket,
              count(*)::int                                                          AS total,
              sum(CASE WHEN status='error' THEN 1 ELSE 0 END)::int                   AS errors,
              sum(CASE WHEN coalesce(queries_with_pre_aggregations,0) > 0 THEN 1 ELSE 0 END)::int AS accelerated,
              sum(CASE WHEN coalesce(queries_with_pre_aggregations,0) = 0 THEN 1 ELSE 0 END)::int AS not_accelerated,
              coalesce(round(avg(duration_ms)),0)::int                               AS avg_ms,
              coalesce(round(avg(duration_ms) FILTER (WHERE coalesce(queries_with_pre_aggregations,0) > 0)),0)::int AS avg_ms_accelerated,
              coalesce(round(avg(duration_ms) FILTER (WHERE coalesce(queries_with_pre_aggregations,0) = 0)),0)::int AS avg_ms_not_accelerated,
              coalesce(percentile_disc($4) within group (order by duration_ms),0)::int AS p_ms
       FROM ${this.schema}.query_log
       WHERE ts >= $1 AND ts < $2
       GROUP BY bucket
       ORDER BY bucket`,
      [from, to, bucketMinutes, p],
    );
    return rows;
  }

  public async getQueryLog(limit = 200): Promise<any[]> {
    await this.init();
    if (this.disabled || !this.pool) {
      return [];
    }
    const { rows } = await this.pool.query(
      `SELECT id, ts, request_id, api_type, duration_ms, queries, queries_with_pre_aggregations,
              used_pre_aggregations, db_type, is_playground
       FROM ${this.schema}.query_log
       ORDER BY ts DESC
       LIMIT $1`,
      [Math.min(limit, 1000)],
    );
    return rows;
  }

  /** Build the shared WHERE clause + params (from,to first) for query history. */
  private buildQueryHistoryWhere(filters: QueryHistoryFilters): { where: string; params: any[] } {
    const where: string[] = [];
    const params: any[] = [];
    const add = (clause: string, value: any) => {
      params.push(value);
      where.push(clause.replace('$?', `$${params.length}`));
    };
    const { from, to } = this.timeBounds({ windowHours: filters.windowHours, from: filters.from, to: filters.to });
    params.push(from, to);
    where.push('ts >= $1 AND ts < $2');
    if (filters.status) add('status = $?', filters.status);
    if (filters.apiType) add('api_type = $?', filters.apiType);
    if (typeof filters.minDurationMs === 'number') add('duration_ms >= $?', filters.minDurationMs);
    if (filters.cache === 'preagg') where.push('coalesce(queries_with_pre_aggregations,0) > 0');
    else if (filters.cache === 'raw') where.push('coalesce(queries_with_pre_aggregations,0) = 0');
    return { where: where.join(' AND '), params };
  }

  public async getQueryHistory(filters: QueryHistoryFilters = {}): Promise<any[]> {
    await this.init();
    if (this.disabled || !this.pool) {
      return [];
    }
    const { where, params } = this.buildQueryHistoryWhere(filters);
    const orderBy = filters.order === 'top' ? 'duration_ms DESC NULLS LAST' : 'ts DESC';
    const limit = Math.min(filters.limit || 50, 200);
    const offset = Math.max(filters.offset || 0, 0);
    params.push(limit, offset);

    const { rows } = await this.pool.query(
      `SELECT id, ts, request_id, api_type, duration_ms, queries, queries_with_pre_aggregations,
              used_pre_aggregations, db_type, is_playground, status, error, external, security_context,
              query, sql, generated_sql
       FROM ${this.schema}.query_log
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows;
  }

  /** Total rows matching the query-history filters (for pagination). */
  public async countQueryHistory(filters: QueryHistoryFilters = {}): Promise<number> {
    await this.init();
    if (this.disabled || !this.pool) {
      return 0;
    }
    const { where, params } = this.buildQueryHistoryWhere(filters);
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM ${this.schema}.query_log WHERE ${where}`,
      params,
    );
    return rows[0] ? rows[0].n : 0;
  }

  public async getBuildHistory(window: number | TimeRange = 24, limit = 500): Promise<any[]> {
    await this.init();
    if (this.disabled || !this.pool) {
      return [];
    }
    const { from, to } = this.timeBounds(window);
    const { rows } = await this.pool.query(
      `SELECT id, ts, request_id, target_table, pre_aggregation, build_range_end, duration_ms, status
       FROM ${this.schema}.preagg_build_log
       WHERE ts >= $1 AND ts < $2 AND status = 'completed'
       ORDER BY ts DESC
       LIMIT $3`,
      [from, to, Math.min(limit, 2000)],
    );
    return rows;
  }

  public async getUsedBy(limit = 1000): Promise<any[]> {
    await this.init();
    if (this.disabled || !this.pool) {
      return [];
    }
    // Flatten used_pre_aggregations object keys into per-pre-agg usage stats.
    const { rows } = await this.pool.query(
      `SELECT pre_agg AS pre_aggregation,
              count(*)::int AS query_count,
              coalesce(percentile_disc(0.5) within group (order by duration_ms),0)::int AS p50_ms,
              max(ts) AS last_used
       FROM (
         SELECT ts, duration_ms, jsonb_object_keys(coalesce(used_pre_aggregations,'{}'::jsonb)) AS pre_agg
         FROM ${this.schema}.query_log
         WHERE used_pre_aggregations IS NOT NULL
         ORDER BY ts DESC
         LIMIT $1
       ) t
       GROUP BY pre_agg
       ORDER BY query_count DESC`,
      [Math.min(limit, 5000)],
    );
    return rows;
  }

  /**
   * Per-pre-aggregation query usage within a time window, keyed by the
   * pre-aggregation key as it appears in usedPreAggregations. Used to join
   * against the defined pre-aggregation catalog (so unused ones show 0 hits).
   */
  public async getPreAggUsage(window: number | TimeRange = 24, percentile = 0.95): Promise<any[]> {
    await this.init();
    if (this.disabled || !this.pool) {
      return [];
    }
    const { from, to } = this.timeBounds(window);
    const p = Math.min(Math.max(percentile, 0), 0.999);
    const { rows } = await this.pool.query(
      `SELECT pre_agg AS pre_aggregation,
              count(*)::int AS query_count,
              coalesce(percentile_disc($3) within group (order by duration_ms),0)::int AS p_ms,
              max(ts) AS last_used
       FROM (
         SELECT ts, duration_ms, jsonb_object_keys(coalesce(used_pre_aggregations,'{}'::jsonb)) AS pre_agg
         FROM ${this.schema}.query_log
         WHERE used_pre_aggregations IS NOT NULL
           AND ts >= $1 AND ts < $2
       ) t
       GROUP BY pre_agg
       ORDER BY query_count DESC`,
      [from, to, p],
    );
    return rows;
  }

  /**
   * Per-pre-aggregation build statistics within a time window.
   */
  public async getPreAggBuildStats(window: number | TimeRange = 24): Promise<any[]> {
    await this.init();
    if (this.disabled || !this.pool) {
      return [];
    }
    const { from, to } = this.timeBounds(window);
    const { rows } = await this.pool.query(
      `SELECT pre_aggregation,
              count(*)::int AS build_count,
              coalesce(avg(duration_ms),0)::int AS avg_ms,
              coalesce(max(duration_ms),0)::int AS max_ms,
              max(ts) AS last_build
       FROM ${this.schema}.preagg_build_log
       WHERE status = 'completed'
         AND pre_aggregation IS NOT NULL
         AND ts >= $1 AND ts < $2
       GROUP BY pre_aggregation`,
      [from, to],
    );
    return rows;
  }

  /**
   * A single query log row by id (for the Query History detail view).
   */
  public async getQueryById(id: number): Promise<any | null> {
    await this.init();
    if (this.disabled || !this.pool) {
      return null;
    }
    const { rows } = await this.pool.query(
      `SELECT id, ts, request_id, api_type, duration_ms, queries, queries_with_pre_aggregations,
              used_pre_aggregations, db_type, is_playground, status, error, external, security_context,
              query, sql, generated_sql
       FROM ${this.schema}.query_log
       WHERE id = $1`,
      [id],
    );
    return rows[0] || null;
  }

  /**
   * A single pre-aggregation build log row by id (for the Build detail view).
   */
  public async getBuildById(id: number): Promise<any | null> {
    await this.init();
    if (this.disabled || !this.pool) {
      return null;
    }
    const { rows } = await this.pool.query(
      `SELECT id, ts, request_id, target_table, pre_aggregation, build_range_end, duration_ms, status
       FROM ${this.schema}.preagg_build_log
       WHERE id = $1`,
      [id],
    );
    return rows[0] || null;
  }

  /**
   * Recent queries that were accelerated by a specific pre-aggregation
   * (matched on the exact key stored in usedPreAggregations).
   */
  public async getQueriesForPreAgg(key: string, window: number | TimeRange = 24, limit = 100, offset = 0): Promise<any[]> {
    await this.init();
    if (this.disabled || !this.pool) {
      return [];
    }
    const { from, to } = this.timeBounds(window);
    const { rows } = await this.pool.query(
      `SELECT id, ts, request_id, api_type, duration_ms, query, sql, generated_sql, external
       FROM ${this.schema}.query_log
       WHERE used_pre_aggregations ? $3
         AND ts >= $1 AND ts < $2
       ORDER BY ts DESC
       LIMIT $4 OFFSET $5`,
      [from, to, key, Math.min(limit, 200), Math.max(offset, 0)],
    );
    return rows;
  }

  /** Total queries this pre-aggregation served in the window (for pagination). */
  public async countQueriesForPreAgg(key: string, window: number | TimeRange = 24): Promise<number> {
    await this.init();
    if (this.disabled || !this.pool) {
      return 0;
    }
    const { from, to } = this.timeBounds(window);
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n
       FROM ${this.schema}.query_log
       WHERE used_pre_aggregations ? $3 AND ts >= $1 AND ts < $2`,
      [from, to, key],
    );
    return rows[0] ? rows[0].n : 0;
  }

  /**
   * Per-member usage across ALL queries this pre-aggregation served in the
   * window (not the truncated "Used By" sample), so the per-field "never used"
   * annotation is accurate. Counts distinct queries that referenced each
   * member (measure / dimension / segment / time-dimension). Returns raw
   * (possibly view) member names — the caller canonicalizes to cube members.
   */
  public async getMemberUsageForPreAgg(key: string, window: number | TimeRange = 24): Promise<Record<string, number>> {
    await this.init();
    if (this.disabled || !this.pool) {
      return {};
    }
    const { from, to } = this.timeBounds(window);
    const { rows } = await this.pool.query(
      `WITH served AS (
         SELECT id, query
         FROM ${this.schema}.query_log
         WHERE used_pre_aggregations ? $3
           AND ts >= $1 AND ts < $2
           AND jsonb_typeof(query) = 'object'
       ),
       members AS (
         SELECT id, jsonb_array_elements_text(query->'measures')   AS member FROM served WHERE jsonb_typeof(query->'measures')   = 'array'
         UNION ALL
         SELECT id, jsonb_array_elements_text(query->'dimensions') AS member FROM served WHERE jsonb_typeof(query->'dimensions') = 'array'
         UNION ALL
         SELECT id, jsonb_array_elements_text(query->'segments')   AS member FROM served WHERE jsonb_typeof(query->'segments')   = 'array'
         UNION ALL
         SELECT s.id, (td->>'dimension') AS member
         FROM served s, jsonb_array_elements(s.query->'timeDimensions') td
         WHERE jsonb_typeof(s.query->'timeDimensions') = 'array'
       )
       SELECT member, count(DISTINCT id)::int AS uses
       FROM members
       WHERE member IS NOT NULL
       GROUP BY member`,
      [from, to, key],
    );
    const map: Record<string, number> = {};
    rows.forEach((r: any) => { map[r.member] = r.uses; });
    return map;
  }

  // ----- Analytics (Insights) -------------------------------------------

  /**
   * Queries grouped by field-level fingerprint: how heavy each distinct query
   * shape is. orderBy 'total' (sum duration — biggest cost) or 'count'.
   */
  public async getTopQueries(window: number | TimeRange = 24, orderBy: 'total' | 'count' = 'total', limit = 100, percentile = 0.95): Promise<any[]> {
    await this.init();
    if (this.disabled || !this.pool) {
      return [];
    }
    const { from, to } = this.timeBounds(window);
    const p = Math.min(Math.max(percentile, 0), 0.999);
    const order = orderBy === 'count' ? 'executions DESC' : 'total_ms DESC';
    const { rows } = await this.pool.query(
      `SELECT query_hash,
              count(*)::int                                                              AS executions,
              coalesce(round(avg(duration_ms)),0)::int                                   AS avg_ms,
              coalesce(percentile_disc($4) within group (order by duration_ms),0)::int   AS p_ms,
              coalesce(sum(duration_ms),0)::bigint                                        AS total_ms,
              round(100.0 * sum(CASE WHEN coalesce(queries_with_pre_aggregations,0) > 0 THEN 1 ELSE 0 END) / count(*))::int AS hit_rate,
              sum(CASE WHEN status='error' THEN 1 ELSE 0 END)::int                        AS errors,
              max(ts)                                                                     AS last_seen,
              (array_agg(query_shape ORDER BY ts DESC))[1]                                AS shape,
              (array_agg(query ORDER BY ts DESC))[1]                                      AS sample_query
       FROM ${this.schema}.query_log
       WHERE query_hash IS NOT NULL
         AND ts >= $1 AND ts < $2
       GROUP BY query_hash
       ORDER BY ${order}
       LIMIT $3`,
      [from, to, Math.min(limit, 500), p],
    );
    return rows;
  }

  /**
   * Pre-aggregation recommendations: frequent/expensive query shapes that were
   * NOT accelerated — candidates that would benefit from a pre-aggregation.
   * Ranked by total time spent on the data source.
   */
  /**
   * Pre-aggregation candidates: unaccelerated query shapes whose average
   * duration is at/above a workload-relative quantile (e.g. p90 of all query
   * durations in the window) — adaptive instead of a fixed millisecond cutoff.
   * Returns the resolved threshold (ms) alongside the rows.
   */
  public async getRecommendations(
    window: number | TimeRange = 24,
    percentile = 0.9,
    limit = 100,
  ): Promise<{ thresholdMs: number; percentile: number; rows: any[] }> {
    await this.init();
    if (this.disabled || !this.pool) {
      return { thresholdMs: 0, percentile, rows: [] };
    }
    const { from, to } = this.timeBounds(window);
    const p = Math.min(Math.max(percentile, 0), 0.999);
    const { rows } = await this.pool.query(
      `WITH thresh AS (
         SELECT coalesce(percentile_disc($3) within group (order by duration_ms), 0) AS v
         FROM ${this.schema}.query_log
         WHERE ts >= $1 AND ts < $2 AND status = 'success'
       )
       SELECT query_hash,
              count(*)::int                            AS executions,
              coalesce(round(avg(duration_ms)),0)::int AS avg_ms,
              coalesce(sum(duration_ms),0)::bigint      AS total_ms,
              coalesce(percentile_disc(0.95) within group (order by duration_ms),0)::int AS p95_ms,
              max(ts)                                   AS last_seen,
              (SELECT v FROM thresh)::int               AS threshold_ms,
              (array_agg(query_shape ORDER BY ts DESC))[1] AS shape,
              (array_agg(query ORDER BY ts DESC))[1]       AS sample_query
       FROM ${this.schema}.query_log
       WHERE query_hash IS NOT NULL
         AND status = 'success'
         AND coalesce(queries_with_pre_aggregations,0) = 0
         AND ts >= $1 AND ts < $2
       GROUP BY query_hash
       HAVING avg(duration_ms) >= (SELECT v FROM thresh)
       ORDER BY total_ms DESC
       LIMIT $4`,
      [from, to, p, Math.min(limit, 500)],
    );
    return { thresholdMs: rows[0] ? rows[0].threshold_ms : 0, percentile: p, rows };
  }

  /**
   * Errors grouped by message: what is failing and how often.
   */
  public async getErrorStats(window: number | TimeRange = 24, limit = 100): Promise<any[]> {
    await this.init();
    if (this.disabled || !this.pool) {
      return [];
    }
    const { from, to } = this.timeBounds(window);
    const { rows } = await this.pool.query(
      `SELECT error,
              count(*)::int AS count,
              max(ts)       AS last_seen,
              (array_agg(api_type ORDER BY ts DESC))[1] AS api_type,
              (array_agg(id ORDER BY ts DESC))[1]       AS sample_id,
              (array_agg(query ORDER BY ts DESC))[1]    AS sample_query
       FROM ${this.schema}.query_log
       WHERE status = 'error' AND error IS NOT NULL
         AND ts >= $1 AND ts < $2
       GROUP BY error
       ORDER BY count DESC
       LIMIT $3`,
      [from, to, Math.min(limit, 500)],
    );
    return rows;
  }

  /**
   * Per-member usage across queries: how often each measure / dimension is
   * actually queried. Members never appearing are dead model parts.
   */
  public async getModelUsage(window: number | TimeRange = 24): Promise<{ measures: any[]; dimensions: any[] }> {
    await this.init();
    if (this.disabled || !this.pool) {
      return { measures: [], dimensions: [] };
    }
    const { from, to } = this.timeBounds(window);
    const memberUsage = async (field: 'measures' | 'dimensions') => {
      const { rows } = await this.pool!.query(
        `SELECT m.member, count(*)::int AS uses, max(q.ts) AS last_used
         FROM ${this.schema}.query_log q
         CROSS JOIN LATERAL jsonb_array_elements_text(q.query->'${field}') AS m(member)
         WHERE jsonb_typeof(q.query->'${field}') = 'array'
           AND q.ts >= $1 AND q.ts < $2
         GROUP BY m.member
         ORDER BY uses DESC`,
        [from, to],
      );
      return rows;
    };
    const [measures, dimensions] = await Promise.all([memberUsage('measures'), memberUsage('dimensions')]);
    return { measures, dimensions };
  }

  /**
   * Aggregate usage count per member (measure or dimension) as a flat map,
   * used to flag unused fields inside a pre-aggregation's definition.
   */
  public async getMemberUsageMap(window: number | TimeRange = 24): Promise<Record<string, number>> {
    const { measures, dimensions } = await this.getModelUsage(window);
    const map: Record<string, number> = {};
    [...measures, ...dimensions].forEach((r: any) => {
      map[r.member] = (map[r.member] || 0) + r.uses;
    });
    return map;
  }

  /**
   * Member sets of recent queries (measures + dimensions + time-dimension
   * members + segments per query), used to compute member co-occurrence.
   */
  public async getRecentQueryMembers(window: number | TimeRange = 24, limit = 3000): Promise<string[][]> {
    await this.init();
    if (this.disabled || !this.pool) {
      return [];
    }
    const { from, to } = this.timeBounds(window);
    const { rows } = await this.pool.query(
      `SELECT query FROM ${this.schema}.query_log
       WHERE query IS NOT NULL AND jsonb_typeof(query) = 'object' AND ts >= $1 AND ts < $2
       ORDER BY ts DESC
       LIMIT $3`,
      [from, to, Math.min(limit, 20000)],
    );
    return rows.map((r: any) => {
      const q = r.query || {};
      return [
        ...(Array.isArray(q.measures) ? q.measures : []),
        ...(Array.isArray(q.dimensions) ? q.dimensions : []),
        ...(Array.isArray(q.segments) ? q.segments : []),
        ...(Array.isArray(q.timeDimensions) ? q.timeDimensions.map((t: any) => t && t.dimension) : []),
      ].filter(Boolean);
    });
  }

  /**
   * Recent individual queries for one fingerprint (Top Queries drill-down).
   */
  public async getQueriesForHash(hash: string, window: number | TimeRange = 24, limit = 100): Promise<any[]> {
    await this.init();
    if (this.disabled || !this.pool) {
      return [];
    }
    const { from, to } = this.timeBounds(window);
    const { rows } = await this.pool.query(
      `SELECT id, ts, request_id, api_type, duration_ms, status, external,
              queries_with_pre_aggregations, used_pre_aggregations, query
       FROM ${this.schema}.query_log
       WHERE query_hash = $3
         AND ts >= $1 AND ts < $2
       ORDER BY ts DESC
       LIMIT $4`,
      [from, to, hash, Math.min(limit, 500)],
    );
    return rows;
  }

  /**
   * All individual failing requests for one error message (Errors drill-down) —
   * the Errors tab groups by message, this lists every occurrence behind it.
   */
  public async getQueriesForError(error: string, window: number | TimeRange = 24, limit = 200): Promise<any[]> {
    await this.init();
    if (this.disabled || !this.pool) {
      return [];
    }
    const { from, to } = this.timeBounds(window);
    const { rows } = await this.pool.query(
      `SELECT id, ts, request_id, api_type, duration_ms, status, query
       FROM ${this.schema}.query_log
       WHERE status = 'error' AND error = $3
         AND ts >= $1 AND ts < $2
       ORDER BY ts DESC
       LIMIT $4`,
      [from, to, error, Math.min(limit, 1000)],
    );
    return rows;
  }
}
