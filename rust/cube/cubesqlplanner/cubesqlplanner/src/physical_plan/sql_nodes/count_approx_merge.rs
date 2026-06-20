use super::SqlNode;
use crate::physical_plan::SqlEvaluatorVisitor;
use crate::planner::query_tools::QueryTools;
use crate::planner::sql_templates::PlanSqlTemplates;
use crate::planner::symbols::{AggregationType, MeasureKind};
use crate::planner::MemberSymbol;
use cubenativeutils::CubeError;
use std::any::Any;
use std::rc::Rc;

/// Renders a `count_distinct_approx` measure as an **aggregate** HLL merge —
/// `{{ hll_cardinality_merge(<state>) }}` — for the `accumulate` join-model
/// (the cumulative-distinct path, see the accumulate spec §14). The inner
/// `<state>` is the per-bucket HLL sketch produced by the leaf
/// (`render_measure_as_state` → `hll_init`); merging the sketches with an
/// aggregate (not a window) keeps the running distinct count **portable** —
/// BigQuery `HLL_COUNT.MERGE`, Snowflake `HLL_ESTIMATE(HLL_COMBINE(..))`, etc.,
/// all via the existing `hll_cardinality_merge` dialect template.
///
/// Structurally this is [`RollingWindowNode`](super::RollingWindowNode)'s
/// count-distinct-approx branch, but **not** gated on `is_cumulative()` — it is
/// switched on explicitly by the factory flag `count_approx_merge` (set only by
/// the accumulate-merge processor). Every other measure falls through to
/// `default_processor`.
pub struct CountApproxMergeNode {
    input: Rc<dyn SqlNode>,
    default_processor: Rc<dyn SqlNode>,
}

impl CountApproxMergeNode {
    pub fn new(input: Rc<dyn SqlNode>, default_processor: Rc<dyn SqlNode>) -> Rc<Self> {
        Rc::new(Self {
            input,
            default_processor,
        })
    }

    pub fn input(&self) -> &Rc<dyn SqlNode> {
        &self.input
    }
}

impl SqlNode for CountApproxMergeNode {
    fn to_sql(
        &self,
        visitor: &SqlEvaluatorVisitor,
        node: &Rc<MemberSymbol>,
        query_tools: Rc<QueryTools>,
        node_processor: Rc<dyn SqlNode>,
        templates: &PlanSqlTemplates,
    ) -> Result<String, CubeError> {
        let res = match node.as_ref() {
            MemberSymbol::Measure(m)
                if matches!(
                    m.kind(),
                    MeasureKind::Aggregated(a)
                        if a.agg_type() == AggregationType::CountDistinctApprox
                ) =>
            {
                let inner_visitor = visitor.with_arg_needs_paren_safe(false);
                let input_sql = self.input.to_sql(
                    &inner_visitor,
                    node,
                    query_tools.clone(),
                    node_processor.clone(),
                    templates,
                )?;
                templates.hll_cardinality_merge(input_sql)?
            }
            _ => self.default_processor.to_sql(
                visitor,
                node,
                query_tools.clone(),
                node_processor.clone(),
                templates,
            )?,
        };
        Ok(res)
    }

    fn as_any(self: Rc<Self>) -> Rc<dyn Any> {
        self.clone()
    }

    fn childs(&self) -> Vec<Rc<dyn SqlNode>> {
        vec![self.input.clone(), self.default_processor.clone()]
    }
}
