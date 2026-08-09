/**
 * Typed result returned by the child-handoff epoch rotation boundary.
 *
 * Structural conformance is honoured: any value carrying these two fields as
 * own data properties is accepted, including a class instance, a null-prototype
 * object, and one carrying extra metadata. Extra fields are discarded -- only
 * the two below are carried forward.
 *
 * Two shapes are refused despite satisfying this interface, and the reason is
 * narrow rather than general strictness. The producer is untrusted, and an
 * ACCESSOR or a PROXY trap can return one value when the boundary validates and
 * another when a later reader dereferences -- so the fields could be checked and
 * then not be what was checked. The boundary therefore reads own data
 * descriptors, which cannot answer twice, and rejects accessors and Proxies. A
 * class instance is safe by that same test, which is why it is allowed.
 *
 * Refusal is not silent and not conflated with absence: the boundary reports
 * `absent`, `malformed`, and `rotation` as distinct states. A legacy absent
 * binding is tolerated; a malformed one fails managed mutations closed.
 */
export interface SystemRecordMaterializationEpochRotationV1 {
  readonly epoch: string;
  readonly childGeneration: string;
}

/** Canonical runtime result at the injected child-handoff boundary. */
export type SystemRecordMaterializationEpochRotationSnapshotV1 =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'malformed' }>
  | Readonly<{
      kind: 'rotation';
      value: SystemRecordMaterializationEpochRotationV1;
    }>;
