use cubenativeutils::wrappers::serializer::{NativeDeserialize, NativeSerialize};
use cubenativeutils::wrappers::NativeContextHolder;
use cubenativeutils::wrappers::NativeObjectHandle;
use cubenativeutils::CubeError;
use serde::{Deserialize, Serialize};
use std::any::Any;
use std::rc::Rc;

/// Static shape of the multi-stage `accumulate:` directive coming from the
/// schema compiler. Mirrors `MultiStageGrainReferencesStatic` (the partition
/// is shaped by the same exclude/keep_only/include sets) and adds `direction`
/// for the running-window `ORDER BY`.
#[derive(Serialize, Deserialize, Debug, Clone, nativebridge::NativeBridgeStatic)]
pub struct MultiStageAccumulateReferencesStatic {
    #[serde(rename = "excludeReferences")]
    pub exclude: Option<Vec<String>>,
    #[serde(rename = "keepOnlyReferences")]
    pub keep_only: Option<Vec<String>>,
    #[serde(rename = "includeReferences")]
    pub include: Option<Vec<String>>,
    pub direction: Option<String>,
}

#[nativebridge::native_bridge(MultiStageAccumulateReferencesStatic, with_static_meta)]
pub trait MultiStageAccumulateReferences {}
