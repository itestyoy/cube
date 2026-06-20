use crate::logical_plan::*;
use crate::planner::query_properties::OrderByItem;
use crate::planner::MemberSymbol;
use cubenativeutils::CubeError;
use itertools::Itertools;
use std::rc::Rc;
use typed_builder::TypedBuilder;

/// Semantic category of a multi-stage measure CTE — drives how the
/// physical builder shapes the rendered expression.
#[derive(PartialEq, Clone)]
pub enum MultiStageCalculationType {
    Rank,
    Aggregate,
    Calculate,
}

impl ToString for MultiStageCalculationType {
    fn to_string(&self) -> String {
        match self {
            MultiStageCalculationType::Rank => "Rank".to_string(),
            MultiStageCalculationType::Aggregate => "Aggregate".to_string(),
            MultiStageCalculationType::Calculate => "Calculate".to_string(),
        }
    }
}

/// Which SQL window-function flavour, if any, the calculation
/// renders as.
#[derive(PartialEq, Clone)]
pub enum MultiStageCalculationWindowFunction {
    Rank,
    Window,
    /// Running-window accumulation (`accumulate:` directive): a `Window`
    /// aggregate plus an `ORDER BY` axis and an `UNBOUNDED PRECEDING` frame.
    Accumulate,
    None,
}

impl ToString for MultiStageCalculationWindowFunction {
    fn to_string(&self) -> String {
        match self {
            MultiStageCalculationWindowFunction::Rank => "Rank".to_string(),
            MultiStageCalculationWindowFunction::Window => "Window".to_string(),
            MultiStageCalculationWindowFunction::Accumulate => "Accumulate".to_string(),
            MultiStageCalculationWindowFunction::None => "None".to_string(),
        }
    }
}

/// Measure CTE in a multi-stage chain — wraps a `FullKeyAggregate`
/// source with the partition / window function / ordering decided
/// by `calculation_type`.
#[derive(TypedBuilder)]
pub struct MultiStageMeasureCalculation {
    schema: Rc<LogicalSchema>,
    is_ungrouped: bool,
    calculation_type: MultiStageCalculationType,
    #[builder(default)]
    partition_by: Vec<Rc<MemberSymbol>>,
    window_function_to_use: MultiStageCalculationWindowFunction,
    #[builder(default)]
    order_by: Vec<OrderByItem>,
    /// Dimensions forming the `ORDER BY` axis of an `Accumulate` running
    /// window (the query dims that dropped out of `partition_by`). Empty for
    /// every other window function.
    #[builder(default)]
    accumulate_order_by: Vec<Rc<MemberSymbol>>,
    /// `ORDER BY` direction for the accumulate window: "asc" | "desc". Always
    /// set by the planner on the Accumulate path; the default is unused there.
    #[builder(default)]
    accumulate_direction: String,
    /// Cumulative-distinct accumulate (spec §14): render this calculation as a
    /// self-join of the (single) input state CTE on the accumulation axis +
    /// aggregate `hll_cardinality_merge`, instead of the normal aggregate /
    /// window. `partition_by` is the partition grid, `accumulate_order_by[0]` is
    /// the axis, `accumulate_direction` chooses `<=` (asc) / `>=` (desc).
    /// Default `false`.
    #[builder(default)]
    accumulate_merge: bool,
    source: Rc<FullKeyAggregate>,
}

impl MultiStageMeasureCalculation {
    pub fn schema(&self) -> &Rc<LogicalSchema> {
        &self.schema
    }

    pub fn is_ungrouped(&self) -> bool {
        self.is_ungrouped
    }

    pub fn calculation_type(&self) -> &MultiStageCalculationType {
        &self.calculation_type
    }

    pub fn partition_by(&self) -> &Vec<Rc<MemberSymbol>> {
        &self.partition_by
    }

    pub fn window_function_to_use(&self) -> &MultiStageCalculationWindowFunction {
        &self.window_function_to_use
    }

    pub fn order_by(&self) -> &Vec<OrderByItem> {
        &self.order_by
    }

    pub fn accumulate_order_by(&self) -> &Vec<Rc<MemberSymbol>> {
        &self.accumulate_order_by
    }

    pub fn accumulate_direction(&self) -> &String {
        &self.accumulate_direction
    }

    pub fn accumulate_merge(&self) -> bool {
        self.accumulate_merge
    }

    pub fn source(&self) -> &Rc<FullKeyAggregate> {
        &self.source
    }
}

impl PrettyPrint for MultiStageMeasureCalculation {
    fn pretty_print(&self, result: &mut PrettyPrintResult, state: &PrettyPrintState) {
        result.println(
            &format!(
                "Measure Calculation: {}",
                self.calculation_type().to_string()
            ),
            state,
        );
        let state = state.new_level();
        let details_state = state.new_level();
        result.println("schema:", &state);
        self.schema().pretty_print(result, &details_state);
        if !self.partition_by().is_empty() {
            result.println(
                &format!(
                    "partition_by: {}",
                    self.partition_by().iter().map(|m| m.full_name()).join(", ")
                ),
                &state,
            );
        }
        if self.window_function_to_use() != &MultiStageCalculationWindowFunction::None {
            result.println(
                &format!(
                    "window_function_to_use: {}",
                    self.window_function_to_use().to_string()
                ),
                &state,
            );
        }
        if self.is_ungrouped() {
            result.println("is_ungrouped: true", &state);
        }
        if !self.order_by().is_empty() {
            result.println("order_by:", &state);
            for order_by in self.order_by().iter() {
                result.println(
                    &format!(
                        "{} {}",
                        order_by.name(),
                        if order_by.desc() { "desc" } else { "asc" }
                    ),
                    &details_state,
                );
            }
        }
        result.println("source:", &state);
        self.source().pretty_print(result, &details_state);
    }
}

impl LogicalNode for MultiStageMeasureCalculation {
    fn as_plan_node(self: &Rc<Self>) -> PlanNode {
        PlanNode::MultiStageMeasureCalculation(self.clone())
    }

    fn inputs(&self) -> Vec<PlanNode> {
        vec![self.source().as_plan_node()]
    }

    fn with_inputs(self: Rc<Self>, inputs: Vec<PlanNode>) -> Result<Rc<Self>, CubeError> {
        check_inputs_len(&inputs, 1, self.node_name())?;
        let source = &inputs[0];

        Ok(Rc::new(
            Self::builder()
                .schema(self.schema().clone())
                .is_ungrouped(self.is_ungrouped())
                .calculation_type(self.calculation_type().clone())
                .partition_by(self.partition_by().clone())
                .window_function_to_use(self.window_function_to_use().clone())
                .order_by(self.order_by().clone())
                .accumulate_order_by(self.accumulate_order_by().clone())
                .accumulate_direction(self.accumulate_direction().clone())
                .accumulate_merge(self.accumulate_merge())
                .source(source.clone().into_logical_node()?)
                .build(),
        ))
    }

    fn node_name(&self) -> &'static str {
        "MultiStageMeasureCalculation"
    }

    fn try_from_plan_node(plan_node: PlanNode) -> Result<Rc<Self>, CubeError> {
        if let PlanNode::MultiStageMeasureCalculation(item) = plan_node {
            Ok(item)
        } else {
            Err(cast_error(&plan_node, "MultiStageMeasureCalculation"))
        }
    }
}
