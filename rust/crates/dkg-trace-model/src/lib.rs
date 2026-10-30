//! Deterministic trace records emitted by the runtime kernel.

use dkg_runtime_types::{LogicalTime, RuntimeEventId};

/// Trace classification. Numeric wire values are owned by the codec crate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TraceKind {
    /// The accumulator advanced.
    AccumulatorAdvanced,
    /// The next logical deadline changed.
    DeadlineChanged,
    /// A replayed event was already present and produced no state change.
    DuplicateIgnored,
}

/// A redaction-safe Phase 0 trace record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TraceEvent {
    /// Input event responsible for this trace.
    pub event_id: RuntimeEventId,
    /// Explicit logical time from that event.
    pub logical_time: LogicalTime,
    /// Trace classification.
    pub kind: TraceKind,
    /// Small non-secret value associated with the transition.
    pub value: u64,
}
