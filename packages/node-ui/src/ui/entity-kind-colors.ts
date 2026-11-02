/**
 * Colours for well-known entity kinds (decision, task, pull request, …).
 *
 * One kind keeps one colour everywhere it appears: the activity-feed type
 * pill, the generated summary card's icon, and (with C9) its graph node.
 * Colours come from the data palette (--data-1 … --data-8), so they never
 * read as a layer (WM / SWM / VM) or a signal (success / warning / danger).
 * A context graph's own profile colour for a type still wins where one is set.
 */
export type EntityKind = 'package' | 'file' | 'decision' | 'task' | 'pr' | 'issue' | 'commit';

const KIND_SLOT: Record<EntityKind, number> = {
  package: 1,   // blue
  file: 2,      // olive
  decision: 3,  // berry
  commit: 4,    // gold
  issue: 5,     // fuchsia
  pr: 6,        // brown
  task: 7,      // sky
};

const TYPE_KIND: Record<string, EntityKind> = {
  'http://dkg.io/ontology/decisions/Decision': 'decision',
  'http://dkg.io/ontology/tasks/Task': 'task',
  'http://dkg.io/ontology/github/PullRequest': 'pr',
  'http://dkg.io/ontology/github/Issue': 'issue',
  'http://dkg.io/ontology/github/Commit': 'commit',
  'http://dkg.io/ontology/code/Package': 'package',
  'http://dkg.io/ontology/code/File': 'file',
};

/** CSS colour (a var() reference) for a kind. */
export function kindColor(kind: EntityKind): string {
  return `var(--data-${KIND_SLOT[kind]})`;
}

/** CSS colour for an rdf:type IRI, or null when the type isn't a known kind. */
export function kindColorForType(typeIri: string | undefined): string | null {
  const kind = typeIri ? TYPE_KIND[typeIri] : undefined;
  return kind ? kindColor(kind) : null;
}
