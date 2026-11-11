import type { StudioComponentInput } from './studio-inputs.js';
import type { StudioComposition } from './studio-composition.js';
/** Shared authoring graph. Each executor admits an explicitly supported, pinned subset. */
export type StudioBlock = {
  id: string;
  label?: string | undefined;
  groupId?: string | undefined;
  componentId: string;
  version?: number;
  kaRef: string;
  sourceHash: string;
  params: Record<string, unknown>;
  /** Literal data bindings produced when a reusable Input is configured at save time. */
  inputValues?: Record<string, unknown>;
  x: number;
  y: number;
};
export type StudioEdge = { from: string; output: number; to: string; input: number };
export type StudioGraph = {
  /** Versioned named invocation arguments and their native parameter bindings. */
  inputs?: StudioComponentInput[];
  /** Authoring and recipe graphs cannot own saved composition snapshots. */
  composition?: never;
  id: string;
  name: string;
  entryId: string;
  nodes: StudioBlock[];
  edges: StudioEdge[];
  groups?:
    { id: string; name: string; tone: 'purple' | 'teal' | 'amber' | 'neutral' }[] | undefined;
};

/** Saved execution definition with an optional compact authoring snapshot. */
export type StudioDefinition = Omit<StudioGraph, 'composition'> & {
  composition?: StudioComposition;
};
