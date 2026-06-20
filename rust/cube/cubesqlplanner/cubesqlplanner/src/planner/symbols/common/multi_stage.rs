use super::super::measure_symbol::MeasureTimeShifts;
use super::super::MemberSymbol;
use crate::cube_bridge::dimension_definition::DimensionDefinition;
use crate::cube_bridge::measure_definition::{MeasureDefinition, MeasureDefinitionStatic};
use crate::cube_bridge::multi_stage_accumulate::MultiStageAccumulateReferences;
use crate::cube_bridge::multi_stage_grain::MultiStageGrainReferences;
use crate::planner::filter::compiler::FilterCompiler;
use crate::planner::filter::FilterItem;
use crate::planner::Compiler;
use cubenativeutils::CubeError;
use std::rc::Rc;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MultiStageFilterMode {
    Relative,
    Fixed,
}

impl MultiStageFilterMode {
    fn from_str(s: &str) -> Result<Self, CubeError> {
        match s {
            "relative" => Ok(Self::Relative),
            "fixed" => Ok(Self::Fixed),
            other => Err(CubeError::user(format!(
                "Unknown multi-stage filter mode '{}', expected 'relative' or 'fixed'",
                other
            ))),
        }
    }
}

/// Compiled multi-stage `filter:` directive.
///
/// `mode` defaults to `Relative` when omitted in the user-facing schema —
/// normalized at construction time so the planner sees a single concrete
/// value. `include_*` entries are full `FilterItem` predicates split by
/// member type at construction time (using `FilterCompiler`). The split lets
/// the planner just append each bucket to the matching `QueryProperties`
/// filter list without re-classifying. They are AND-combined with whatever
/// survives `exclude` / `keep_only` against the chosen base state.
#[derive(Clone)]
pub struct MultiStageFilter {
    pub mode: MultiStageFilterMode,
    pub exclude: Option<Vec<Rc<MemberSymbol>>>,
    pub keep_only: Option<Vec<Rc<MemberSymbol>>>,
    pub include_dimension: Vec<FilterItem>,
    // Currently always empty: `FilterCompiler::add_item` only buckets
    // Dimension / Measure, so time-dim include filters land in
    // `include_dimension`. Field kept for structural symmetry with
    // `QueryProperties` (dim / time-dim / measure); will be populated once
    // `FilterCompiler` classifies time-dimension filters separately.
    pub include_time_dimension: Vec<FilterItem>,
    pub include_measure: Vec<FilterItem>,
}

/// Set operation on the inherited grain context of a multi-stage member.
///
/// The three lists mutate the parent grain — `exclude` removes,
/// `keep_only` intersects, `include` adds.
#[derive(Clone, Default)]
pub struct MultiStageGrain {
    pub exclude: Option<Vec<Rc<MemberSymbol>>>,
    pub keep_only: Option<Vec<Rc<MemberSymbol>>>,
    pub include: Option<Vec<Rc<MemberSymbol>>>,
}

/// Compiled multi-stage `accumulate:` directive — a running-window
/// accumulation over an arbitrary axis.
///
/// The partition is shaped by the same exclude / keep_only / include grain
/// rules as `grain:` (we reuse `MultiStageGrain` verbatim). The dimensions
/// that drop out of the partition become the `ORDER BY` axis of the running
/// window; `direction` chooses the order along that axis.
#[derive(Clone)]
pub struct MultiStageAccumulate {
    pub grain: MultiStageGrain,
    /// "asc" | "desc" — normalized at construction; default "asc".
    pub direction: String,
    /// Cumulative-distinct join-model (spec §14): set by the planner when the
    /// measure and its base are both `count_distinct_approx`. When `true` the
    /// running window is replaced by a self-join + aggregate `hll_cardinality_merge`
    /// (a true cumulative unique count). Default `false` (the window path).
    pub distinct: bool,
}

#[derive(Clone)]
pub struct MultiStageProperties {
    pub grain: MultiStageGrain,
    pub filter: Option<MultiStageFilter>,
    pub time_shift: Option<MeasureTimeShifts>,
    pub accumulate: Option<MultiStageAccumulate>,
}

impl MultiStageProperties {
    pub fn from_measure_definition(
        cube_name: &String,
        definition: &Rc<dyn MeasureDefinition>,
        time_shift: Option<MeasureTimeShifts>,
        compiler: &mut Compiler,
    ) -> Result<Option<Self>, CubeError> {
        if !definition.static_data().multi_stage.unwrap_or(false) {
            return Ok(None);
        }

        let grain = match definition.grain()? {
            Some(g) => build_grain_from_directive(g, compiler)?,
            None => build_grain_from_legacy(&definition.static_data(), compiler)?,
        };

        let filter = build_filter(cube_name, definition.filter()?, compiler)?;

        let accumulate = build_accumulate(definition.accumulate()?, compiler)?;
        if accumulate.is_some() {
            // `accumulate` renders a running aggregate. The window path supports
            // the idempotent/associative aggregations `sum`, `max`, `min` (plus
            // `sum` over a distinct count — a running sum of counts). The
            // cumulative-distinct join-model (spec §14) additionally supports
            // `count_distinct_approx` (over a `count_distinct_approx` base). Other
            // types (avg, number/…) are an explicit not-implemented error rather
            // than a silent fall-back. This is a coarse type gate; the precise
            // (outer, inner) eligibility is enforced in the planner
            // (`is_accumulate_eligible` / `is_accumulate_distinct`).
            let measure_type = &definition.static_data().measure_type;
            if !matches!(
                measure_type.as_str(),
                "sum"
                    | "max"
                    | "min"
                    | "count_distinct_approx"
                    | "countDistinctApprox"
            ) {
                return Err(CubeError::user(format!(
                    "Multi-stage `accumulate` is not implemented for measure type `{}` — supported types are `sum`, `max`, `min`, and `count_distinct_approx` (cumulative distinct, over a count_distinct_approx base). For a running count, use `type: sum` over a count measure.",
                    measure_type
                )));
            }

            // `accumulate` and `grain` both reshape the inner grain / partition;
            // combining them on one measure is ambiguous (they'd silently
            // override or disable each other), so it's rejected. `grain` here is
            // built from the `grain:` directive OR the legacy
            // `reduce_by`/`group_by`/`add_group_by`, so this covers both forms.
            if grain.exclude.is_some() || grain.keep_only.is_some() || grain.include.is_some() {
                return Err(CubeError::user(
                    "Multi-stage `accumulate` cannot be combined with `grain` (or the legacy `reduce_by` / `group_by` / `add_group_by`) on the same measure — both reshape the inner grain/partition and the combination is ambiguous. Use one or the other.".to_string(),
                ));
            }

            // `accumulate` is a window over the leaf result; combining it with
            // another multi-stage transform on the same measure is unsupported
            // (they'd silently override each other or produce undefined SQL):
            //  - `rolling_window` / `runningTotal`: `rolling_window` is planned
            //    first and would silently win, dropping the accumulate window.
            //  - `time_shift`: the accumulate axis vs the shifted time grain is
            //    ambiguous.
            //  - `case` (CASE-SWITCH): not a single-aggregate measure.
            if time_shift.is_some() {
                return Err(CubeError::user(
                    "Multi-stage `accumulate` cannot be combined with `time_shift` on the same measure — not implemented.".to_string(),
                ));
            }
            if definition.static_data().rolling_window.is_some() {
                return Err(CubeError::user(
                    "Multi-stage `accumulate` cannot be combined with `rolling_window` / `runningTotal` on the same measure — both are windows; not implemented.".to_string(),
                ));
            }
            if definition.case()?.is_some() {
                return Err(CubeError::user(
                    "Multi-stage `accumulate` cannot be combined with a `case` (switch) measure — not implemented.".to_string(),
                ));
            }
        }

        Ok(Some(Self {
            grain,
            filter,
            time_shift,
            accumulate,
        }))
    }

    pub fn from_dimension_definition(
        cube_name: &String,
        definition: &Rc<dyn DimensionDefinition>,
        compiler: &mut Compiler,
    ) -> Result<Option<Self>, CubeError> {
        if !definition.static_data().multi_stage.unwrap_or(false) {
            return Ok(None);
        }

        let include =
            resolve_reference_paths(&definition.static_data().add_group_by_references, compiler)?;
        let filter = build_filter(cube_name, definition.filter()?, compiler)?;

        Ok(Some(Self {
            grain: MultiStageGrain {
                include,
                ..Default::default()
            },
            filter,
            time_shift: None,
            accumulate: None,
        }))
    }

    pub fn apply_to_deps<F: Fn(&Rc<MemberSymbol>) -> Result<Rc<MemberSymbol>, CubeError>>(
        &self,
        f: &F,
    ) -> Result<Self, CubeError> {
        let map_refs = |refs: &Option<Vec<Rc<MemberSymbol>>>| -> Result<_, CubeError> {
            match refs {
                Some(items) => Ok(Some(items.iter().map(f).collect::<Result<Vec<_>, _>>()?)),
                None => Ok(None),
            }
        };

        let filter = match &self.filter {
            Some(f_old) => Some(MultiStageFilter {
                mode: f_old.mode.clone(),
                exclude: map_refs(&f_old.exclude)?,
                keep_only: map_refs(&f_old.keep_only)?,
                // include_* items are FilterItems that already hold their own
                // resolved member references; transformations of dependency
                // chains apply at the symbol level, so we keep them as-is.
                include_dimension: f_old.include_dimension.clone(),
                include_time_dimension: f_old.include_time_dimension.clone(),
                include_measure: f_old.include_measure.clone(),
            }),
            None => None,
        };

        let grain = MultiStageGrain {
            exclude: map_refs(&self.grain.exclude)?,
            keep_only: map_refs(&self.grain.keep_only)?,
            include: map_refs(&self.grain.include)?,
        };

        let accumulate = match &self.accumulate {
            Some(a) => Some(MultiStageAccumulate {
                grain: MultiStageGrain {
                    exclude: map_refs(&a.grain.exclude)?,
                    keep_only: map_refs(&a.grain.keep_only)?,
                    include: map_refs(&a.grain.include)?,
                },
                direction: a.direction.clone(),
                distinct: a.distinct,
            }),
            None => None,
        };

        Ok(Self {
            grain,
            filter,
            time_shift: self.time_shift.clone(),
            accumulate,
        })
    }
}

fn resolve_reference_paths(
    refs: &Option<Vec<String>>,
    compiler: &mut Compiler,
) -> Result<Option<Vec<Rc<MemberSymbol>>>, CubeError> {
    match refs {
        Some(paths) => {
            let symbols = paths
                .iter()
                .map(|p| compiler.add_dimension_evaluator(p.clone()))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Some(symbols))
        }
        None => Ok(None),
    }
}

fn build_grain_from_directive(
    grain: Rc<dyn MultiStageGrainReferences>,
    compiler: &mut Compiler,
) -> Result<MultiStageGrain, CubeError> {
    let static_data = grain.static_data();
    if static_data.exclude.is_some() && static_data.keep_only.is_some() {
        return Err(CubeError::user(
            "Multi-stage grain cannot specify both `exclude` and `keep_only` — they are mutually exclusive ways of restricting the inherited context.".to_string(),
        ));
    }
    Ok(MultiStageGrain {
        exclude: resolve_reference_paths(&static_data.exclude, compiler)?,
        keep_only: resolve_reference_paths(&static_data.keep_only, compiler)?,
        include: resolve_reference_paths(&static_data.include, compiler)?,
    })
}

fn build_grain_from_legacy(
    static_data: &MeasureDefinitionStatic,
    compiler: &mut Compiler,
) -> Result<MultiStageGrain, CubeError> {
    Ok(MultiStageGrain {
        exclude: resolve_reference_paths(&static_data.reduce_by_references, compiler)?,
        keep_only: resolve_reference_paths(&static_data.group_by_references, compiler)?,
        include: resolve_reference_paths(&static_data.add_group_by_references, compiler)?,
    })
}

fn build_accumulate(
    accumulate: Option<Rc<dyn MultiStageAccumulateReferences>>,
    compiler: &mut Compiler,
) -> Result<Option<MultiStageAccumulate>, CubeError> {
    let accumulate = match accumulate {
        Some(a) => a,
        None => return Ok(None),
    };

    let static_data = accumulate.static_data();
    if static_data.exclude.is_some() && static_data.keep_only.is_some() {
        return Err(CubeError::user(
            "Multi-stage accumulate cannot specify both `exclude` and `keepOnly` — they are mutually exclusive ways of restricting the inherited context.".to_string(),
        ));
    }
    // `accumulate.include` is intentionally NOT implemented: unlike
    // `grain.include` (JOIN-model broadcast), accumulating over an axis that is
    // not in the query is degenerate with the window render (it collapses to a
    // plain SUM), and `include` would also disable the window path. Accepted by
    // the schema for forward-compatibility, but surfaced as an explicit error
    // when actually used rather than silently ignored.
    if static_data
        .include
        .as_ref()
        .is_some_and(|v| !v.is_empty())
    {
        return Err(CubeError::user(
            "Multi-stage `accumulate.include` is not implemented yet — use `exclude` or `keepOnly` to choose the accumulation axis. (Accumulating over an axis absent from the query is degenerate with the window render.)".to_string(),
        ));
    }

    let direction = match static_data.direction.as_deref() {
        Some("asc") | None => "asc".to_string(),
        Some("desc") => "desc".to_string(),
        Some(other) => {
            return Err(CubeError::user(format!(
                "Unknown multi-stage accumulate direction '{}', expected 'asc' or 'desc'",
                other
            )))
        }
    };

    Ok(Some(MultiStageAccumulate {
        grain: MultiStageGrain {
            exclude: resolve_reference_paths(&static_data.exclude, compiler)?,
            keep_only: resolve_reference_paths(&static_data.keep_only, compiler)?,
            include: resolve_reference_paths(&static_data.include, compiler)?,
        },
        direction,
        // Set later by the planner (create_multi_stage_inode_member) once the
        // measure/base types are known; the directive itself can't decide it.
        distinct: false,
    }))
}

fn build_filter(
    _cube_name: &String,
    filter: Option<Rc<dyn crate::cube_bridge::multi_stage_filter::MultiStageFilterReferences>>,
    compiler: &mut Compiler,
) -> Result<Option<MultiStageFilter>, CubeError> {
    let filter = match filter {
        Some(f) => f,
        None => return Ok(None),
    };

    let static_data = filter.static_data();
    if static_data.exclude.is_some() && static_data.keep_only.is_some() {
        return Err(CubeError::user(
            "Multi-stage filter cannot specify both `exclude` and `keep_only` — they are mutually exclusive ways of restricting the inherited context.".to_string(),
        ));
    }
    let mode = match &static_data.mode {
        Some(s) => MultiStageFilterMode::from_str(s)?,
        None => MultiStageFilterMode::Relative,
    };
    let exclude = resolve_reference_paths(&static_data.exclude, compiler)?;
    let keep_only = resolve_reference_paths(&static_data.keep_only, compiler)?;

    let mut include_dimension = Vec::new();
    let mut include_time_dimension = Vec::new();
    let mut include_measure = Vec::new();
    if let Some(items) = &static_data.include {
        if !items.is_empty() {
            let query_tools = compiler.query_tools()?;
            let mut filter_compiler = FilterCompiler::new(compiler, query_tools);
            for item in items {
                filter_compiler.add_item(item)?;
            }
            let (dim, time_dim, meas) = filter_compiler.extract_result();
            include_dimension = dim;
            include_time_dimension = time_dim;
            include_measure = meas;
        }
    }

    Ok(Some(MultiStageFilter {
        mode,
        exclude,
        keep_only,
        include_dimension,
        include_time_dimension,
        include_measure,
    }))
}
