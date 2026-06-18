use crate::test_fixtures::cube_bridge::MockSchema;
use crate::test_fixtures::test_utils::TestContext;
use indoc::indoc;

fn create_context() -> TestContext {
    let schema = MockSchema::from_yaml_file("common/integration_multi_stage.yaml");
    TestContext::new(schema).unwrap()
}

const SEED: &str = "integration_multi_stage_tables.sql";

// `accumulate: { exclude: [id] }` — `id` drops out of the partition and
// becomes the ORDER BY axis, so the measure is a running total of amount over
// id within each category (PARTITION BY category ORDER BY id).
#[tokio::test(flavor = "multi_thread")]
async fn test_accumulate_exclude_id_within_category() {
    let ctx = create_context();

    let query = indoc! {r#"
        measures:
          - orders.amount_accumulate_by_id
        dimensions:
          - orders.category
          - orders.id
        order:
          - id: orders.category
          - id: orders.id
    "#};

    ctx.build_sql(query).unwrap();

    if let Some(result) = ctx.try_execute_pg(query, SEED).await {
        insta::assert_snapshot!(result);
    }
}

// With only the accumulation axis (id) in the query and nothing left for the
// partition, the running total spans the whole result set ordered by id.
#[tokio::test(flavor = "multi_thread")]
async fn test_accumulate_exclude_id_global() {
    let ctx = create_context();

    let query = indoc! {r#"
        measures:
          - orders.amount_accumulate_by_id
        dimensions:
          - orders.id
        order:
          - id: orders.id
    "#};

    ctx.build_sql(query).unwrap();

    if let Some(result) = ctx.try_execute_pg(query, SEED).await {
        insta::assert_snapshot!(result);
    }
}

// `accumulate: { keep_only: [category], direction: desc }` — category stays in
// the partition, everything else (here: status) becomes the ORDER BY axis.
#[tokio::test(flavor = "multi_thread")]
async fn test_accumulate_keep_only_category() {
    let ctx = create_context();

    let query = indoc! {r#"
        measures:
          - orders.amount_accumulate_keep_category
        dimensions:
          - orders.category
          - orders.status
        order:
          - id: orders.category
          - id: orders.status
    "#};

    ctx.build_sql(query).unwrap();

    if let Some(result) = ctx.try_execute_pg(query, SEED).await {
        insta::assert_snapshot!(result);
    }
}

// accumulate over a TIME dimension queried with a granularity. The granularity
// time dim must be recognised as the axis (granularity-agnostic match), not left
// in the partition — i.e. PARTITION BY category ORDER BY created_at(month).
#[tokio::test(flavor = "multi_thread")]
async fn test_accumulate_over_time_dimension_granularity() {
    let ctx = create_context();

    let query = indoc! {r#"
        measures:
          - orders.amount_accumulate_by_created_at
        dimensions:
          - orders.category
        time_dimensions:
          - dimension: orders.created_at
            granularity: month
            dateRange:
              - "2024-01-01"
              - "2024-03-31"
        order:
          - id: orders.category
    "#};

    ctx.build_sql(query).unwrap();

    if let Some(result) = ctx.try_execute_pg(query, SEED).await {
        insta::assert_snapshot!(result);
    }
}

// accumulate `type: max` over a `max` inner → running maximum, rendered as
// `max(max(x)) OVER (PARTITION BY category ORDER BY id ...)`.
#[tokio::test(flavor = "multi_thread")]
async fn test_accumulate_running_max() {
    let ctx = create_context();

    let query = indoc! {r#"
        measures:
          - orders.max_amount_accumulate_by_id
        dimensions:
          - orders.category
          - orders.id
        order:
          - id: orders.category
          - id: orders.id
    "#};

    ctx.build_sql(query).unwrap();

    if let Some(result) = ctx.try_execute_pg(query, SEED).await {
        insta::assert_snapshot!(result);
    }
}

// accumulate `type: min` over a `min` inner → running minimum:
// `min(min(x)) OVER (...)`.
#[tokio::test(flavor = "multi_thread")]
async fn test_accumulate_running_min() {
    let ctx = create_context();

    let query = indoc! {r#"
        measures:
          - orders.min_amount_accumulate_by_id
        dimensions:
          - orders.category
          - orders.id
        order:
          - id: orders.category
          - id: orders.id
    "#};

    ctx.build_sql(query).unwrap();

    if let Some(result) = ctx.try_execute_pg(query, SEED).await {
        insta::assert_snapshot!(result);
    }
}

// CROSS-TYPE accumulate (`type: sum` over a `max` inner) is NOT implemented —
// only matching faithful pairs (sum/sum, max/max, min/min) are allowed.
// Referencing such a measure raises an explicit not-implemented error.
#[test]
fn test_accumulate_cross_type_not_implemented() {
    let ctx = create_context();
    let err = ctx
        .create_measure("orders.sum_of_max_accumulate_by_id")
        .expect_err("cross-type accumulate (sum over max) should be not implemented");
    assert!(
        err.message.contains("not implemented"),
        "unexpected error message: {}",
        err.message
    );
}

// accumulate on an unsupported aggregation (avg) raises an explicit
// not-implemented error rather than silently falling back to a plain aggregate.
#[test]
fn test_accumulate_unsupported_type_errors() {
    let ctx = create_context();
    let err = ctx
        .create_measure("orders.avg_amount_accumulate_by_id")
        .expect_err("accumulate on type avg should be rejected as not implemented");
    assert!(
        err.message.contains("not implemented"),
        "unexpected error message: {}",
        err.message
    );
}

// `grain` and `accumulate` on the same measure are mutually exclusive (both
// reshape the inner grain/partition) — compiling such a measure errors.
#[test]
fn test_accumulate_with_grain_rejected() {
    let ctx = create_context();
    let err = ctx
        .create_measure("orders.grain_plus_accumulate_conflict")
        .expect_err("grain + accumulate on one measure should be rejected");
    assert!(
        err.message.contains("cannot be combined with `grain`"),
        "unexpected error message: {}",
        err.message
    );
}

// `accumulate` + `time_shift` on the same measure → not implemented.
#[test]
fn test_accumulate_with_time_shift_rejected() {
    let ctx = create_context();
    let err = ctx
        .create_measure("orders.ts_plus_accumulate")
        .expect_err("time_shift + accumulate should be rejected");
    assert!(
        err.message.contains("time_shift"),
        "unexpected error message: {}",
        err.message
    );
}

// `accumulate` + `rolling_window` on the same measure → not implemented.
#[test]
fn test_accumulate_with_rolling_window_rejected() {
    let ctx = create_context();
    let err = ctx
        .create_measure("orders.rw_plus_accumulate")
        .expect_err("rolling_window + accumulate should be rejected");
    assert!(
        err.message.contains("rolling_window"),
        "unexpected error message: {}",
        err.message
    );
}

// `accumulate` + `case` (switch) on the same measure → not implemented.
#[test]
fn test_accumulate_with_case_rejected() {
    let ctx = create_context();
    let err = ctx
        .create_measure("orders.case_plus_accumulate")
        .expect_err("case + accumulate should be rejected");
    assert!(
        err.message.contains("case"),
        "unexpected error message: {}",
        err.message
    );
}

// `accumulate` in an ungrouped query → not implemented (no GROUP BY → the
// double-aggregate window is undefined).
#[tokio::test(flavor = "multi_thread")]
async fn test_accumulate_ungrouped_rejected() {
    let ctx = create_context();

    let query = indoc! {r#"
        measures:
          - orders.amount_accumulate_by_id
        dimensions:
          - orders.category
          - orders.id
        ungrouped: true
    "#};

    let err = ctx
        .build_sql(query)
        .expect_err("accumulate in an ungrouped query should be rejected");
    assert!(
        err.message.contains("ungrouped"),
        "unexpected error message: {}",
        err.message
    );
}

// `filter` and `accumulate` COMPOSE (orthogonal: filter shapes the leaf WHERE,
// accumulate runs the window over the filtered result) — the measure compiles.
#[tokio::test(flavor = "multi_thread")]
async fn test_accumulate_with_filter_composes() {
    let ctx = create_context();

    let query = indoc! {r#"
        measures:
          - orders.completed_amount_accumulate_by_id
        dimensions:
          - orders.category
          - orders.id
        order:
          - id: orders.category
          - id: orders.id
    "#};

    ctx.build_sql(query).unwrap();

    if let Some(result) = ctx.try_execute_pg(query, SEED).await {
        insta::assert_snapshot!(result);
    }
}

// `accumulate.include` is intentionally not implemented — compiling a measure
// that sets it raises an explicit `not implemented` error rather than being
// silently ignored. See `build_accumulate` and spec §9.1.
#[test]
fn test_accumulate_include_not_implemented() {
    let ctx = create_context();
    let err = ctx
        .create_measure("orders.amount_accumulate_include")
        .expect_err("accumulate.include should be rejected as not implemented");
    assert!(
        err.message.contains("not implemented"),
        "unexpected error message: {}",
        err.message
    );
}

// Fallback: when the accumulation axis is not present in the query (nothing
// drops out of the partition), the measure degrades to a plain aggregate
// rather than erroring.
#[tokio::test(flavor = "multi_thread")]
async fn test_accumulate_no_axis_falls_back_to_plain() {
    let ctx = create_context();

    let query = indoc! {r#"
        measures:
          - orders.amount_accumulate_by_id
        dimensions:
          - orders.category
        order:
          - id: orders.category
    "#};

    ctx.build_sql(query).unwrap();

    if let Some(result) = ctx.try_execute_pg(query, SEED).await {
        insta::assert_snapshot!(result);
    }
}
