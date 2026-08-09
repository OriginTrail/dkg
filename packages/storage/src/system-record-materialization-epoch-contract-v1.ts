/**
 * Typed result returned by the child-handoff epoch rotation boundary.
 *
 * Structural conformance to this interface is NECESSARY BUT NOT SUFFICIENT.
 * The value crosses an untrusted boundary and is snapshotted through the
 * canonical plain-data guard, which additionally requires a plain data object:
 * an ordinary or null prototype, string keys, and enumerable data properties.
 * A class instance, an accessor-backed object, or a Proxy satisfies this
 * interface and is still rejected at runtime.
 *
 * That is deliberate rather than an oversight, and the reason is that the
 * producer is untrusted: an accessor or a Proxy trap can return one value when
 * the boundary validates and another when a later reader dereferences, so the
 * two fields below could be checked and then not be what was checked. Widening
 * the runtime to match the type would reintroduce exactly that. The type is
 * therefore documented down to the runtime, not the runtime up to the type.
 *
 * Rejection is not silent: a non-`undefined` value that fails this guard fails
 * managed mutations closed. Extra own fields are permitted and discarded --
 * only the two below are carried forward.
 */
export interface SystemRecordMaterializationEpochRotationV1 {
  readonly epoch: string;
  readonly childGeneration: string;
}
