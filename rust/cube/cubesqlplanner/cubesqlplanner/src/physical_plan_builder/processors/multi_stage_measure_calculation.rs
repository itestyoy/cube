use super::super::context::PushDownBuilderContext;
use super::super::{LogicalNodeProcessor, ProcessableNode};
use crate::logical_plan::{MultiStageCalculationWindowFunction, MultiStageMeasureCalculation};
use crate::physical_plan::ReferencesBuilder;
use crate::physical_plan::{
    Expr, From, JoinBuilder, JoinCondition, MemberExpression, QualifiedColumnName, QueryPlan,
    SelectBuilder,
};
use crate::physical_plan::VisitorContext;
use crate::physical_plan_builder::PhysicalPlanBuilder;
use crate::planner::base_join_condition::BaseJoinCondition;
use crate::planner::sql_templates::PlanSqlTemplates;
use crate::planner::MemberSymbol;
use cubenativeutils::CubeError;
use itertools::Itertools;
use std::rc::Rc;

/// Pre-rendered join condition for the accumulate cumulative-distinct self-join
/// (spec §14). The condition SQL (partition equality + the axis `<=` / `>=`
/// comparison) is built at processing time from resolved column references, so
/// `to_sql` just returns it verbatim.
struct RawJoinCondition {
    sql: String,
}

impl BaseJoinCondition for RawJoinCondition {
    fn to_sql(
        &self,
        _context: Rc<VisitorContext>,
        _templates: &PlanSqlTemplates,
    ) -> Result<String, CubeError> {
        Ok(self.sql.clone())
    }
}

pub struct MultiStageMeasureCalculationProcessor<'a> {
    builder: &'a PhysicalPlanBuilder,
}

impl<'a> LogicalNodeProcessor<'a, MultiStageMeasureCalculation>
    for MultiStageMeasureCalculationProcessor<'a>
{
    type PhysycalNode = QueryPlan;
    fn new(builder: &'a PhysicalPlanBuilder) -> Self {
        Self { builder }
    }

    fn process(
        &self,
        measure_calculation: &MultiStageMeasureCalculation,
        context: &PushDownBuilderContext,
    ) -> Result<Self::PhysycalNode, CubeError> {
        // Cumulative distinct count (spec §14): self-join the input state CTE on
        // the axis + aggregate `hll_cardinality_merge`, instead of the normal
        // aggregate / window render.
        if measure_calculation.accumulate_merge() {
            return self.process_accumulate_merge(measure_calculation, context);
        }
        let (query_tools, templates) = self.builder.qtools_and_templates();
        let mut context_factory = context.make_sql_nodes_factory()?;
        let from = self
            .builder
            .process_node(measure_calculation.source().as_ref(), context)?;
        let references_builder = ReferencesBuilder::new(from.clone());

        let mut select_builder = SelectBuilder::new(from.clone());
        let all_dimensions = measure_calculation
            .schema()
            .all_dimensions()
            .cloned()
            .collect_vec();

        for member in measure_calculation.schema().all_dimensions() {
            references_builder.resolve_references_for_member(
                member.clone(),
                &None,
                context_factory.render_references_mut(),
            )?;
            select_builder.add_projection_member(&member, None);
        }

        for measure in measure_calculation.schema().measures.iter() {
            references_builder.resolve_references_for_member(
                measure.clone(),
                &None,
                context_factory.render_references_mut(),
            )?;
            let alias = references_builder.resolve_alias_for_member(&measure, &None);
            select_builder.add_projection_member(measure, alias);
        }

        if !measure_calculation.is_ungrouped() {
            let group_by = all_dimensions
                .iter()
                .map(|dim| -> Result<_, CubeError> {
                    Ok(Expr::Member(MemberExpression::new(dim.clone())))
                })
                .collect::<Result<Vec<_>, _>>()?;
            select_builder.set_group_by(group_by);
            select_builder.set_order_by(
                self.builder
                    .make_order_by(measure_calculation.schema(), measure_calculation.order_by())?,
            );
        }

        // Resolves a list of dimension members to their rendered SQL column
        // references (`"table"."col"`), reusing the references already built
        // for this select. Shared by partition_by and the accumulate ORDER BY.
        let resolve_dimension_refs = |members: &[Rc<MemberSymbol>],
                                      role: &str|
         -> Result<Vec<String>, CubeError> {
            members
                .iter()
                .map(|dim| -> Result<_, CubeError> {
                    if let Some(reference) =
                        references_builder.find_reference_for_member(dim, &None)
                    {
                        let table_ref = if let Some(table_name) = reference.source() {
                            format!("{}.", templates.quote_identifier(table_name)?)
                        } else {
                            format!("")
                        };
                        Ok(format!(
                            "{}{}",
                            table_ref,
                            templates.quote_identifier(&reference.name())?
                        ))
                    } else {
                        Err(CubeError::internal(format!(
                            "Alias not found for {} dimension {}",
                            role,
                            dim.full_name()
                        )))
                    }
                })
                .collect::<Result<Vec<_>, _>>()
        };

        let partition_by =
            resolve_dimension_refs(measure_calculation.partition_by().as_slice(), "partition_by")?;
        match measure_calculation.window_function_to_use() {
            MultiStageCalculationWindowFunction::Rank => {
                context_factory.set_multi_stage_rank(partition_by)
            }
            MultiStageCalculationWindowFunction::Window => {
                context_factory.set_multi_stage_window(partition_by)
            }
            MultiStageCalculationWindowFunction::Accumulate => {
                let order_by = resolve_dimension_refs(
                    measure_calculation.accumulate_order_by().as_slice(),
                    "accumulate order_by",
                )?;
                context_factory.set_multi_stage_accumulate(
                    partition_by,
                    order_by,
                    measure_calculation.accumulate_direction().clone(),
                )
            }
            MultiStageCalculationWindowFunction::None => {}
        }

        // `filter: { qualify: true }` post-filter step: re-apply the excluded
        // predicates as a `WHERE` on this (ungrouped, pass-through) CTE so the
        // output rows are bounded while the metric was computed ignoring them.
        if !measure_calculation.post_filter().is_empty() {
            let post = Some(crate::planner::filter::Filter {
                items: measure_calculation.post_filter().clone(),
            });
            references_builder
                .resolve_references_for_filter(&post, context_factory.render_references_mut())?;
            select_builder.set_filter(post);
        }

        let select = Rc::new(select_builder.build(query_tools.clone(), context_factory));
        Ok(QueryPlan::Select(select))
    }
}

impl<'a> MultiStageMeasureCalculationProcessor<'a> {
    /// Renders the cumulative-distinct accumulate (spec §14):
    /// ```sql
    /// SELECT b1.<partition…>, b1.<axis>, {{ hll_cardinality_merge(b2.<state>) }}
    /// FROM <state_cte> b1
    /// JOIN <state_cte> b2 ON <b1.p = b2.p …> AND b2.<axis> <= b1.<axis>
    /// GROUP BY b1.<partition…>, b1.<axis>
    /// ```
    /// The input state CTE holds per-bucket HLL sketches (rendered via
    /// `render_measure_as_state`); the self-join accumulates them along the axis
    /// and `count_approx_merge` wraps the result in the dialect's aggregate HLL
    /// merge — portable, no windowed HLL.
    fn process_accumulate_merge(
        &self,
        measure_calculation: &MultiStageMeasureCalculation,
        context: &PushDownBuilderContext,
    ) -> Result<QueryPlan, CubeError> {
        let (query_tools, templates) = self.builder.qtools_and_templates();

        // The single input is the state leaf CTE.
        let source_refs = measure_calculation.source().multi_stage_subquery_refs();
        let state_ref = source_refs.first().ok_or_else(|| {
            CubeError::internal("accumulate-merge expects one input state CTE".to_string())
        })?;
        let state_name = state_ref.name().clone();
        let state_schema = context.get_multi_stage_schema(&state_name)?;
        // The leaf's member is the inner measure (the per-bucket HLL sketch).
        let inner_measure = state_ref
            .symbols()
            .first()
            .ok_or_else(|| {
                CubeError::internal("accumulate-merge state CTE has no measure".to_string())
            })?
            .clone();

        // b1 supplies the output grid (one row per partition + axis value); b2 is
        // merged for every row whose axis is at-or-before b1's (asc → `<=`).
        let series_alias = "acc_series".to_string();
        let merge_alias = "acc_merge".to_string();
        let cmp = if measure_calculation
            .accumulate_direction()
            .eq_ignore_ascii_case("desc")
        {
            ">="
        } else {
            "<="
        };

        let partition = measure_calculation.partition_by();
        let axis = measure_calculation.accumulate_order_by();

        let mut conditions: Vec<String> = Vec::new();
        for dim in partition.iter() {
            let col = state_schema.resolve_member_alias(dim);
            let left = templates.column_reference(&Some(series_alias.clone()), &col)?;
            let right = templates.column_reference(&Some(merge_alias.clone()), &col)?;
            conditions.push(format!("{left} = {right}"));
        }
        for dim in axis.iter() {
            let col = state_schema.resolve_member_alias(dim);
            let b1 = templates.column_reference(&Some(series_alias.clone()), &col)?;
            let b2 = templates.column_reference(&Some(merge_alias.clone()), &col)?;
            conditions.push(format!("{b2} {cmp} {b1}"));
        }
        let condition_sql = if conditions.is_empty() {
            "1 = 1".to_string()
        } else {
            conditions.join(" AND ")
        };

        let mut join_builder = JoinBuilder::new_from_table_reference(
            state_name.clone(),
            state_schema.clone(),
            Some(series_alias.clone()),
        );
        join_builder.inner_join_table_reference(
            state_name.clone(),
            state_schema.clone(),
            Some(merge_alias.clone()),
            JoinCondition::new_base_join(Rc::new(RawJoinCondition { sql: condition_sql })),
        );
        let from = From::new_from_join(join_builder.build());

        let mut context_factory = context.make_sql_nodes_factory()?;
        context_factory.set_count_approx_merge(true);

        let references_builder = ReferencesBuilder::new(from.clone());
        let mut select_builder = SelectBuilder::new(from.clone());

        // Project the partition + axis dimensions from the series side (b1).
        let grid = partition.iter().chain(axis.iter()).cloned().collect_vec();
        for dim in grid.iter() {
            references_builder.resolve_references_for_member(
                dim.clone(),
                &Some(series_alias.clone()),
                context_factory.render_references_mut(),
            )?;
            let alias =
                references_builder.resolve_alias_for_member(dim, &Some(series_alias.clone()));
            select_builder.add_projection_member(dim, alias);
        }

        // Project the measure as `hll_cardinality_merge(b2.<inner state>)`: point
        // the (outer) measure at the merge-side state column, and let the
        // `count_approx_merge` node apply the aggregate HLL merge.
        let inner_state_col = state_schema.resolve_member_alias(&inner_measure);
        for measure in measure_calculation.schema().measures.iter() {
            context_factory.add_ungrouped_measure_reference(
                measure.full_name(),
                QualifiedColumnName::new(Some(merge_alias.clone()), inner_state_col.clone()),
            );
            let alias = references_builder.resolve_alias_for_member(measure, &None);
            select_builder.add_projection_member(measure, alias);
        }

        // Aggregate the merge per output grid row.
        let group_by = grid
            .iter()
            .map(|dim| Expr::Member(MemberExpression::new(dim.clone())))
            .collect::<Vec<_>>();
        select_builder.set_group_by(group_by);

        let select = Rc::new(select_builder.build(query_tools.clone(), context_factory));
        Ok(QueryPlan::Select(select))
    }
}

impl ProcessableNode for MultiStageMeasureCalculation {
    type ProcessorType<'a> = MultiStageMeasureCalculationProcessor<'a>;
}
