//! Typed execution values shared by transport boundaries.

/// One value produced by a logical agent during plan execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanValue {
    /// Declared delegate role.
    pub role: String,
    /// Stable logical process identity.
    pub process_id: [u8; 32],
    /// Emitted value or external operation result.
    pub value: String,
}

/// Optional host result supplied while driving a plan.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanApplyInput {
    /// Continue deterministic execution without supplying an external result.
    Continue,
    /// Result for the single currently pending external operation.
    EffectResult {
        /// Stable request identity generated inside Wasm.
        effect_id: u64,
        /// Successful value or redaction-safe failure code.
        result: Result<String, String>,
    },
}

/// Redaction-safe identity and lifecycle state for one materialized logical agent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartedAgentSummary {
    /// Stable role declared by the admitted `delegate` form.
    pub role: String,
    /// Deterministic process identity derived from the canonical plan.
    pub process_id: [u8; 32],
    /// Stable lifecycle state name.
    pub status: &'static str,
}
