//! A small deterministic reducer used by the Phase 0 Wasm boundary spike.
//!
//! This crate owns explicit state and has no ambient clock, randomness,
//! filesystem, network, process, credential, or asynchronous runtime access.

use std::collections::BTreeSet;

use dkg_runtime_types::{
    ConfigError, LogicalTime, RuntimeConfig, RuntimeEvent, RuntimeEventId, RuntimePartitionId,
};
use dkg_trace_model::{TraceEvent, TraceKind};
use sha2::{Digest, Sha256};

mod supervised;

pub use supervised::*;

/// Mutable state owned by one Wasm runtime handle.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeState {
    config: RuntimeConfig,
    applied_events: u32,
    accumulator: u64,
    last_logical_time: LogicalTime,
    next_deadline: Option<LogicalTime>,
    seen_event_ids: BTreeSet<RuntimeEventId>,
}

impl RuntimeState {
    /// Creates empty state after validating all host-controlled limits.
    pub fn new(config: RuntimeConfig) -> Result<Self, RuntimeError> {
        config.validate().map_err(RuntimeError::from)?;
        Ok(Self {
            config,
            applied_events: 0,
            accumulator: 0,
            last_logical_time: LogicalTime(0),
            next_deadline: None,
            seen_event_ids: BTreeSet::new(),
        })
    }

    /// Restores validated state decoded by the codec crate.
    #[allow(clippy::too_many_arguments)]
    pub fn restore(
        config: RuntimeConfig,
        applied_events: u32,
        accumulator: u64,
        last_logical_time: LogicalTime,
        next_deadline: Option<LogicalTime>,
        seen_event_ids: BTreeSet<RuntimeEventId>,
    ) -> Result<Self, RuntimeError> {
        config.validate().map_err(RuntimeError::from)?;
        let seen_event_count =
            u32::try_from(seen_event_ids.len()).map_err(|_| RuntimeError::SnapshotInvariant)?;
        if applied_events != seen_event_count || applied_events > config.max_events {
            return Err(RuntimeError::SnapshotInvariant);
        }
        if accumulator > config.max_accumulator {
            return Err(RuntimeError::SnapshotInvariant);
        }
        if next_deadline.is_some_and(|deadline| deadline < last_logical_time) {
            return Err(RuntimeError::SnapshotInvariant);
        }
        Ok(Self {
            config,
            applied_events,
            accumulator,
            last_logical_time,
            next_deadline,
            seen_event_ids,
        })
    }

    /// Applies one explicit event and returns deterministic output.
    pub fn apply_event(&mut self, event: &RuntimeEvent) -> Result<StepOutput, RuntimeError> {
        let event_id = event.event_id();
        let logical_time = event.logical_time();
        if self.seen_event_ids.contains(&event_id) {
            return Ok(self.output(vec![TraceEvent {
                event_id,
                logical_time,
                kind: TraceKind::DuplicateIgnored,
                value: self.accumulator,
            }]));
        }
        if logical_time < self.last_logical_time {
            return Err(RuntimeError::LogicalTimeRegressed);
        }
        if self.applied_events >= self.config.max_events {
            return Err(RuntimeError::EventLimitExceeded);
        }

        let trace = match event {
            RuntimeEvent::Advance { delta, .. } => {
                let next = self
                    .accumulator
                    .checked_add(*delta)
                    .ok_or(RuntimeError::AccumulatorLimitExceeded)?;
                if next > self.config.max_accumulator {
                    return Err(RuntimeError::AccumulatorLimitExceeded);
                }
                self.accumulator = next;
                TraceEvent {
                    event_id,
                    logical_time,
                    kind: TraceKind::AccumulatorAdvanced,
                    value: next,
                }
            }
            RuntimeEvent::SetDeadline { deadline, .. } => {
                if deadline.is_some_and(|value| value < logical_time) {
                    return Err(RuntimeError::DeadlineBeforeEventTime);
                }
                self.next_deadline = *deadline;
                TraceEvent {
                    event_id,
                    logical_time,
                    kind: TraceKind::DeadlineChanged,
                    value: deadline.map_or(0, |value| value.0),
                }
            }
        };

        self.last_logical_time = logical_time;
        self.seen_event_ids.insert(event_id);
        self.applied_events += 1;
        Ok(self.output(vec![trace]))
    }

    fn output(&self, trace_events: Vec<TraceEvent>) -> StepOutput {
        StepOutput {
            applied_events: self.applied_events,
            accumulator: self.accumulator,
            next_deadline: self.next_deadline,
            state_digest: self.state_digest(),
            trace_events,
            yielded: false,
        }
    }

    /// Returns a deterministic digest of all replay-relevant state.
    #[must_use]
    pub fn state_digest(&self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(b"DKG-SEMANTIC-RUNTIME-PHASE0-STATE-V1\0");
        hasher.update(self.config.partition_id.bytes());
        hasher.update(self.config.max_events.to_be_bytes());
        hasher.update(self.config.max_accumulator.to_be_bytes());
        hasher.update(self.applied_events.to_be_bytes());
        hasher.update(self.accumulator.to_be_bytes());
        hasher.update(self.last_logical_time.0.to_be_bytes());
        match self.next_deadline {
            Some(deadline) => {
                hasher.update([1]);
                hasher.update(deadline.0.to_be_bytes());
            }
            None => hasher.update([0]),
        }
        for event_id in &self.seen_event_ids {
            hasher.update(event_id.bytes());
        }
        hasher.finalize().into()
    }

    /// Runtime configuration.
    #[must_use]
    pub const fn config(&self) -> &RuntimeConfig {
        &self.config
    }

    /// Number of unique applied events.
    #[must_use]
    pub const fn applied_events(&self) -> u32 {
        self.applied_events
    }

    /// Current probe accumulator.
    #[must_use]
    pub const fn accumulator(&self) -> u64 {
        self.accumulator
    }

    /// Latest admitted logical time.
    #[must_use]
    pub const fn last_logical_time(&self) -> LogicalTime {
        self.last_logical_time
    }

    /// Next logical deadline, if any.
    #[must_use]
    pub const fn next_deadline(&self) -> Option<LogicalTime> {
        self.next_deadline
    }

    /// Stable ordered event identities needed for replay deduplication.
    pub fn seen_event_ids(&self) -> impl ExactSizeIterator<Item = RuntimeEventId> + '_ {
        self.seen_event_ids.iter().copied()
    }

    /// Partition identity.
    #[must_use]
    pub const fn partition_id(&self) -> RuntimePartitionId {
        self.config.partition_id
    }
}

/// Deterministic output from one Phase 0 transition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StepOutput {
    /// Number of unique events applied so far.
    pub applied_events: u32,
    /// Current bounded accumulator.
    pub accumulator: u64,
    /// Next logical deadline.
    pub next_deadline: Option<LogicalTime>,
    /// Digest over replay-relevant state.
    pub state_digest: [u8; 32],
    /// Redaction-safe deterministic traces.
    pub trace_events: Vec<TraceEvent>,
    /// Reserved for the bounded scheduler introduced in Phase 2.
    pub yielded: bool,
}

/// Stable reducer failures. Panic and trap strings are never API contracts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeError {
    /// Invalid host configuration.
    Config(ConfigError),
    /// Event logical time moved backwards.
    LogicalTimeRegressed,
    /// Unique-event capacity is exhausted.
    EventLimitExceeded,
    /// Accumulator arithmetic or configured limit would be exceeded.
    AccumulatorLimitExceeded,
    /// A deadline was earlier than the event that set it.
    DeadlineBeforeEventTime,
    /// Decoded snapshot fields violate reducer invariants.
    SnapshotInvariant,
}

impl RuntimeError {
    /// Stable code used by the byte ABI.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Config(error) => error.code(),
            Self::LogicalTimeRegressed => "RUNTIME_LOGICAL_TIME_REGRESSED",
            Self::EventLimitExceeded => "LIMIT_EVENT_COUNT",
            Self::AccumulatorLimitExceeded => "LIMIT_ACCUMULATOR",
            Self::DeadlineBeforeEventTime => "RUNTIME_DEADLINE_BEFORE_EVENT_TIME",
            Self::SnapshotInvariant => "SNAPSHOT_INVARIANT",
        }
    }

    /// Stable broad category.
    #[must_use]
    pub const fn category(self) -> &'static str {
        match self {
            Self::Config(_) => "configuration",
            Self::EventLimitExceeded | Self::AccumulatorLimitExceeded => "limit",
            Self::SnapshotInvariant => "snapshot",
            Self::LogicalTimeRegressed | Self::DeadlineBeforeEventTime => "runtime",
        }
    }
}

impl From<ConfigError> for RuntimeError {
    fn from(value: ConfigError) -> Self {
        Self::Config(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> RuntimeState {
        RuntimeState::new(RuntimeConfig {
            partition_id: RuntimePartitionId::new([1; 32]),
            max_events: 4,
            max_accumulator: 20,
        })
        .expect("valid state")
    }

    #[test]
    fn duplicate_event_is_idempotent() {
        let mut state = state();
        let event = RuntimeEvent::Advance {
            event_id: RuntimeEventId::new([2; 32]),
            logical_time: LogicalTime(10),
            delta: 7,
        };
        let first = state.apply_event(&event).expect("first apply");
        let duplicate = state.apply_event(&event).expect("duplicate apply");
        assert_eq!(first.accumulator, 7);
        assert_eq!(duplicate.accumulator, 7);
        assert_eq!(duplicate.applied_events, 1);
        assert_eq!(duplicate.trace_events[0].kind, TraceKind::DuplicateIgnored);
    }

    #[test]
    fn logical_time_and_bounds_fail_closed_without_state_change() {
        let mut state = state();
        state
            .apply_event(&RuntimeEvent::Advance {
                event_id: RuntimeEventId::new([2; 32]),
                logical_time: LogicalTime(10),
                delta: 7,
            })
            .expect("first apply");
        let digest = state.state_digest();
        assert_eq!(
            state.apply_event(&RuntimeEvent::Advance {
                event_id: RuntimeEventId::new([3; 32]),
                logical_time: LogicalTime(9),
                delta: 1,
            }),
            Err(RuntimeError::LogicalTimeRegressed)
        );
        assert_eq!(
            state.apply_event(&RuntimeEvent::Advance {
                event_id: RuntimeEventId::new([4; 32]),
                logical_time: LogicalTime(11),
                delta: 14,
            }),
            Err(RuntimeError::AccumulatorLimitExceeded)
        );
        assert_eq!(state.state_digest(), digest);
    }
}
