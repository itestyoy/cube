/**
 * Unified pre-aggregation recommendation engine.
 *
 * Pure (no IO): DevServer fetches the workload (query shapes from telemetry),
 * the defined pre-aggregations, member usage and additivity (from meta), then
 * this module turns them into a single ranked list of *actions*:
 *
 *   - create : build a new rollup that covers a cluster of unaccelerated shapes
 *   - edit   : add and/or drop members on an existing rollup (extend + trim,
 *              reconciled into one coherent change)
 *   - fix    : a rollup covers the shape's members but didn't accelerate it —
 *              with the concrete reason (granularity / non-additive / segment)
 *   - drop   : a defined rollup with no usage in the window
 *
 * Each action carries benefitMs (data-source time addressed), confidence
 * (0..1, from execution volume) and a combined score used for ranking. Cost
 * (cardinality/build) is intentionally NOT modelled yet — there's a `cost`
 * field reserved on actions so it can be folded into the score later without a
 * signature change.
 */

export type ShapeMembers = {
  measures: string[];
  dimensions: string[];
  /** time dimensions as "dimension:granularity" (granularity may be absent). */
  timeDimensions: string[];
  filters: string[];
  segments?: string[];
};

export type WorkloadShape = {
  queryHash: string;
  shape: ShapeMembers;
  executions: number;
  avgMs: number;
  totalMs: number;
  /** fraction (0..100) of executions that were accelerated. */
  hitRate: number;
  lastSeen: string | null;
};

export type RollupDef = {
  id: string;
  cube: string;
  name: string;
  /** canonicalized cube members. */
  dimensions: Set<string>;
  measures: Set<string>;
  timeDimensions: string[];
  granularity: string | null;
  hits: number;
  buildCount: number;
  avgBuildMs: number | null;
};

export type Thresholds = {
  /** a shape is a candidate only if avgMs >= this (ms). */
  slownessMs: number;
  /** a member is "rare" inside a rollup when uses < this. */
  rarityUses: number;
  /** confidence saturates at this execution count. */
  confidenceAt: number;
};

export type Action = {
  type: 'create' | 'edit' | 'fix' | 'drop' | 'reorder';
  rollup?: string;
  cube?: string;
  proposedName?: string;
  add?: { member: string; kind: string }[];
  remove?: { member: string; kind: string; uses: number }[];
  granularity?: string | null;
  reason?: string;
  /** reorder: id/name of the larger rollup this one should be moved before. */
  reorderBefore?: string;
  reorderBeforeName?: string;
  benefitMs: number;
  executions: number;
  shapesCovered: number;
  confidence: number;
  score: number;
  cost: number | null;
  detail: string;
  sampleHash?: string;
};

const GRAN_RANK: Record<string, number> = {
  second: 1, minute: 2, hour: 3, day: 4, week: 5, month: 6, quarter: 7, year: 8,
};

/** Split a "dimension:granularity" time-dimension token. */
function splitTd(td: string): { dim: string; gran: string | null } {
  const i = String(td).indexOf(':');
  return i >= 0 ? { dim: td.slice(0, i), gran: td.slice(i + 1) } : { dim: td, gran: null };
}

/**
 * Can a rollup materialized at granularity `rg` serve a query needing `qg`?
 * A finer rollup can roll *up* to a coarser query for additive measures; week
 * doesn't nest cleanly into months so it's only served by itself.
 */
function granularityServes(rg: string | null, qg: string | null, additive: boolean): boolean {
  if (!qg) return true;              // query has no granularity constraint
  if (!rg) return false;             // query needs a granularity, rollup has none
  if (rg === qg) return true;
  if (!additive) return false;       // non-additive: must match exactly
  if (rg === 'week' || qg === 'week') return false;
  const r = GRAN_RANK[rg]; const q = GRAN_RANK[qg];
  return r != null && q != null && r <= q; // finer-or-equal rolls up
}

/** Canonical members a shape wants, by kind (time dims keyed by base dimension). */
function shapeWants(shape: ShapeMembers, canonical: (m: string) => string) {
  const dims = new Set<string>((shape.dimensions || []).map(canonical));
  const measures = new Set<string>((shape.measures || []).map(canonical));
  const tds = (shape.timeDimensions || []).map((t) => {
    const { dim, gran } = splitTd(t);
    return { dim: canonical(dim), gran };
  });
  tds.forEach((t) => dims.add(t.dim));
  const segments = new Set<string>((shape.segments || []).map(canonical));
  return { dims, measures, tds, segments };
}

/**
 * Does `rollup` serve `shape`? Granularity- and additivity-aware. Returns the
 * verdict plus, when it does NOT, the reason and the missing members (so the
 * caller can suggest a fix or an extend).
 */
export function serves(
  rollup: RollupDef,
  shape: ShapeMembers,
  canonical: (m: string) => string,
  additive: (m: string) => boolean,
): { ok: boolean; reason?: string; missing: { member: string; kind: string }[] } {
  const want = shapeWants(shape, canonical);
  const missing: { member: string; kind: string }[] = [];
  want.dims.forEach((d) => { if (!rollup.dimensions.has(d)) missing.push({ member: d, kind: 'dimension' }); });
  want.measures.forEach((m) => { if (!rollup.measures.has(m)) missing.push({ member: m, kind: 'measure' }); });

  const hasNonAdditive = Array.from(want.measures).some((m) => !additive(m));
  // Non-additive measures can't be rolled up across dimensions the rollup has
  // but the query doesn't group by — require the rollup's grain to match.
  const extraDims = Array.from(rollup.dimensions).filter((d) => !want.dims.has(d) && !rollup.timeDimensions.includes(d));

  // Time-dimension / granularity check.
  let granOk = true;
  want.tds.forEach((t) => {
    const ok = (rollup.timeDimensions || []).some((rtd) => {
      const r = splitTd(rtd);
      return canonical(r.dim) === t.dim && granularityServes(rollup.granularity || r.gran, t.gran, !hasNonAdditive);
    }) || (rollup.timeDimensions.length === 0 && granularityServes(rollup.granularity, t.gran, !hasNonAdditive));
    if (!ok) granOk = false;
  });

  if (missing.length) {
    return { ok: false, reason: 'members', missing };
  }
  if (!granOk) {
    return { ok: false, reason: 'granularity', missing: [] };
  }
  if (hasNonAdditive && extraDims.length) {
    return { ok: false, reason: 'non-additive', missing: [] };
  }
  if (want.segments.size) {
    // We don't track segments on rollups reliably — flag as a soft fix reason.
    return { ok: true, reason: 'segment?', missing: [] };
  }
  return { ok: true, missing: [] };
}

/** Confidence from execution volume, saturating at thresholds.confidenceAt. */
function confidenceOf(executions: number, at: number): number {
  if (at <= 0) return 1;
  return Math.min(1, executions / at);
}

/** Percentile of a numeric array (linear, value at rank). */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Greedy clustering of unaccelerated, unserved shapes into proposed rollups.
 * Shapes join an existing cluster when they share the same time dimension and
 * the merge doesn't add more than `maxNewDims` dimensions (keeps the proposed
 * rollup cohesive); otherwise they seed a new cluster. Each cluster becomes one
 * CREATE action covering the union of members at the finest granularity.
 */
function clusterCreate(
  shapes: { ws: WorkloadShape; want: ReturnType<typeof shapeWants> }[],
  canonical: (m: string) => string,
  thresholds: Thresholds,
  maxNewDims = 2,
): Action[] {
  type Cluster = {
    dims: Set<string>; measures: Set<string>; timeDim: string | null; gran: string | null;
    benefitMs: number; executions: number; shapes: number; sampleHash: string; cube: string;
  };
  const clusters: Cluster[] = [];
  // Heaviest shapes first so clusters form around the biggest wins.
  const sorted = [...shapes].sort((a, b) => b.ws.totalMs - a.ws.totalMs);
  for (const { ws, want } of sorted) {
    const td = want.tds[0] || null;
    const timeDim = td ? td.dim : null;
    const gran = td ? td.gran : null;
    let target: Cluster | null = null;
    for (const c of clusters) {
      if (c.timeDim !== timeDim) continue;
      const newDims = Array.from(want.dims).filter((d) => !c.dims.has(d)).length;
      if (newDims <= maxNewDims) { target = c; break; }
    }
    if (!target) {
      const cube = (Array.from(want.measures)[0] || Array.from(want.dims)[0] || '').split('.')[0] || 'model';
      target = { dims: new Set(), measures: new Set(), timeDim, gran, benefitMs: 0, executions: 0, shapes: 0, sampleHash: ws.queryHash, cube };
      clusters.push(target);
    }
    want.dims.forEach((d) => target!.dims.add(d));
    want.measures.forEach((m) => target!.measures.add(m));
    // Finest granularity across the cluster wins.
    if (gran && (!target.gran || (GRAN_RANK[gran] || 99) < (GRAN_RANK[target.gran] || 99))) target.gran = gran;
    target.benefitMs += ws.totalMs;
    target.executions += ws.executions;
    target.shapes += 1;
  }
  return clusters.map((c) => {
    const confidence = confidenceOf(c.executions, thresholds.confidenceAt);
    const add = [
      ...Array.from(c.measures).map((m) => ({ member: m, kind: 'measure' })),
      ...Array.from(c.dims).map((d) => ({ member: d, kind: 'dimension' })),
    ];
    return {
      type: 'create' as const,
      cube: c.cube,
      proposedName: `rollup_${c.dims.size}d_${c.measures.size}m`,
      add,
      granularity: c.gran,
      benefitMs: c.benefitMs,
      executions: c.executions,
      shapesCovered: c.shapes,
      confidence,
      score: c.benefitMs * confidence,
      cost: null,
      detail: `New rollup covering ${c.shapes} unaccelerated query shape(s): ${c.measures.size} measure(s), ${c.dims.size} dimension(s)${c.gran ? ` at ${c.gran}` : ''}.`,
      sampleHash: c.sampleHash,
    };
  });
}

export type EngineInput = {
  shapes: WorkloadShape[];
  rollups: RollupDef[];
  memberUsage: Record<string, number>;
  canonical: (m: string) => string;
  additive: (m: string) => boolean;
  /** percentile knobs the UI can vary; defaults computed if absent. */
  slownessPct?: number;   // default 0.9
  rarityPct?: number;     // default 0.1 (of rollup member usage)
};

export type EngineOutput = {
  thresholds: Thresholds & { slownessPct: number; rarityPct: number };
  actions: Action[];
};

export function buildRecommendations(input: EngineInput): EngineOutput {
  const { shapes, rollups, memberUsage, canonical, additive } = input;
  const slownessPct = input.slownessPct ?? 0.9;
  const rarityPct = input.rarityPct ?? 0.1;

  // ---- thresholds from the workload distribution (no magic numbers) --------
  const avgDurations = shapes.flatMap((s) => Array(Math.max(1, Math.min(s.executions, 50))).fill(s.avgMs));
  const slownessMs = percentile(avgDurations, slownessPct);
  const execCounts = shapes.map((s) => s.executions);
  const confidenceAt = Math.max(3, percentile(execCounts, 0.5)); // median executions
  const usageValues = Object.values(memberUsage);
  const rarityUses = Math.max(1, Math.ceil(percentile(usageValues, rarityPct)));
  const thresholds: Thresholds = { slownessMs, rarityUses, confidenceAt };

  const actions: Action[] = [];

  // ---- shapes that are slow AND not currently accelerated ------------------
  const candidateShapes = shapes
    .filter((s) => s.hitRate < 100 && s.avgMs >= slownessMs)
    .map((s) => ({ ws: s, want: shapeWants(s.shape, canonical) }));

  // Bucket each candidate: served-by an existing rollup (fix), extendable
  // (members missing from the best rollup), or uncovered (cluster → create).
  const toCluster: typeof candidateShapes = [];
  const extendByRollup = new Map<string, { add: Map<string, string>; benefitMs: number; executions: number; shapes: number; sampleHash: string }>();

  for (const cand of candidateShapes) {
    let bestExtend: { rollup: RollupDef; missing: { member: string; kind: string }[] } | null = null;
    let fixReason: string | null = null;
    let fixRollup: RollupDef | null = null;

    for (const r of rollups) {
      const v = serves(r, cand.ws.shape, canonical, additive);
      if (v.ok) { fixReason = v.reason || 'check refresh'; fixRollup = r; bestExtend = null; break; }
      if (v.reason === 'members') {
        // Extendable if all *missing* are few relative to what's already there.
        const wantCount = cand.want.dims.size + cand.want.measures.size;
        const coverage = wantCount ? (wantCount - v.missing.length) / wantCount : 0;
        if (coverage >= 0.5 && (!bestExtend || v.missing.length < bestExtend.missing.length)) {
          bestExtend = { rollup: r, missing: v.missing };
        }
      }
    }

    if (fixRollup) {
      const confidence = confidenceOf(cand.ws.executions, confidenceAt);
      actions.push({
        type: 'fix',
        rollup: fixRollup.id,
        cube: fixRollup.cube,
        reason: fixReason || 'unknown',
        benefitMs: cand.ws.totalMs,
        executions: cand.ws.executions,
        shapesCovered: 1,
        confidence,
        score: cand.ws.totalMs * confidence,
        cost: null,
        detail: fixReason === 'granularity'
          ? `Rollup ${fixRollup.name} covers these members but its granularity is coarser than the query needs.`
          : fixReason === 'non-additive'
            ? `Rollup ${fixRollup.name} has a non-additive measure and extra dimensions — it can't roll up to this query.`
            : fixReason === 'segment?'
              ? `Query uses a segment not materialized by ${fixRollup.name}.`
              : `Rollup ${fixRollup.name} covers the members but didn't accelerate — check refreshKey / indexes.`,
        sampleHash: cand.ws.queryHash,
      });
    } else if (bestExtend) {
      const key = bestExtend.rollup.id;
      const acc = extendByRollup.get(key) || { add: new Map(), benefitMs: 0, executions: 0, shapes: 0, sampleHash: cand.ws.queryHash };
      bestExtend.missing.forEach((m) => acc.add.set(m.member, m.kind));
      acc.benefitMs += cand.ws.totalMs;
      acc.executions += cand.ws.executions;
      acc.shapes += 1;
      extendByRollup.set(key, acc);
    } else {
      toCluster.push(cand);
    }
  }

  // ---- CREATE: cluster the uncovered shapes --------------------------------
  actions.push(...clusterCreate(toCluster, canonical, thresholds));

  // ---- EDIT: reconcile extend (+fields) with trim (−rare fields) -----------
  rollups.forEach((r) => {
    const ext = extendByRollup.get(r.id);
    const add = ext ? Array.from(ext.add.entries()).map(([member, kind]) => ({ member, kind })) : [];

    // Trim: rollup members queried in fewer than rarityUses of the window.
    const usesOf = (m: string) => memberUsage[m] ?? memberUsage[canonical(m)] ?? 0;
    const remove: { member: string; kind: string; uses: number }[] = [];
    if (r.hits > 0) {
      r.measures.forEach((m) => { const u = usesOf(m); if (u < thresholds.rarityUses) remove.push({ member: m, kind: 'measure', uses: u }); });
      r.dimensions.forEach((d) => { if (!r.timeDimensions.includes(d)) { const u = usesOf(d); if (u < thresholds.rarityUses) remove.push({ member: d, kind: 'dimension', uses: u }); } });
    }

    if (!add.length && !remove.length) return;
    const benefitMs = ext ? ext.benefitMs : 0;
    const executions = ext ? ext.executions : 0;
    const confidence = ext ? confidenceOf(executions, confidenceAt) : 0.5;
    const parts: string[] = [];
    if (add.length) parts.push(`add ${add.length} field(s) to serve ${ext!.shapes} slow shape(s)`);
    if (remove.length) parts.push(`drop ${remove.length} rarely/never-used field(s)`);
    actions.push({
      type: 'edit',
      rollup: r.id,
      cube: r.cube,
      add,
      remove,
      benefitMs,
      executions,
      shapesCovered: ext ? ext.shapes : 0,
      confidence,
      score: benefitMs * confidence + remove.length * 1, // trims have small intrinsic value
      cost: null,
      detail: `Edit ${r.name}: ${parts.join('; ')}.`,
      sampleHash: ext ? ext.sampleHash : undefined,
    });
  });

  // ---- DROP: defined rollups with no usage in the window -------------------
  rollups.forEach((r) => {
    if (r.hits > 0) return;
    actions.push({
      type: 'drop',
      rollup: r.id,
      cube: r.cube,
      benefitMs: 0,
      executions: 0,
      shapesCovered: 0,
      confidence: r.buildCount > 0 ? 1 : 0.5,
      score: 0,
      cost: null,
      detail: r.buildCount > 0
        ? `Built ${r.buildCount}× but never used in this window — costs build time/storage for nothing.`
        : 'No usage and no builds in this window.',
    });
  });

  // ---- REORDER: Cube uses the FIRST covering rollup in declaration order ----
  // If a smaller rollup that also covers the query is declared later, Cube
  // scans a bigger rollup than necessary. Recommend moving the smaller one
  // earlier. Only for shapes Cube already accelerates (hitRate > 0).
  const rollupSize = (r: RollupDef) => r.dimensions.size + r.measures.size;
  const orderIndex = new Map(rollups.map((r, i) => [r.id, i] as const));
  const reorderMap = new Map<string, { used: RollupDef; smaller: RollupDef; benefitMs: number; executions: number; shapes: number; sampleHash: string }>();
  for (const s of shapes) {
    if (s.hitRate <= 0) continue;
    const servers = rollups.filter((r) => serves(r, s.shape, canonical, additive).ok);
    if (servers.length < 2) continue;
    // What Cube picks today: earliest in declaration order.
    const used = servers.reduce((a, b) => ((orderIndex.get(b.id) ?? 0) < (orderIndex.get(a.id) ?? 0) ? b : a));
    // Smallest covering rollup (fewest members), tie-break earliest.
    const smaller = servers.reduce((a, b) => {
      const d = rollupSize(b) - rollupSize(a);
      return d < 0 || (d === 0 && (orderIndex.get(b.id) ?? 0) < (orderIndex.get(a.id) ?? 0)) ? b : a;
    });
    if (smaller.id === used.id) continue;
    if (rollupSize(smaller) >= rollupSize(used)) continue;
    if (used.cube !== smaller.cube) continue; // declaration order is per-cube
    const key = `${used.id}>>${smaller.id}`;
    const acc = reorderMap.get(key) || { used, smaller, benefitMs: 0, executions: 0, shapes: 0, sampleHash: s.queryHash };
    acc.benefitMs += s.totalMs;
    acc.executions += s.executions;
    acc.shapes += 1;
    reorderMap.set(key, acc);
  }
  reorderMap.forEach((v) => {
    const confidence = confidenceOf(v.executions, confidenceAt);
    actions.push({
      type: 'reorder',
      rollup: v.smaller.id,
      cube: v.smaller.cube,
      reorderBefore: v.used.id,
      reorderBeforeName: v.used.name,
      benefitMs: v.benefitMs,
      executions: v.executions,
      shapesCovered: v.shapes,
      confidence,
      score: v.benefitMs * confidence,
      cost: null,
      detail: `Cube uses the larger ${v.used.name} (${rollupSize(v.used)} members) for ${v.shapes} query shape(s) that the smaller ${v.smaller.name} (${rollupSize(v.smaller)} members) also covers — because it's declared earlier. Move ${v.smaller.name} before ${v.used.name} so Cube picks the cheaper rollup.`,
      sampleHash: v.sampleHash,
    });
  });

  actions.sort((a, b) => b.score - a.score);
  return { thresholds: { ...thresholds, slownessPct, rarityPct }, actions };
}
