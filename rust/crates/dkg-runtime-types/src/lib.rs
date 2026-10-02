//! Platform-neutral identifiers and Phase 0 reducer inputs.

use core::fmt;

/// The Wasm byte ABI implemented by the Phase 0 kernel.
pub const ABI_VERSION: u16 = 1;
/// The schema version for Phase 0 envelopes and snapshots.
pub const SCHEMA_VERSION: u16 = 1;
/// A hard ceiling independent of host configuration.
pub const HARD_MAX_EVENTS: u32 = 100_000;

macro_rules! id32 {
    ($name:ident, $doc:literal) => {
        #[doc = $doc]
        #[derive(Clone, Copy, Eq, PartialEq, Ord, PartialOrd, Hash)]
        pub struct $name([u8; 32]);

        impl $name {
            /// Constructs an identifier from its canonical 32-byte form.
            #[must_use]
            pub const fn new(bytes: [u8; 32]) -> Self {
                Self(bytes)
            }

            /// Returns the canonical bytes.
            #[must_use]
            pub const fn bytes(self) -> [u8; 32] {
                self.0
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(formatter, "{}(", stringify!($name))?;
                for byte in &self.0[..4] {
                    write!(formatter, "{byte:02x}")?;
                }
                formatter.write_str("…)")
            }
        }
    };
}

id32!(
    RuntimePartitionId,
    "Stable identity of one runtime partition."
);
id32!(RuntimeEventId, "Stable identity of one input event.");
id32!(ExecutionId, "Stable identity of an execution.");
id32!(ProcessId, "Stable identity of a logical process.");
id32!(CapabilityId, "Stable identity of a capability grant.");
id32!(EffectId, "Stable identity of a protected effect.");

/// Host-supplied logical time in milliseconds.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Ord, PartialOrd)]
pub struct LogicalTime(pub u64);

/// Limits for the bounded Phase 0 reducer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeConfig {
    /// Stable partition identity supplied by the host.
    pub partition_id: RuntimePartitionId,
    /// Maximum number of unique events retained by this probe state.
    pub max_events: u32,
    /// Maximum accumulator value allowed by the reducer.
    pub max_accumulator: u64,
}

impl RuntimeConfig {
    /// Validates host configuration before runtime state is allocated.
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.max_events == 0 || self.max_events > HARD_MAX_EVENTS {
            return Err(ConfigError::MaxEventsOutOfRange);
        }
        if self.max_accumulator == 0 {
            return Err(ConfigError::MaxAccumulatorZero);
        }
        Ok(())
    }
}

/// Stable configuration validation failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigError {
    /// `max_events` was zero or exceeded the hard ceiling.
    MaxEventsOutOfRange,
    /// The accumulator limit must be positive.
    MaxAccumulatorZero,
}

impl ConfigError {
    /// Stable ABI error code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::MaxEventsOutOfRange => "CONFIG_MAX_EVENTS_OUT_OF_RANGE",
            Self::MaxAccumulatorZero => "CONFIG_MAX_ACCUMULATOR_ZERO",
        }
    }
}

/// Deterministic events used to falsify the Phase 0 native/Wasm boundary.
///
/// These events are intentionally not presented as the final V1 execution
/// language. Later phases replace this probe with admitted plans and process
/// events without changing the byte-envelope or Worker ownership model.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEvent {
    /// Advances a bounded accumulator at an explicit logical time.
    Advance {
        /// Stable, replay-deduplicated event identity.
        event_id: RuntimeEventId,
        /// Host-recorded logical time.
        logical_time: LogicalTime,
        /// Bounded deterministic delta.
        delta: u64,
    },
    /// Sets or clears the next logical deadline.
    SetDeadline {
        /// Stable, replay-deduplicated event identity.
        event_id: RuntimeEventId,
        /// Host-recorded logical time.
        logical_time: LogicalTime,
        /// `None` clears the deadline.
        deadline: Option<LogicalTime>,
    },
}

impl RuntimeEvent {
    /// Returns the stable event identity.
    #[must_use]
    pub const fn event_id(&self) -> RuntimeEventId {
        match self {
            Self::Advance { event_id, .. } | Self::SetDeadline { event_id, .. } => *event_id,
        }
    }

    /// Returns the host-recorded logical time.
    #[must_use]
    pub const fn logical_time(&self) -> LogicalTime {
        match self {
            Self::Advance { logical_time, .. } | Self::SetDeadline { logical_time, .. } => {
                *logical_time
            }
        }
    }
}
