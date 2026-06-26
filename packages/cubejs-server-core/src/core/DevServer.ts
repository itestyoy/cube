/* eslint-disable global-require,no-restricted-syntax */
import dotenv from '@cubejs-backend/dotenv';
import { CubePreAggregationConverter, CubeSchemaConverter, ScaffoldingTemplate, SchemaFormat } from '@cubejs-backend/schema-compiler';
import spawn from 'cross-spawn';
import path from 'path';
import fs from 'fs-extra';
import { getRequestIdFromRequest } from '@cubejs-backend/api-gateway';
import { LivePreviewWatcher } from '@cubejs-backend/cloud';
import { AppContainer, DependencyTree, PackageFetcher, DevPackageFetcher } from '@cubejs-backend/templates';
import jwt from 'jsonwebtoken';
import isDocker from 'is-docker';
import type { Application as ExpressApplication, Request, Response } from 'express';
import type { ChildProcess } from 'child_process';
import { executeCommand, getAnonymousId, getEnv, keyByDataSource, packageExists } from '@cubejs-backend/shared';
import crypto from 'crypto';

import type { BaseDriver } from '@cubejs-backend/query-orchestrator';

import { CubejsServerCore } from './server';
import { ExternalDbTypeFn, ServerCoreInitializedOptions, DatabaseType } from './types';
import DriverDependencies from './DriverDependencies';
import { buildRecommendations, RollupDef, WorkloadShape } from './RecommendationEngine';

const repo = {
  owner: 'cube-js',
  name: 'cubejs-playground-templates'
};

type DevServerOptions = {
  externalDbTypeFn: ExternalDbTypeFn;
  isReadyForQueryProcessing: () => boolean;
  dockerVersion?: string;
};

export class DevServer {
  protected applyTemplatePackagesPromise: Promise<any> | null = null;

  protected dashboardAppProcess: ChildProcess & { dashboardUrlPromise?: Promise<any> } | null = null;

  protected livePreviewWatcher = new LivePreviewWatcher();

  public constructor(
    protected readonly cubejsServer: CubejsServerCore,
    protected readonly options: DevServerOptions
  ) {
  }

  public initDevEnv(app: ExpressApplication, options: ServerCoreInitializedOptions) {
    const port = process.env.PORT || 4000; // TODO
    const apiUrl = process.env.CUBEJS_API_URL || `http://localhost:${port}`;

    // todo: empty/default `apiSecret` in dev mode to allow the DB connection wizard
    const cubejsToken = jwt.sign({}, options.apiSecret || 'secret', { expiresIn: '1d' });

    if (process.env.NODE_ENV !== 'production') {
      console.log('🔓 Authentication checks are disabled in developer mode. Please use NODE_ENV=production to enable it.');
    } else {
      console.log(`🔒 Your temporary cube.js token: ${cubejsToken}`);
    }
    console.log(`🦅 Dev environment available at ${apiUrl}`);

    if (
      (
        this.options.externalDbTypeFn({
          authInfo: null,
          securityContext: null,
          requestId: '',
        }) || ''
      ).toLowerCase() !== 'cubestore'
    ) {
      console.log('⚠️  Your pre-aggregations will be on an external database. It is recommended to use Cube Store for optimal performance');
    }

    this.cubejsServer.event('Dev Server Start');
    const serveStatic = require('serve-static');

    const catchErrors = (handler) => async (req, res, next) => {
      try {
        await handler(req, res, next);
      } catch (e) {
        const errorString = ((e as Error).stack || e).toString();
        console.error(errorString);
        this.cubejsServer.event('Dev Server Error', { error: errorString });

        // We don't know what state response is left at here:
        // It could be corked, headers could be sent, body could be sent completely or partially

        // Also, because we pass `next` to handler without any wrapper we don't know if it was called or not
        // Hence, we shouldn't call it for error handling

        try {
          while (res.writableCorked > 0) {
            res.uncork();
          }

          if (res.writableEnded) {
            // There's nothing we can do for response, error happened after call to end()
          } else if (res.headersSent) {
            // If header is already sent, we can't alter any of it, so best we can do is just terminate body
            res.end();
          } else {
            res.status(500).json({ error: errorString });
          }
        } catch (send500Error) {
          const send500ErrorString = ((send500Error as Error).stack || send500Error).toString();
          console.error(send500ErrorString);
          this.cubejsServer.event('Dev Server Error', { error: send500ErrorString });
          res.destroy(send500Error);
        }
      }
    };

    app.get('/playground/context', catchErrors((req, res) => {
      this.cubejsServer.event('Dev Server Env Open');

      res.json({
        cubejsToken,
        basePath: options.basePath,
        anonymousId: getAnonymousId(),
        coreServerVersion: this.cubejsServer.coreServerVersion,
        dockerVersion: this.options.dockerVersion || null,
        projectFingerprint: this.cubejsServer.projectFingerprint,
        dbType: options.dbType || null,
        shouldStartConnectionWizardFlow: !this.options.isReadyForQueryProcessing(),
        livePreview: options.livePreview,
        isDocker: isDocker(),
        telemetry: options.telemetry,
        identifier: this.getIdentifier(options.apiSecret),
        previewFeatures: getEnv('previewFeatures'),
      });
    }));

    // ---------------------------------------------------------------------
    // Pre-Aggregations Monitor
    //
    // Historical endpoints are backed by the Postgres telemetry transport
    // (enabled via CUBEJS_TELEMETRY_DB_URL). The live build queue is read
    // straight from the orchestrator. All return empty/null gracefully when
    // telemetry is not configured so the page still renders.
    // ---------------------------------------------------------------------
    const telemetry = () => this.cubejsServer.telemetryTransport;
    // Resolves the analytics time window from the request: an absolute
    // [from, to) range when both are present, otherwise a relative "last N
    // hours" (fractional allowed). Transport methods accept either form.
    const telemetryWindow = (req: Request): number | { from: string; to: string } => {
      const from = req.query.from ? String(req.query.from) : undefined;
      const to = req.query.to ? String(req.query.to) : undefined;
      if (from && to) {
        return { from, to };
      }
      const h = parseFloat(String(req.query.windowHours || '24'));
      return Number.isFinite(h) && h > 0 ? h : 24;
    };

    // Selectable display latency percentile (0..1), default p95.
    const telemetryPercentile = (req: Request): number => {
      const p = parseFloat(String(req.query.percentile || '0.95'));
      return Number.isFinite(p) && p > 0 && p < 1 ? p : 0.95;
    };

    app.get('/playground/pre-agg-monitor/summary', catchErrors(async (req, res) => {
      const t = telemetry();
      res.json({
        enabled: Boolean(t),
        summary: t ? await t.getSummary(telemetryWindow(req)) : null,
      });
    }));

    app.get('/playground/pre-agg-monitor/query-log', catchErrors(async (req, res) => {
      const t = telemetry();
      const limit = parseInt(String(req.query.limit || '200'), 10) || 200;
      res.json({ enabled: Boolean(t), rows: t ? await t.getQueryLog(limit) : [] });
    }));

    app.get('/playground/pre-agg-monitor/used-by', catchErrors(async (req, res) => {
      const t = telemetry();
      res.json({ enabled: Boolean(t), rows: t ? await t.getUsedBy() : [] });
    }));

    app.get('/playground/pre-agg-monitor/build-history', catchErrors(async (req, res) => {
      const t = telemetry();
      res.json({ enabled: Boolean(t), rows: t ? await t.getBuildHistory(telemetryWindow(req)) : [] });
    }));

    app.get('/playground/query-history', catchErrors(async (req, res) => {
      const t = telemetry();
      if (!t) {
        res.json({ enabled: false, rows: [] });
        return;
      }
      const q = req.query;
      const num = (v: any) => (v != null && v !== '' ? parseInt(String(v), 10) : undefined);
      const status = q.status === 'error' ? 'error' : q.status === 'success' ? 'success' : undefined;
      const cache = q.cache === 'preagg' ? 'preagg' : q.cache === 'raw' ? 'raw' : undefined;
      const rows = await t.getQueryHistory({
        limit: num(q.limit),
        order: q.order === 'top' ? 'top' : 'recent',
        status,
        cache,
        apiType: q.apiType ? String(q.apiType) : undefined,
        minDurationMs: num(q.minDurationMs),
        windowHours: q.windowHours ? parseFloat(String(q.windowHours)) : undefined,
        from: q.from ? String(q.from) : undefined,
        to: q.to ? String(q.to) : undefined,
      });
      res.json({ enabled: true, rows });
    }));

    app.get('/playground/pre-agg-monitor/queue', catchErrors(async (req, res) => {
      const orchestratorApi = await this.cubejsServer.getOrchestratorApi({
        authInfo: null,
        securityContext: {},
        requestId: getRequestIdFromRequest(req),
      } as any);
      res.json({ queue: await orchestratorApi.getPreAggregationQueueStates() });
    }));

    // Best-effort partition state per pre-aggregation: total / ready / building.
    // Heavy orchestrator calls, so it's a separate endpoint the catalog merges
    // in lazily; any failure degrades to an empty map (UI shows "—").
    app.get('/playground/pre-agg-monitor/partitions-state', catchErrors(async (req, res) => {
      const ctx = {
        authInfo: null,
        securityContext: {},
        requestId: getRequestIdFromRequest(req),
      } as any;
      const state: Record<string, { total: number | null; ready: number | null; building: number }> = {};
      try {
        const compilerApi = await this.cubejsServer.getCompilerApi(ctx);
        const defined: any[] = await compilerApi.preAggregations();

        // Currently building/queued partitions, matched to a pre-agg by table name.
        const orchestratorApi = await this.cubejsServer.getOrchestratorApi(ctx);
        const queueRaw = await orchestratorApi.getPreAggregationQueueStates();
        const queue: any[] = Array.isArray(queueRaw) ? queueRaw : Object.values(queueRaw || {});
        const buildingFor = (cand: string[]) =>
          queue.filter((item: any) => {
            const table = item?.query?.newVersionEntry?.table_name || item?.query?.preAggregation?.tableName || '';
            const k = normKey(table);
            return cand.some((c) => c && k.includes(c));
          }).length;

        // Total partitions that should exist (cacheOnly avoids triggering builds).
        // eslint-disable-next-line global-require
        const { RefreshScheduler } = require('./RefreshScheduler');
        const scheduler = new RefreshScheduler(this.cubejsServer);
        let partInfo: any[] = [];
        try {
          partInfo = await scheduler.preAggregationPartitions(ctx, {
            metadata: {},
            timezones: ['UTC'],
            preAggregations: defined.map((p: any) => ({ id: p.id, cacheOnly: true })),
          });
        } catch (e) {
          partInfo = [];
        }
        const totalById: Record<string, number> = {};
        partInfo.forEach((entry: any) => {
          const id = entry?.preAggregation?.preAggregationId || entry?.preAggregation?.id;
          if (id) totalById[normKey(id)] = (entry.partitions || []).length;
        });

        defined.forEach((p: any) => {
          const cand = [normKey(p.id), normKey(p.preAggregationName)];
          const total = cand.map((c) => totalById[c]).find((v) => v != null);
          const building = buildingFor(cand);
          state[p.id] = {
            total: total != null ? total : null,
            ready: total != null ? Math.max(0, total - building) : null,
            building,
          };
        });
      } catch (e) {
        // Degrade gracefully — catalog still renders without partition columns.
      }
      res.json({ state });
    }));

    // Normalize a pre-aggregation identifier for fuzzy matching between the
    // defined catalog ids ("Cube.name") and the keys/table names seen in
    // telemetry (e.g. "cube.name", "dev_pre_aggregations.cube_name_...").
    const normKey = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    // Map every VIEW member to its underlying CUBE member via the meta
    // `aliasMember` field. Queries usually reference view members while
    // pre-aggregations are defined on cubes; canonicalizing to the cube member
    // is the correct way to match the two (resolved transitively for views of
    // views). `canonicalMember` leaves plain cube members untouched.
    const buildAliasMap = async (req: Request): Promise<(m: string) => string> => {
      const map: Record<string, string> = {};
      try {
        const ctx = { authInfo: null, securityContext: {}, requestId: getRequestIdFromRequest(req) } as any;
        const compilerApi = await this.cubejsServer.getCompilerApi(ctx);
        const meta = await compilerApi.metaConfig(ctx, { requestId: getRequestIdFromRequest(req) });
        const cubes = Array.isArray(meta) ? meta : (meta && meta.cubes) || [];
        cubes.forEach((c: any) => {
          const conf = c.config || c;
          [...(conf.measures || []), ...(conf.dimensions || []), ...(conf.segments || [])].forEach((m: any) => {
            if (m && m.aliasMember && m.name) {
              map[m.name] = m.aliasMember;
            }
          });
        });
      } catch (e) {
        // best-effort; fall back to identity matching
      }
      return (member: string) => {
        let cur = member;
        for (let i = 0; i < 5 && map[cur]; i++) {
          cur = map[cur];
        }
        return cur;
      };
    };

    // Additivity map: measures that can be rolled up across dimensions not in
    // the rollup. Keyed by canonical (cube) member; view measures resolve to
    // their source measure. Used by the recommendation engine's coverage check.
    const ADDITIVE_TYPES = new Set(['sum', 'count', 'countDistinctApprox', 'min', 'max']);
    const buildAdditiveMap = async (req: Request, canonical: (m: string) => string): Promise<(m: string) => boolean> => {
      const additive: Record<string, boolean> = {};
      try {
        const ctx = { authInfo: null, securityContext: {}, requestId: getRequestIdFromRequest(req) } as any;
        const compilerApi = await this.cubejsServer.getCompilerApi(ctx);
        const meta = await compilerApi.metaConfig(ctx, { requestId: getRequestIdFromRequest(req) });
        const cubes = Array.isArray(meta) ? meta : (meta && meta.cubes) || [];
        cubes.forEach((c: any) => {
          const conf = c.config || c;
          (conf.measures || []).forEach((m: any) => {
            if (m && m.name) {
              const key = canonical(m.aliasMember || m.name);
              additive[key] = ADDITIVE_TYPES.has(m.aggType || m.type);
            }
          });
        });
      } catch (e) {
        // best-effort; default to additive (permissive) when meta is unavailable
      }
      // Unknown measures default to additive=true (don't over-restrict matching).
      return (member: string) => additive[member] ?? additive[canonical(member)] ?? true;
    };

    // Catalog of all DEFINED pre-aggregations, left-joined with usage + build
    // telemetry so pre-aggs with zero hits surface as candidates for removal.
    app.get('/playground/pre-agg-monitor/catalog', catchErrors(async (req, res) => {
      const windowHours = telemetryWindow(req);
      const compilerApi = await this.cubejsServer.getCompilerApi({
        authInfo: null,
        securityContext: {},
        requestId: getRequestIdFromRequest(req),
      } as any);
      const defined: any[] = await compilerApi.preAggregations();

      const t = telemetry();
      const usage = t ? await t.getPreAggUsage(windowHours, telemetryPercentile(req)) : [];
      const builds = t ? await t.getPreAggBuildStats(windowHours) : [];

      const matchStat = (id: string, name: string, stats: any[]) => {
        const candidates = [normKey(id), normKey(name)];
        return stats.find((s) => {
          const k = normKey(s.pre_aggregation);
          return candidates.includes(k) || candidates.some((c) => c && (k.includes(c) || c.includes(k)));
        });
      };

      const rows = defined.map((p: any) => {
        const def = p.preAggregation || {};
        const u = matchStat(p.id, p.preAggregationName, usage);
        const b = matchStat(p.id, p.preAggregationName, builds);
        return {
          id: p.id,
          cube: p.cube,
          name: p.preAggregationName,
          type: def.type || 'rollup',
          granularity: def.granularity || null,
          external: def.external !== false,
          scheduledRefresh: Boolean(def.scheduledRefresh),
          // usage
          usageKey: u ? u.pre_aggregation : null,
          hits: u ? u.query_count : 0,
          p_ms: u ? u.p_ms : null,
          last_used: u ? u.last_used : null,
          // builds
          build_count: b ? b.build_count : 0,
          avg_build_ms: b ? b.avg_ms : null,
          max_build_ms: b ? b.max_ms : null,
          last_build: b ? b.last_build : null,
        };
      });

      res.json({ telemetryEnabled: Boolean(t), windowHours: typeof windowHours === 'number' ? windowHours : null, rows });
    }));

    // Recent queries accelerated by a given pre-aggregation key.
    app.get('/playground/pre-agg-monitor/preagg-queries', catchErrors(async (req, res) => {
      const t = telemetry();
      const key = String(req.query.key || '');
      if (!t || !key) {
        res.json({ enabled: Boolean(t), rows: [] });
        return;
      }
      res.json({ enabled: true, rows: await t.getQueriesForPreAgg(key, telemetryWindow(req)) });
    }));

    // Single query log row (Query History detail view).
    app.get('/playground/pre-agg-monitor/query', catchErrors(async (req, res) => {
      const t = telemetry();
      const id = parseInt(String(req.query.id || ''), 10);
      res.json({ row: t && Number.isFinite(id) ? await t.getQueryById(id) : null });
    }));

    // Single build log row (Build detail view).
    app.get('/playground/pre-agg-monitor/build', catchErrors(async (req, res) => {
      const t = telemetry();
      const id = parseInt(String(req.query.id || ''), 10);
      res.json({ row: t && Number.isFinite(id) ? await t.getBuildById(id) : null });
    }));

    // Full detail for a single defined pre-aggregation: definition, indexes,
    // usage + build stats, recent accelerated queries and recent builds.
    app.get('/playground/pre-agg-monitor/preagg', catchErrors(async (req, res) => {
      const id = String(req.query.id || '');
      const windowHours = telemetryWindow(req);
      const compilerApi = await this.cubejsServer.getCompilerApi({
        authInfo: null,
        securityContext: {},
        requestId: getRequestIdFromRequest(req),
      } as any);
      const defined: any[] = await compilerApi.preAggregations();
      const nk = normKey(id);
      // The link may arrive as the defined id ("Cube.name") OR as the
      // usedPreAggregations key / Cube Store table name (e.g.
      // "bi_cube_store.query_cohort_retention_rollup"). Resolve strongest first:
      // exact id, then id contains, then by pre-aggregation NAME contained in
      // the key (the table name always embeds the pre-agg name).
      const p =
        defined.find((x: any) => x.id === id || normKey(x.id) === nk) ||
        defined.find((x: any) => {
          const xk = normKey(x.id);
          return nk && (xk.includes(nk) || nk.includes(xk));
        }) ||
        defined.find((x: any) => {
          const xn = normKey(x.preAggregationName);
          return xn && nk.includes(xn);
        });
      if (!p) {
        res.json({ found: false });
        return;
      }

      const def = p.preAggregation || {};
      const cand = [normKey(p.id), normKey(p.preAggregationName)];
      const match = (list: any[]) =>
        list.find((s) => {
          const k = normKey(s.pre_aggregation);
          return cand.includes(k) || cand.some((c) => c && (k.includes(c) || c.includes(k)));
        });

      const t = telemetry();
      const usage = t ? await t.getPreAggUsage(windowHours, telemetryPercentile(req)) : [];
      const buildStats = t ? await t.getPreAggBuildStats(windowHours) : [];
      const u = match(usage);
      const b = match(buildStats);
      const usageKey = u ? u.pre_aggregation : null;
      const queries = t && usageKey ? await t.getQueriesForPreAgg(usageKey, windowHours) : [];
      const allBuilds = t ? await t.getBuildHistory(windowHours, 500) : [];
      const builds = allBuilds.filter((bh: any) =>
        cand.some((c) => c && (normKey(bh.pre_aggregation).includes(c) || normKey(bh.target_table).includes(c))));

      // Field-level usage: count how often each member appears across the
      // queries this pre-aggregation actually served (its "Used By" set). A
      // field never requested by any of those queries is dead weight here.
      // Count member usage across this pre-agg's served queries, canonicalizing
      // each queried (often view) member to its underlying cube member so it
      // lines up with the pre-aggregation's cube-based references.
      const canonical = await buildAliasMap(req);
      const memberMap: Record<string, number> = {};
      (queries || []).forEach((qr: any) => {
        const qq = qr.query || {};
        const members = [
          ...(qq.measures || []),
          ...(qq.dimensions || []),
          ...(qq.segments || []),
          ...((qq.timeDimensions || []).map((td: any) => td && td.dimension)),
        ].filter(Boolean);
        new Set(members).forEach((m: any) => {
          const c = canonical(m);
          memberMap[c] = (memberMap[c] || 0) + 1;
        });
      });
      const usesOf = (m: string) => memberMap[m] || memberMap[canonical(m)] || 0;
      const refs: any = p.references || {};
      const collect = (arr: any): string[] =>
        Array.isArray(arr)
          ? arr.map((x: any) => (typeof x === 'string' ? x : x && (x.dimension || x.name))).filter(Boolean)
          : [];
      const uniq = (xs: string[]) => Array.from(new Set(xs));
      const measureMembers = uniq([...collect(refs.measures), ...collect(def.measures)]);
      const dimensionMembers = uniq([...collect(refs.dimensions), ...collect(def.dimensions)]);
      const timeMembers = uniq([
        ...collect((refs.timeDimensions || []).map((td: any) => td && td.dimension)),
        ...collect(def.timeDimension ? [def.timeDimension] : []),
      ]);
      const fields = [
        ...measureMembers.map((m) => ({ member: m, kind: 'measure', uses: usesOf(m) })),
        ...dimensionMembers.map((m) => ({ member: m, kind: 'dimension', uses: usesOf(m) })),
        ...timeMembers.map((m) => ({ member: m, kind: 'timeDimension', uses: usesOf(m) })),
      ];

      res.json({
        fields,
        found: true,
        telemetryEnabled: Boolean(t),
        windowHours: typeof windowHours === 'number' ? windowHours : null,
        preAgg: {
          id: p.id,
          cube: p.cube,
          name: p.preAggregationName,
          type: def.type || 'rollup',
          granularity: def.granularity || null,
          external: def.external !== false,
          scheduledRefresh: Boolean(def.scheduledRefresh),
          refreshKey: p.refreshKey || def.refreshKey || null,
          definition: def,
          indexes: p.indexesReferences || null,
          references: p.references || null,
          usageKey,
          hits: u ? u.query_count : 0,
          p_ms: u ? u.p_ms : null,
          last_used: u ? u.last_used : null,
          build_count: b ? b.build_count : 0,
          avg_build_ms: b ? b.avg_ms : null,
          max_build_ms: b ? b.max_ms : null,
          last_build: b ? b.last_build : null,
        },
        queries,
        builds,
      });
    }));

    // Detailed per-partition state for a single pre-aggregation: every
    // partition that should exist (from the refresh scheduler) merged with its
    // built version entries (Cube Store) and current build/queue activity.
    app.get('/playground/pre-agg-monitor/preagg-partitions', catchErrors(async (req, res) => {
      const id = String(req.query.id || '');
      const ctx = { authInfo: null, securityContext: {}, requestId: getRequestIdFromRequest(req) } as any;
      const compilerApi = await this.cubejsServer.getCompilerApi(ctx);
      const defined: any[] = await compilerApi.preAggregations();
      const nk = normKey(id);
      const p =
        defined.find((x: any) => x.id === id || normKey(x.id) === nk) ||
        defined.find((x: any) => { const xk = normKey(x.id); return nk && (xk.includes(nk) || nk.includes(xk)); }) ||
        defined.find((x: any) => { const xn = normKey(x.preAggregationName); return xn && nk.includes(xn); });
      if (!p) {
        res.json({ found: false, partitions: [] });
        return;
      }

      const def = p.preAggregation || {};
      // Non-partitioned rollups have a single partition; partitioned ones are
      // partitioned by the partitionGranularity over the time dimension.
      const partitioned = Boolean(def.partitionGranularity);

      try {
        // eslint-disable-next-line global-require
        const { RefreshScheduler } = require('./RefreshScheduler');
        const scheduler = new RefreshScheduler(this.cubejsServer);
        const orchestratorApi = await this.cubejsServer.getOrchestratorApi(ctx);

        const partInfo: any[] = await scheduler.preAggregationPartitions(ctx, {
          metadata: {},
          timezones: ['UTC'],
          preAggregations: [{ id: p.id, cacheOnly: true }],
        });
        const entry = partInfo.find((e: any) => {
          const eid = e?.preAggregation?.preAggregationId || e?.preAggregation?.id;
          return eid === p.id || normKey(eid) === normKey(p.id);
        }) || partInfo[0];
        const rawPartitions: any[] = (entry && entry.partitions) || [];

        // Built version entries per table (Cube Store), keyed by table name.
        let versionsByTable: Record<string, any[]> = {};
        try {
          const ve = await orchestratorApi.getPreAggregationVersionEntries(
            ctx,
            [entry].filter(Boolean),
            compilerApi.preAggregationsSchema,
          );
          versionsByTable = (ve && ve.versionEntriesByTableName) || {};
        } catch (e) {
          versionsByTable = {};
        }

        // Currently building/queued partitions matched by table name.
        let queue: any[] = [];
        try {
          const queueRaw = await orchestratorApi.getPreAggregationQueueStates();
          queue = Array.isArray(queueRaw) ? queueRaw : Object.values(queueRaw || {});
        } catch (e) {
          queue = [];
        }
        const isBuilding = (table: string) => {
          const k = normKey(table);
          return queue.some((item: any) => {
            const t2 = item?.query?.newVersionEntry?.table_name || item?.query?.preAggregation?.tableName || '';
            return k && normKey(t2).includes(k);
          });
        };

        const partitions = rawPartitions.map((part: any) => {
          const table = part.tableName || '';
          const versions = versionsByTable[table] || [];
          const lastUpdated = versions.reduce((mx: number, v: any) => Math.max(mx, v.last_updated_at || 0), 0);
          const building = isBuilding(table);
          return {
            tableName: table,
            timezone: part.timezone || 'UTC',
            buildRangeStart: part.buildRangeStart || (part.dataRange && part.dataRange[0]) || null,
            buildRangeEnd: part.buildRangeEnd || (part.dataRange && part.dataRange[1]) || null,
            dataSource: part.dataSource || null,
            type: part.type || def.type || 'rollup',
            built: versions.length > 0,
            versionCount: versions.length,
            lastBuilt: lastUpdated ? new Date(lastUpdated).toISOString() : null,
            contentVersion: versions[0]?.content_version || null,
            structureVersion: versions[0]?.structure_version || null,
            status: building ? 'building' : (versions.length > 0 ? 'ready' : 'not built'),
          };
        });

        res.json({
          found: true,
          partitioned,
          partitionGranularity: def.partitionGranularity || null,
          total: partitions.length,
          ready: partitions.filter((x) => x.status === 'ready').length,
          building: partitions.filter((x) => x.status === 'building').length,
          partitions,
        });
      } catch (e: any) {
        res.json({ found: true, partitioned, partitions: [], error: e?.message || String(e) });
      }
    }));

    // ----- Insights (query analytics) -------------------------------------
    app.get('/playground/insights/top-queries', catchErrors(async (req, res) => {
      const t = telemetry();
      const order = req.query.order === 'count' ? 'count' : 'total';
      res.json({ enabled: Boolean(t), rows: t ? await t.getTopQueries(telemetryWindow(req), order, 100, telemetryPercentile(req)) : [] });
    }));

    // Unified recommendation engine (Action Center): turns the workload + the
    // defined pre-aggs into a single ranked list of create / edit / fix / drop
    // actions. Granularity- and additivity-aware (see RecommendationEngine).
    app.get('/playground/insights/recommendations', catchErrors(async (req, res) => {
      const t = telemetry();
      if (!t) {
        res.json({ enabled: false, thresholds: null, actions: [] });
        return;
      }
      const window = telemetryWindow(req);
      const slownessPct = req.query.percentile ? parseFloat(String(req.query.percentile)) : 0.9;
      const rarityPct = req.query.rarityPct ? parseFloat(String(req.query.rarityPct)) : 0.1;

      const ctx = { authInfo: null, securityContext: {}, requestId: getRequestIdFromRequest(req) } as any;
      const compilerApi = await this.cubejsServer.getCompilerApi(ctx);
      const canonical = await buildAliasMap(req);
      const additive = await buildAdditiveMap(req, canonical);

      const [defined, topRows, usage, buildStats, rawMemberMap] = await Promise.all([
        compilerApi.preAggregations(),
        t.getTopQueries(window, 'total', 500),
        t.getPreAggUsage(window),
        t.getPreAggBuildStats(window),
        t.getMemberUsageMap(window),
      ]);

      // Canonicalize member usage so it lines up with cube-based rollup refs.
      const memberUsage: Record<string, number> = {};
      Object.entries(rawMemberMap).forEach(([k, v]) => {
        const c = canonical(k);
        memberUsage[c] = (memberUsage[c] || 0) + (v as number);
      });

      const collect = (arr: any): string[] =>
        Array.isArray(arr) ? arr.map((x: any) => (typeof x === 'string' ? x : x && (x.dimension || x.name))).filter(Boolean) : [];
      const matchStat = (id: string, name: string, stats: any[]) => {
        const cand = [normKey(id), normKey(name)];
        return stats.find((s) => {
          const k = normKey(s.pre_aggregation);
          return cand.includes(k) || cand.some((c) => c && (k.includes(c) || c.includes(k)));
        });
      };

      const rollups: RollupDef[] = (defined as any[]).map((p: any) => {
        const def = p.preAggregation || {};
        const refs: any = p.references || {};
        const u = matchStat(p.id, p.preAggregationName, usage);
        const b = matchStat(p.id, p.preAggregationName, buildStats);
        const timeDimensions = collect((refs.timeDimensions || []).map((td: any) => td && td.dimension))
          .map((d) => canonical(d) + (def.granularity ? `:${def.granularity}` : ''));
        if (def.timeDimension) timeDimensions.push(canonical(def.timeDimension) + (def.granularity ? `:${def.granularity}` : ''));
        return {
          id: p.id,
          cube: p.cube,
          name: p.preAggregationName,
          dimensions: new Set([...collect(refs.dimensions), ...collect(def.dimensions)].map(canonical)),
          measures: new Set([...collect(refs.measures), ...collect(def.measures)].map(canonical)),
          timeDimensions,
          granularity: def.granularity || null,
          hits: u ? u.query_count : 0,
          buildCount: b ? b.build_count : 0,
          avgBuildMs: b ? b.avg_ms : null,
        };
      });

      const shapes: WorkloadShape[] = (topRows as any[]).map((r: any) => ({
        queryHash: r.query_hash,
        shape: r.shape || { measures: [], dimensions: [], timeDimensions: [], filters: [] },
        executions: r.executions || 0,
        avgMs: r.avg_ms || 0,
        totalMs: Number(r.total_ms) || 0,
        hitRate: r.hit_rate || 0,
        lastSeen: r.last_seen || null,
      }));

      const out = buildRecommendations({ shapes, rollups, memberUsage, canonical, additive, slownessPct, rarityPct });
      res.json({ enabled: true, ...out });
    }));

    app.get('/playground/insights/errors', catchErrors(async (req, res) => {
      const t = telemetry();
      res.json({ enabled: Boolean(t), rows: t ? await t.getErrorStats(telemetryWindow(req)) : [] });
    }));

    app.get('/playground/insights/model-usage', catchErrors(async (req, res) => {
      const t = telemetry();
      const window = telemetryWindow(req);
      const rawUsed = t ? await t.getMemberUsageMap(window) : {};

      // Canonicalize query members (view -> cube) so usage lines up with the
      // model's cube members; then list ALL defined CUBE members (skipping
      // views, which only re-expose cube members) so never-queried members
      // surface with uses = 0.
      const canonical = await buildAliasMap(req);
      const usedMap: Record<string, number> = {};
      Object.entries(rawUsed).forEach(([k, v]) => {
        const c = canonical(k);
        usedMap[c] = (usedMap[c] || 0) + (v as number);
      });

      const ctx = {
        authInfo: null,
        securityContext: {},
        requestId: getRequestIdFromRequest(req),
      } as any;
      const compilerApi = await this.cubejsServer.getCompilerApi(ctx);
      const meta: any = await compilerApi.metaConfig(ctx, { requestId: ctx.requestId });
      const cubes = Array.isArray(meta) ? meta : (meta && meta.cubes) || [];

      const measures: any[] = [];
      const dimensions: any[] = [];
      cubes.forEach((entry: any) => {
        const cube = entry.config || entry;
        if (cube.type === 'view') {
          return; // views re-expose cube members; the model = cubes
        }
        (cube.measures || []).forEach((m: any) =>
          measures.push({ member: m.name, cube: cube.name, type: m.type, uses: usedMap[m.name] || 0 }));
        (cube.dimensions || []).forEach((d: any) =>
          dimensions.push({ member: d.name, cube: cube.name, type: d.type, uses: usedMap[d.name] || 0 }));
      });
      measures.sort((a, b) => b.uses - a.uses);
      dimensions.sort((a, b) => b.uses - a.uses);

      res.json({ enabled: Boolean(t), measures, dimensions });
    }));

    // Which other members a given member is most often queried alongside.
    // Computed on canonicalized (view -> cube) member sets so it aligns with
    // the model's cube members shown in Model Usage.
    app.get('/playground/insights/cooccurrence', catchErrors(async (req, res) => {
      const t = telemetry();
      const member = String(req.query.member || '');
      if (!t || !member) {
        res.json({ enabled: Boolean(t), rows: [] });
        return;
      }
      const canonical = await buildAliasMap(req);
      const sets = await t.getRecentQueryMembers(telemetryWindow(req));
      const counts: Record<string, number> = {};
      let total = 0;
      sets.forEach((raw: string[]) => {
        const members = Array.from(new Set(raw.map((m) => canonical(m))));
        if (!members.includes(member)) {
          return;
        }
        total += 1;
        members.forEach((m) => {
          if (m !== member) {
            counts[m] = (counts[m] || 0) + 1;
          }
        });
      });
      const rows = Object.entries(counts)
        .map(([m, c]) => ({ member: m, count: c, pct: total ? Math.round((c / total) * 100) : 0 }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 30);
      res.json({ enabled: true, member, coQueries: total, rows });
    }));

    app.get('/playground/insights/hash-queries', catchErrors(async (req, res) => {
      const t = telemetry();
      const hash = String(req.query.hash || '');
      res.json({ enabled: Boolean(t), rows: t && hash ? await t.getQueriesForHash(hash, telemetryWindow(req)) : [] });
    }));

    app.get('/playground/insights/error-queries', catchErrors(async (req, res) => {
      const t = telemetry();
      const error = String(req.query.error || '');
      res.json({ enabled: Boolean(t), rows: t && error ? await t.getQueriesForError(error, telemetryWindow(req)) : [] });
    }));

    // Time-bucketed series for the Query History charts.
    app.get('/playground/query-history/timeseries', catchErrors(async (req, res) => {
      const t = telemetry();
      res.json({ enabled: Boolean(t), rows: t ? await t.getTimeSeries(telemetryWindow(req), telemetryPercentile(req)) : [] });
    }));

    // Pre-aggregation advice: which pre-aggs to REMOVE (defined but never hit)
    // and which FIELDS to trim (materialized members never queried anywhere).
    // "What to add" is served by /insights/recommendations.
    app.get('/playground/insights/pre-agg-advice', catchErrors(async (req, res) => {
      const window = telemetryWindow(req);
      const ctx = {
        authInfo: null,
        securityContext: {},
        requestId: getRequestIdFromRequest(req),
      } as any;
      const compilerApi = await this.cubejsServer.getCompilerApi(ctx);
      const defined: any[] = await compilerApi.preAggregations();

      const t = telemetry();
      const usage = t ? await t.getPreAggUsage(window) : [];
      const buildStats = t ? await t.getPreAggBuildStats(window) : [];
      const rawMemberMap = t ? await t.getMemberUsageMap(window) : {};
      // Canonicalize query member usage (view members -> cube members) so it
      // lines up with the cube-based pre-aggregation references.
      const canonical = await buildAliasMap(req);
      const canonUsage: Record<string, number> = {};
      Object.entries(rawMemberMap).forEach(([k, v]) => {
        const c = canonical(k);
        canonUsage[c] = (canonUsage[c] || 0) + (v as number);
      });

      const matchStat = (id: string, name: string, stats: any[]) => {
        const cand = [normKey(id), normKey(name)];
        return stats.find((s) => {
          const k = normKey(s.pre_aggregation);
          return cand.includes(k) || cand.some((c) => c && (k.includes(c) || c.includes(k)));
        });
      };
      const collect = (arr: any): string[] =>
        Array.isArray(arr)
          ? arr.map((x: any) => (typeof x === 'string' ? x : x && (x.dimension || x.name))).filter(Boolean)
          : [];

      const removePreAggs: any[] = [];
      const trimFields: any[] = [];
      defined.forEach((p: any) => {
        const def = p.preAggregation || {};
        const refs: any = p.references || {};
        const u = matchStat(p.id, p.preAggregationName, usage);
        const b = matchStat(p.id, p.preAggregationName, buildStats);
        const hits = u ? u.query_count : 0;

        if (!hits) {
          removePreAggs.push({
            id: p.id,
            cube: p.cube,
            name: p.preAggregationName,
            build_count: b ? b.build_count : 0,
            avg_build_ms: b ? b.avg_ms : null,
            reason: b && b.build_count > 0 ? 'Built but never used' : 'No usage and no builds',
          });
          return; // a fully-unused pre-agg is a remove candidate, not a trim one
        }

        const members = [
          ...collect(refs.measures).map((m) => ({ member: m, kind: 'measure' })),
          ...collect(refs.dimensions).map((m) => ({ member: m, kind: 'dimension' })),
          ...collect((refs.timeDimensions || []).map((td: any) => td && td.dimension)).map((m) => ({ member: m, kind: 'timeDimension' })),
          ...collect(def.measures).map((m) => ({ member: m, kind: 'measure' })),
          ...collect(def.dimensions).map((m) => ({ member: m, kind: 'dimension' })),
        ];
        // Fields worth trimming: never used, or used in only a small fraction
        // of this pre-agg's queries (rarely-used dead weight). Each field keeps
        // its use count and a 'never' | 'rare' tier so the UI can show why.
        const rareThreshold = Math.max(1, Math.ceil(hits * 0.05));
        const seen = new Set<string>();
        const trim = members
          .filter((f) => {
            if (seen.has(f.member)) return false;
            seen.add(f.member);
            return true;
          })
          .map((f) => ({ ...f, uses: canonUsage[f.member] || canonUsage[canonical(f.member)] || 0 }))
          .filter((f) => f.uses < rareThreshold)
          .map((f) => ({ ...f, tier: f.uses === 0 ? 'never' : 'rare' }))
          .sort((a, b) => a.uses - b.uses);
        if (trim.length) {
          trimFields.push({
            id: p.id,
            cube: p.cube,
            name: p.preAggregationName,
            hits,
            fields: trim,
            neverCount: trim.filter((f) => f.tier === 'never').length,
            rareCount: trim.filter((f) => f.tier === 'rare').length,
          });
        }
      });

      res.json({ enabled: Boolean(t), removePreAggs, trimFields });
    }));

    app.get('/playground/db-schema', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server DB Schema Load');
      const driver = await this.cubejsServer.getDriver({
        dataSource: req.body.dataSource || 'default',
        authInfo: null,
        securityContext: null,
        requestId: getRequestIdFromRequest(req),
      });

      const tablesSchema = await driver.tablesSchema();

      this.cubejsServer.event('Dev Server DB Schema Load Success');
      if (Object.keys(tablesSchema || {}).length === 0) {
        this.cubejsServer.event('Dev Server DB Schema Load Empty');
      }
      res.json({ tablesSchema });
    }));

    app.get('/playground/files', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server Files Load');
      const files = await this.cubejsServer.repository.dataSchemaFiles();
      res.json({
        files: files.map(f => ({
          ...f,
          absPath: path.resolve(path.join(this.cubejsServer.repository.localPath(), f.fileName))
        }))
      });
    }));

    app.post('/playground/generate-schema', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server Generate Schema');
      if (!req.body) {
        throw new Error('Your express app config is missing body-parser middleware. Typical config can look like: `app.use(bodyParser.json({ limit: \'50mb\' }));`');
      }

      if (!req.body.tables) {
        throw new Error('You have to select at least one table');
      }

      const dataSource = req.body.dataSource || 'default';

      const driver = await this.cubejsServer.getDriver({
        dataSource,
        authInfo: null,
        securityContext: null,
        requestId: getRequestIdFromRequest(req),
      });
      const tablesSchema = req.body.tablesSchema || (await driver.tablesSchema());

      if (!Object.values(SchemaFormat).includes(req.body.format)) {
        throw new Error(`Unknown schema format. Must be one of ${Object.values(SchemaFormat)}`);
      }

      const scaffoldingTemplate = new ScaffoldingTemplate(tablesSchema, driver, {
        format: req.body.format,
        snakeCase: true
      });
      const files = scaffoldingTemplate.generateFilesByTableNames(req.body.tables, { dataSource });

      await fs.emptyDir(path.join(options.schemaPath, 'cubes'));
      await fs.emptyDir(path.join(options.schemaPath, 'views'));

      await fs.writeFile(path.join(options.schemaPath, 'views', 'example_view.yml'), `# In Cube, views are used to expose slices of your data graph and act as data marts.
# You can control which measures and dimensions are exposed to BIs or data apps,
# as well as the direction of joins between the exposed cubes.
# You can learn more about views in documentation here - https://cube.dev/docs/schema/reference/view


# The following example shows a view defined on top of orders and customers cubes.
# Both orders and customers cubes are exposed using the "includes" parameter to
# control which measures and dimensions are exposed.
# Prefixes can also be applied when exposing measures or dimensions.
# In this case, the customers' city dimension is prefixed with the cube name,
# resulting in "customers_city" when querying the view.

# views:
#   - name: example_view
#
#     cubes:
#       - join_path: orders
#         includes:
#           - status
#           - created_date
#
#           - total_amount
#           - count
#
#       - join_path: orders.customers
#         prefix: true
#         includes:
#           - city`);
      await Promise.all(files.map(file => fs.writeFile(path.join(options.schemaPath, 'cubes', file.fileName), file.content)));

      res.json({ files });
    }));

    let lastApplyTemplatePackagesError = null;

    app.get('/playground/dashboard-app-create-status', catchErrors(async (req, res) => {
      const sourcePath = path.join(options.dashboardAppPath, 'src');

      if (lastApplyTemplatePackagesError) {
        const toThrow = lastApplyTemplatePackagesError;
        lastApplyTemplatePackagesError = null;
        throw toThrow;
      }

      if (this.applyTemplatePackagesPromise) {
        if (req.query.instant) {
          res.status(404).json({ error: 'Dashboard app creating' });
          return;
        }

        await this.applyTemplatePackagesPromise;
      }

      // docker-compose share a volume for /dashboard-app and directory will be empty
      if (!fs.pathExistsSync(options.dashboardAppPath) || fs.readdirSync(options.dashboardAppPath).length === 0) {
        res.status(404).json({
          error: `Dashboard app not found in '${path.resolve(options.dashboardAppPath)}' directory`
        });

        return;
      }

      if (!fs.pathExistsSync(sourcePath)) {
        res.status(404).json({
          error: `Dashboard app corrupted. Please remove '${path.resolve(options.dashboardAppPath)}' directory and recreate it`
        });

        return;
      }

      res.json({
        status: 'created',
        installedTemplates: AppContainer.getPackageVersions(options.dashboardAppPath)
      });
    }));

    app.get('/playground/start-dashboard-app', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server Start Dashboard App');

      if (!this.dashboardAppProcess) {
        const { dashboardAppPort = 3000 } = options;
        this.dashboardAppProcess = spawn('npm', [
          'run',
          'start',
          '--',
          '--port',
          dashboardAppPort.toString(),
          ...(isDocker() ? ['--host', '0.0.0.0'] : [])
        ], {
          cwd: options.dashboardAppPath,
          env: <any>{
            ...process.env,
            PORT: dashboardAppPort
          }
        });

        this.dashboardAppProcess.dashboardUrlPromise = new Promise((resolve) => {
          this.dashboardAppProcess.stdout.on('data', (data) => {
            console.log(data.toString());
            if (data.toString().match(/Compiled/)) {
              resolve(options.dashboardAppPort);
            }
          });
        });

        this.dashboardAppProcess.on('close', exitCode => {
          if (exitCode !== 0) {
            console.log(`Dashboard react-app failed with exit code ${exitCode}`);
            this.cubejsServer.event('Dev Server Dashboard App Failed', { exitCode });
          }
          this.dashboardAppProcess = null;
        });
      }

      await this.dashboardAppProcess.dashboardUrlPromise;
      res.json({ dashboardPort: options.dashboardAppPort });
    }));

    app.get('/playground/dashboard-app-status', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server Dashboard App Status');
      const dashboardPort = this.dashboardAppProcess && await this.dashboardAppProcess.dashboardUrlPromise;
      res.json({
        running: !!dashboardPort,
        dashboardPort,
        dashboardAppPath: path.resolve(options.dashboardAppPath)
      });
    }));

    let driverPromise: Promise<void> | null = null;
    let driverError: Error | null = null;

    app.get('/playground/driver', catchErrors(async (req: Request, res: Response) => {
      const { driver } = req.query;

      if (!driver || typeof driver !== 'string' || !DriverDependencies[driver as keyof typeof DriverDependencies]) {
        return res.status(400).json('Wrong driver');
      }

      if (packageExists(DriverDependencies[driver as keyof typeof DriverDependencies])) {
        return res.json({ status: 'installed' });
      } else if (driverPromise) {
        return res.json({ status: 'installing' });
      } else if (driverError) {
        return res.status(500).json({
          status: 'error',
          error: driverError.toString()
        });
      }

      return res.json({ status: null });
    }));

    app.post('/playground/driver', catchErrors((req, res) => {
      const { driver } = req.body;

      if (!driver || typeof driver !== 'string' || !DriverDependencies[driver as keyof typeof DriverDependencies]) {
        return res.status(400).json(`'${driver}' driver dependency not found`);
      }

      const driverKey = driver as keyof typeof DriverDependencies;

      async function installDriver() {
        driverError = null;

        try {
          await executeCommand(
            'npm',
            ['install', DriverDependencies[driverKey], '--save-dev'],
            { cwd: path.resolve('.') }
          );
        } catch (error) {
          driverError = error as Error;
        } finally {
          driverPromise = null;
        }
      }

      if (!driverPromise) {
        driverPromise = installDriver();
      }

      return res.json({
        dependency: DriverDependencies[driverKey]
      });
    }));

    app.post('/playground/apply-template-packages', catchErrors(async (req, res) => {
      this.cubejsServer.event('Dev Server Download Template Packages');

      const fetcher = process.env.TEST_TEMPLATES ? new DevPackageFetcher(repo) : new PackageFetcher(repo);

      this.cubejsServer.event('Dev Server App File Write');
      const { toApply, templateConfig } = req.body;

      const applyTemplates = async () => {
        const manifestJson = await fetcher.manifestJSON();
        const response = await fetcher.downloadPackages();

        let templatePackages: string[];
        if (typeof toApply === 'string') {
          const template = manifestJson.templates.find(({ name }) => name === toApply);
          templatePackages = template.templatePackages;
        } else {
          templatePackages = toApply;
        }

        const dt = new DependencyTree(manifestJson, templatePackages);

        const appContainer = new AppContainer(
          dt.getRootNode(),
          {
            appPath: options.dashboardAppPath,
            packagesPath: response.packagesPath
          },
          templateConfig
        );

        this.cubejsServer.event('Dev Server Create Dashboard App');
        await appContainer.applyTemplates();
        this.cubejsServer.event('Dev Server Create Dashboard App Success');

        this.cubejsServer.event('Dev Server Dashboard Npm Install');

        await appContainer.ensureDependencies();
        this.cubejsServer.event('Dev Server Dashboard Npm Install Success');

        fetcher.cleanup();
      };

      if (this.applyTemplatePackagesPromise) {
        this.applyTemplatePackagesPromise = this.applyTemplatePackagesPromise.then(applyTemplates);
      } else {
        this.applyTemplatePackagesPromise = applyTemplates();
      }
      const promise = this.applyTemplatePackagesPromise;

      promise.then(() => {
        if (promise === this.applyTemplatePackagesPromise) {
          this.applyTemplatePackagesPromise = null;
        }
      }, (err) => {
        lastApplyTemplatePackagesError = err;
        if (promise === this.applyTemplatePackagesPromise) {
          this.applyTemplatePackagesPromise = null;
        }
      });
      res.json(true); // TODO
    }));

    app.get('/playground/manifest', catchErrors(async (_, res) => {
      const fetcher = process.env.TEST_TEMPLATES ? new DevPackageFetcher(repo) : new PackageFetcher(repo);
      res.json(await fetcher.manifestJSON());
    }));

    app.get('/playground/live-preview/start/:token', catchErrors(async (req: Request, res: Response) => {
      this.livePreviewWatcher.setAuth(req.params.token);
      this.livePreviewWatcher.startWatch();

      res.setHeader('Content-Type', 'text/html');
      res.write('<html><body><script>window.close();</script></body></html>');
      res.end();
    }));

    app.get('/playground/live-preview/stop', catchErrors(async (req, res) => {
      this.livePreviewWatcher.stopWatch();
      res.json({ active: false });
    }));

    app.get('/playground/live-preview/status', catchErrors(async (req, res) => {
      const statusObj = await this.livePreviewWatcher.getStatus();
      res.json(statusObj);
    }));

    app.post('/playground/live-preview/token', catchErrors(async (req, res) => {
      const token = await this.livePreviewWatcher.createTokenWithPayload(req.body);
      res.json({ token });
    }));

    app.use(serveStatic(path.join(__dirname, '../../../playground'), {
      lastModified: false,
      etag: false,
      setHeaders: (res, url) => {
        if (url.indexOf('/index.html') !== -1) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      }
    }));

    /**
     * The `/playground/test-connection` endpoint request.
     */
    type TestConnectionRequest = {
      body: {
        dataSource?: string,
        variables: {
          [env: string]: string,
        },
      },
    };

    app.post('/playground/test-connection', catchErrors(
      async (req: TestConnectionRequest, res) => {
        const { dataSource, variables } = req.body || {};

        // With multiple data sources enabled, we need to use
        // CUBEJS_DS_<dataSource>_DB_TYPE environment variable
        // instead of CUBEJS_DB_TYPE.
        const type = keyByDataSource('CUBEJS_DB_TYPE', dataSource);

        let driver: BaseDriver | null = null;

        try {
          if (!variables || !variables[type]) {
            throw new Error(`${type} is required`);
          }

          // Backup env variables and set new ones in-place.
          // We must mutate the existing process.env object (not replace it)
          // because env-var holds a reference to the original object.
          const backup: Record<string, string | undefined> = {};

          for (const [envName, envValue] of Object.entries(variables)) {
            backup[envName] = process.env[envName];
            process.env[envName] = <string>envValue;
          }

          // With multiple data sources enabled, we need to put the dataSource
          // parameter to the driver instance to read an appropriate set of
          // driver configuration parameters. It can be undefined if multiple
          // data source is disabled.
          driver = CubejsServerCore.createDriver(
            <DatabaseType>variables[type],
            { dataSource },
          );

          // Restore original env values
          for (const [envName, envValue] of Object.entries(backup)) {
            if (envValue === undefined) {
              delete process.env[envName];
            } else {
              process.env[envName] = envValue;
            }
          }

          await driver.testConnection();

          this.cubejsServer.event('test_database_connection_success');

          return res.json('ok');
        } catch (error) {
          this.cubejsServer.event('test_database_connection_error');

          return res.status(400).json({
            error: error.toString()
          });
        } finally {
          if (driver && (<any>driver).release) {
            await (<any>driver).release();
          }
        }
      }
    ));

    app.post('/playground/env', catchErrors(async (req, res) => {
      let { variables = {} } = req.body || {};

      if (!variables.CUBEJS_API_SECRET) {
        variables.CUBEJS_API_SECRET = options.apiSecret;
      }

      let envs: Record<string, string> = {};
      const envPath = path.join(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        envs = dotenv.parse(fs.readFileSync(envPath));
      }

      const schemaPath = envs.CUBEJS_SCHEMA_PATH || process.env.CUBEJS_SCHEMA_PATH || 'model';

      variables.CUBEJS_EXTERNAL_DEFAULT = 'true';
      variables.CUBEJS_SCHEDULED_REFRESH_DEFAULT = 'true';
      variables.CUBEJS_DEV_MODE = 'true';
      variables.CUBEJS_SCHEMA_PATH = schemaPath;
      variables = Object.entries(variables).map(([key, value]) => ([key, value].join('=')));

      const repositoryPath = path.join(process.cwd(), schemaPath);

      if (!fs.existsSync(repositoryPath)) {
        fs.mkdirSync(repositoryPath);
      }

      fs.writeFileSync(path.join(process.cwd(), '.env'), variables.join('\n'));

      if (!fs.existsSync(path.join(process.cwd(), 'package.json'))) {
        fs.writeFileSync(
          path.join(process.cwd(), 'package.json'),
          JSON.stringify({
            name: 'cube-docker',
            version: '0.0.1',
            private: true,
            createdAt: new Date().toJSON(),
            dependencies: {}
          }, null, 2)
        );
      }

      dotenv.config({ override: true });

      await this.cubejsServer.resetInstanceState();

      res.status(200).json(req.body.variables || {});
    }));

    app.post('/playground/token', catchErrors(async (req, res) => {
      const { payload = {} } = req.body;
      const jwtOptions = typeof payload.exp != null ? {} : { expiresIn: '1d' };

      const token = jwt.sign(payload, options.apiSecret, jwtOptions);

      res.json({ token });
    }));

    app.post('/playground/schema/pre-aggregation', catchErrors(async (req: Request, res: Response) => {
      const { cubeName, preAggregationName, code } = req.body;

      /**
       * Important note:
       * JS code for pre-agg includes the content of the pre-aggregation object
       * without name, which is passed as preAggregationName.
       * While yaml code for pre-agg includes whole yaml object including name.
       */
      const schemaConverter = new CubeSchemaConverter(this.cubejsServer.repository, [
        new CubePreAggregationConverter({
          cubeName,
          preAggregationName,
          code
        })
      ]);

      try {
        await schemaConverter.generate(cubeName);
      } catch (error) {
        return res.status(400).json({ error: (error as Error).message || error });
      }

      const file = schemaConverter.getSourceFiles().find(
        ({ cubeName: currentCubeName }) => currentCubeName === cubeName
      );

      if (!file) {
        return res.status(400).json({ error: `The schema file for "${cubeName}" cube was not found or could not be updated. Only JS and non-templated YAML files are supported.` });
      }

      this.cubejsServer.repository.writeDataSchemaFile(file.fileName, file.source);
      return res.json('ok');
    }));
  }

  protected getIdentifier(apiSecret: string): string {
    return crypto.createHash('md5')
      .update(apiSecret)
      .digest('hex')
      .replace(/[^\d]/g, '')
      .slice(0, 10);
  }
}
