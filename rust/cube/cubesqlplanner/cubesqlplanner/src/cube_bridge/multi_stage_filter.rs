use super::base_query_options::FilterItem as NativeFilterItem;
use cubenativeutils::wrappers::serializer::{NativeDeserialize, NativeSerialize};
use cubenativeutils::wrappers::NativeContextHolder;
use cubenativeutils::wrappers::NativeObjectHandle;
use cubenativeutils::CubeError;
use serde::{Deserialize, Serialize};
use std::any::Any;
use std::rc::Rc;

#[derive(Serialize, Deserialize, Debug, Clone, nativebridge::NativeBridgeStatic)]
pub struct MultiStageFilterReferencesStatic {
    pub mode: Option<String>,
    #[serde(rename = "excludeReferences")]
    pub exclude: Option<Vec<String>>,
    #[serde(rename = "keepOnlyReferences")]
    pub keep_only: Option<Vec<String>>,
    pub include: Option<Vec<NativeFilterItem>>,
    // When true, the predicates dropped by `exclude` are re-applied as a
    // post-computation filter (a wrapping subquery `WHERE`) on the measure's
    // CTE — the metric is computed ignoring them, but the output rows stay
    // bounded by them. Portable (no SQL `QUALIFY`). Default false.
    pub qualify: Option<bool>,
}

#[nativebridge::native_bridge(MultiStageFilterReferencesStatic, with_static_meta)]
pub trait MultiStageFilterReferences {}
