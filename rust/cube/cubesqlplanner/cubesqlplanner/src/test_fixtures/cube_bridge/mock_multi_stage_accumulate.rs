use crate::cube_bridge::multi_stage_accumulate::{
    MultiStageAccumulateReferences, MultiStageAccumulateReferencesStatic,
};
use crate::impl_static_data;
use std::any::Any;
use std::rc::Rc;
use typed_builder::TypedBuilder;

#[derive(TypedBuilder)]
pub struct MockMultiStageAccumulateReferences {
    #[builder(default)]
    exclude: Option<Vec<String>>,
    #[builder(default)]
    keep_only: Option<Vec<String>>,
    #[builder(default)]
    include: Option<Vec<String>>,
    #[builder(default)]
    direction: Option<String>,
}

impl_static_data!(
    MockMultiStageAccumulateReferences,
    MultiStageAccumulateReferencesStatic,
    exclude,
    keep_only,
    include,
    direction
);

impl MultiStageAccumulateReferences for MockMultiStageAccumulateReferences {
    crate::impl_static_data_method!(MultiStageAccumulateReferencesStatic);

    fn as_any(self: Rc<Self>) -> Rc<dyn Any> {
        self
    }
}
