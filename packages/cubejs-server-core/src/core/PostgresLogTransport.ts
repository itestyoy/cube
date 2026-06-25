/* eslint-disable no-console */
import type { Pool as PgPool, PoolClient } from 'pg';

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
            generated_sql                 JSONB
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
        await client.query(`CREATE INDEX IF NOT EXISTS query_log_ts_idx ON ${this.schema}.query_log (ts DESC)`);
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
    });
    this.cap(this.queryBuffer);
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
    const cols = 16;
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
      );
      return `(${Array.from({ length: cols }, (_, k) => `$${base + k + 1}`).join(',')})`;
    });
    await this.pool!.query(
      `INSERT INTO ${this.schema}.query_log
        (ts, request_id, api_type, duration_ms, queries, queries_with_pre_aggregations, used_pre_aggregations, db_type, is_playground, query, status, error, external, security_context, sql, generated_sql)
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
   * Query helpers used by the playground monitoring endpoints.
   */
  public async getSummary(windowHours = 24): Promise<any> {
    await this.init();
    if (this.disabled || !this.pool) {
      return null;
    }
    const { rows } = await this.pool.query(
      `SELECT
         count(*)::int                                            AS total_queries,
         coalesce(sum(queries_with_pre_aggregations),0)::int      AS accelerated_queries,
         coalesce(percentile_disc(0.5) within group (order by duration_ms),0)::int  AS p50_ms,
         coalesce(percentile_disc(0.95) within group (order by duration_ms),0)::int AS p95_ms
       FROM ${this.schema}.query_log
       WHERE ts > now() - ($1 || ' hours')::interval`,
      [windowHours],
    );
    return rows[0];
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

  public async getQueryHistory(filters: {
    limit?: number;
    order?: 'recent' | 'top';
    status?: 'success' | 'error';
    cache?: 'preagg' | 'raw';
    apiType?: string;
    minDurationMs?: number;
    windowHours?: number;
  } = {}): Promise<any[]> {
    await this.init();
    if (this.disabled || !this.pool) {
      return [];
    }
    const where: string[] = [];
    const params: any[] = [];
    const add = (clause: string, value: any) => {
      params.push(value);
      where.push(clause.replace('$?', `$${params.length}`));
    };

    add('ts > now() - ($? || \' hours\')::interval', filters.windowHours && filters.windowHours > 0 ? filters.windowHours : 24);
    if (filters.status) {
      add('status = $?', filters.status);
    }
    if (filters.apiType) {
      add('api_type = $?', filters.apiType);
    }
    if (typeof filters.minDurationMs === 'number') {
      add('duration_ms >= $?', filters.minDurationMs);
    }
    if (filters.cache === 'preagg') {
      where.push('coalesce(queries_with_pre_aggregations,0) > 0');
    } else if (filters.cache === 'raw') {
      where.push('coalesce(queries_with_pre_aggregations,0) = 0');
    }

    const orderBy = filters.order === 'top' ? 'duration_ms DESC NULLS LAST' : 'ts DESC';
    const limit = Math.min(filters.limit || 200, 1000);
    params.push(limit);

    const { rows } = await this.pool.query(
      `SELECT id, ts, request_id, api_type, duration_ms, queries, queries_with_pre_aggregations,
              used_pre_aggregations, db_type, is_playground, status, error, external, security_context,
              query, sql, generated_sql
       FROM ${this.schema}.query_log
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  public async getBuildHistory(windowHours = 24, limit = 500): Promise<any[]> {
    await this.init();
    if (this.disabled || !this.pool) {
      return [];
    }
    const { rows } = await this.pool.query(
      `SELECT id, ts, request_id, target_table, pre_aggregation, build_range_end, duration_ms, status
       FROM ${this.schema}.preagg_build_log
       WHERE ts > now() - ($1 || ' hours')::interval AND status = 'completed'
       ORDER BY ts DESC
       LIMIT $2`,
      [windowHours, Math.min(limit, 2000)],
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
}
