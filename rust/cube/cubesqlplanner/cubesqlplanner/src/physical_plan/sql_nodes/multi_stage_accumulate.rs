use super::SqlNode;
use crate::physical_plan::SqlEvaluatorVisitor;
use crate::planner::query_tools::QueryTools;
use crate::planner::sql_templates::PlanSqlTemplates;
use crate::planner::MemberSymbol;
use cubenativeutils::CubeError;
use std::any::Any;
use std::rc::Rc;

/// Renders a measure as a running-window accumulation (the `accumulate:`
/// directive):
///
/// ```sql
/// SUM(SUM(x)) OVER (PARTITION BY <partition> ORDER BY <order_by> <dir>
///                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
/// ```
///
/// Structurally this is [`MultiStageWindowNode`](super::MultiStageWindowNode)
/// plus an `ORDER BY` axis and an `UNBOUNDED PRECEDING` frame. The partition
/// is the query grain minus the accumulation axis; the axis itself is the
/// `order_by`. Non-window measures go through `else_processor`.
pub struct MultiStageAccumulateNode {
    input: Rc<dyn SqlNode>,
    else_processor: Rc<dyn SqlNode>,
    partition: Vec<String>,
    order_by: Vec<String>,
    /// "asc" | "desc" — rendered uppercased on every order column.
    direction: String,
}

impl MultiStageAccumulateNode {
    pub fn new(
        input: Rc<dyn SqlNode>,
        else_processor: Rc<dyn SqlNode>,
        partition: Vec<String>,
        order_by: Vec<String>,
        direction: String,
    ) -> Rc<Self> {
        Rc::new(Self {
            input,
            else_processor,
            partition,
            order_by,
            direction,
        })
    }

    pub fn input(&self) -> &Rc<dyn SqlNode> {
        &self.input
    }

    pub fn else_processor(&self) -> &Rc<dyn SqlNode> {
        &self.else_processor
    }

    pub fn partition(&self) -> &Vec<String> {
        &self.partition
    }

    pub fn order_by(&self) -> &Vec<String> {
        &self.order_by
    }
}

impl SqlNode for MultiStageAccumulateNode {
    fn to_sql(
        &self,
        visitor: &SqlEvaluatorVisitor,
        node: &Rc<MemberSymbol>,
        query_tools: Rc<QueryTools>,
        node_processor: Rc<dyn SqlNode>,
        templates: &PlanSqlTemplates,
    ) -> Result<String, CubeError> {
        let res = match node.as_ref() {
            MemberSymbol::Measure(m) => {
                if m.is_multi_stage() && !m.is_calculated() {
                    let inner_visitor = visitor.with_arg_needs_paren_safe(false);
                    let input_sql = self.input.to_sql(
                        &inner_visitor,
                        node,
                        query_tools.clone(),
                        node_processor.clone(),
                        templates,
                    )?;

                    let partition_by = if self.partition.is_empty() {
                        "".to_string()
                    } else {
                        format!("PARTITION BY {} ", self.partition.join(", "))
                    };

                    let dir = if self.direction.eq_ignore_ascii_case("desc") {
                        "DESC"
                    } else {
                        "ASC"
                    };
                    let order_by = if self.order_by.is_empty() {
                        "".to_string()
                    } else {
                        let cols = self
                            .order_by
                            .iter()
                            .map(|c| format!("{c} {dir}"))
                            .collect::<Vec<_>>()
                            .join(", ");
                        format!("ORDER BY {cols} ")
                    };

                    // Running total: from the start of the partition up to the
                    // current axis value, in `order_by` order. `RANGE` (not
                    // `ROWS`) so that, should two rows ever share the same axis
                    // value, they get the same cumulative value rather than a
                    // physical-order-dependent partial. (For accumulate the
                    // partition+axis spans the full query grain, so the axis is
                    // unique per row and RANGE == ROWS in practice — RANGE is the
                    // defensively-correct choice for the cumulative semantic.)
                    let frame = "RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW";

                    let measure_type = m.measure_type();
                    format!(
                        "{measure_type}({measure_type}({input_sql})) OVER ({partition_by}{order_by}{frame})"
                    )
                } else {
                    self.else_processor.to_sql(
                        visitor,
                        node,
                        query_tools.clone(),
                        node_processor.clone(),
                        templates,
                    )?
                }
            }
            _ => {
                return Err(CubeError::internal(format!(
                    "Unexpected evaluation node type for MultiStageAccumulateNode"
                )));
            }
        };
        Ok(res)
    }

    fn as_any(self: Rc<Self>) -> Rc<dyn Any> {
        self.clone()
    }

    fn childs(&self) -> Vec<Rc<dyn SqlNode>> {
        vec![self.input.clone(), self.else_processor.clone()]
    }
}
