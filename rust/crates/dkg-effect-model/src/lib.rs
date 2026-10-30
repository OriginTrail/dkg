//! Pure protected-effect state and transition rules.

/// Adapter-owned idempotency classification.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IdempotencyClass {
    /// Pure read with no protected mutation.
    PureRead,
    /// Target operation is naturally idempotent.
    NaturallyIdempotent,
    /// Target honors a stable idempotency key.
    IdempotentWithKey,
    /// Retry requires target-state reconciliation first.
    ConditionallyIdempotent,
    /// A separately authorized compensation can reverse the operation.
    Compensatable,
    /// Operation cannot be repeated safely.
    NonRepeatable,
}

/// Durable protected-effect state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutcomeState {
    /// Kernel proposed a typed effect.
    Proposed,
    /// Host authority checks are in progress.
    AuthorizationPending,
    /// Host denied the proposal.
    Denied,
    /// Host checks passed but durable preparation has not committed.
    Authorized,
    /// Authorization, digest, approval, and reservation committed.
    Prepared,
    /// Adapter invocation is beginning and outcome may become ambiguous.
    Dispatching,
    /// Adapter accepted dispatch with durable evidence.
    Dispatched,
    /// Definitive success.
    Succeeded,
    /// Definitive failure.
    Failed,
    /// Target outcome cannot currently be proved.
    Unknown,
    /// Read-only target reconciliation is in progress.
    Reconciling,
    /// Reconciliation produced a definitive target observation.
    Reconciled,
    /// A separately authorized compensation is pending.
    CompensationPending,
    /// Compensation completed.
    Compensated,
    /// Automation stopped because safety cannot be proved.
    ManualReviewRequired,
}

/// Returns whether the durable state machine admits `from -> to`.
#[must_use]
pub const fn can_transition(from: OutcomeState, to: OutcomeState) -> bool {
    use OutcomeState as S;
    matches!(
        (from, to),
        (S::Proposed, S::AuthorizationPending)
            | (S::AuthorizationPending, S::Denied | S::Authorized)
            | (S::Authorized, S::Prepared)
            | (S::Prepared, S::Dispatching)
            | (
                S::Dispatching,
                S::Dispatched | S::Succeeded | S::Failed | S::Unknown
            )
            | (S::Dispatched, S::Succeeded | S::Failed | S::Unknown)
            | (S::Unknown, S::Reconciling)
            | (S::Reconciling, S::Reconciled | S::ManualReviewRequired)
            | (
                S::Reconciled,
                S::Succeeded | S::Failed | S::ManualReviewRequired
            )
            | (S::Succeeded | S::Failed, S::CompensationPending)
            | (
                S::CompensationPending,
                S::Compensated | S::ManualReviewRequired
            )
    )
}

/// Returns whether a mutation may be dispatched from this state.
#[must_use]
pub const fn dispatch_allowed(state: OutcomeState) -> bool {
    matches!(state, OutcomeState::Prepared)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_prepared_effects_can_dispatch() {
        for state in [
            OutcomeState::Proposed,
            OutcomeState::Authorized,
            OutcomeState::Prepared,
            OutcomeState::Unknown,
            OutcomeState::Succeeded,
        ] {
            assert_eq!(dispatch_allowed(state), state == OutcomeState::Prepared);
        }
    }

    #[test]
    fn unknown_requires_reconciliation_before_any_terminal_outcome() {
        assert!(can_transition(
            OutcomeState::Unknown,
            OutcomeState::Reconciling
        ));
        assert!(!can_transition(
            OutcomeState::Unknown,
            OutcomeState::Dispatching
        ));
        assert!(!can_transition(
            OutcomeState::Unknown,
            OutcomeState::Succeeded
        ));
    }
}
