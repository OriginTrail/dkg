
/**
 * Colours for well-known entity kinds (decision, task, pull request, …).
 *
 * One kind keeps one colour everywhere it appears: the activity-feed type
 * pill, the generated summary card's icon, and (with C9) its graph node.
 * Colours come from the data palette (--data-1 … --data-8), so they never
 * read as a layer (WM / SWM / VM) or a signal (success / warning / danger).
 * A context graph's own profile colour for a type still wins where one is set.
 */
export type EntityKind =
  | 'package' | 'file' | 'decision' | 'task' | 'pr' | 'issue' | 'commit'
  | 'class' | 'function' | 'typeAlias' | 'enum' | 'interface';

const KIND_SLOT: Record<EntityKind, number> = {
  package: 1,   // blue
  file: 2,      // olive
  decision: 3,  // berry
  commit: 4,    // gold
  issue: 5,     // fuchsia
  pr: 6,        // brown
  task: 7,      // sky
  // Code graph classes (C9). They share slots with the github/decision kinds,
  // which don't appear in the same graph.
  class: 3,     // berry
  function: 4,  // gold
  typeAlias: 5, // fuchsia
  enum: 6,      // brown
  interface: 7, // sky
};

/** The rdf:type IRIs that have a kind. The one registry of type identity:
 *  DOM (badges, cards) and canvas (graph nodes) both read it. */
export const ENTITY_TYPE_KINDS: Readonly<Record<string, EntityKind>> = {
  'http://dkg.io/ontology/decisions/Decision': 'decision',
  'http://dkg.io/ontology/tasks/Task': 'task',
  'http://dkg.io/ontology/github/PullRequest': 'pr',
  'http://dkg.io/ontology/github/Issue': 'issue',
  'http://dkg.io/ontology/github/Commit': 'commit',
  'http://dkg.io/ontology/code/Package': 'package',
  'http://dkg.io/ontology/code/File': 'file',
  'http://dkg.io/ontology/code/Class': 'class',
  'http://dkg.io/ontology/code/Function': 'function',
  'http://dkg.io/ontology/code/TypeAlias': 'typeAlias',
  'http://dkg.io/ontology/code/Enum': 'enum',
  'http://dkg.io/ontology/code/Interface': 'interface',
};

/** CSS colour (a var() reference) for a kind. */
export function kindColor(kind: EntityKind): string {
  return `var(--data-${KIND_SLOT[kind]})`;
}

/** CSS colour for an rdf:type IRI, or null when the type isn't a known kind. */
export function kindColorForType(typeIri: string | undefined): string | null {
  const kind = typeIri ? ENTITY_TYPE_KINDS[typeIri] : undefined;
  return kind ? kindColor(kind) : null;
}

/** Data-palette slot (1–8) for a kind. */
export function kindSlot(kind: EntityKind): number {
  return KIND_SLOT[kind];
}
