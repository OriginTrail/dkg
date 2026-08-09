/** Typed result returned by the child-handoff epoch rotation boundary. */
export interface SystemRecordMaterializationEpochRotationV1 {
  readonly epoch: string;
  readonly childGeneration: string;
}
