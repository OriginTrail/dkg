/**
 * Shared ontology definitions and URI helpers for the dkg-code-project PoC.
 *
 * Five namespaces:
 *   code       — packages, files, classes, functions (AST)
 *   github     — PRs, issues, commits, reviews, users, repos
 *   decisions  — architectural decisions, linked to files + PRs
 *   tasks      — project tasks, linked to decisions + PRs + files
 *   profile    — project profile: how the generic Node UI displays this graph
 *
 * URI scheme (stable, human-readable, cross-sub-graph joinable):
 *   urn:dkg:code:package:{encoded-name}
 *   urn:dkg:code:file:{encoded-pkg}/{encoded-relpath}
 *   urn:dkg:code:module:{encoded-name}
 *   urn:dkg:github:repo:{owner}/{name}
 *   urn:dkg:github:pr:{owner}/{name}/{number}
 *   urn:dkg:github:issue:{owner}/{name}/{number}
 *   urn:dkg:github:commit:{owner}/{name}/{sha}
 *   urn:dkg:github:user:{login}
 *   urn:dkg:decision:{slug}
 *   urn:dkg:task:{slug}
 *   urn:dkg:profile:{project-id}
 *   urn:dkg:profile:{project-id}:binding:{slug}
 *   urn:dkg:profile:{project-id}:view:{slug}
 */

export const NS = {
  code: 'http://dkg.io/ontology/code/',
  github: 'http://dkg.io/ontology/github/',
  decisions: 'http://dkg.io/ontology/decisions/',
  tasks: 'http://dkg.io/ontology/tasks/',
  profile: 'http://dkg.io/ontology/profile/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  schema: 'http://schema.org/',
  dcterms: 'http://purl.org/dc/terms/',
  foaf: 'http://xmlns.com/foaf/0.1/',
};

export const XSD = {
  int: NS.xsd + 'integer',
  bool: NS.xsd + 'boolean',
  dateTime: NS.xsd + 'dateTime',
  decimal: NS.xsd + 'decimal',
};

export const Common = {
  type: NS.rdf + 'type',
  label: NS.rdfs + 'label',
  name: NS.schema + 'name',
  description: NS.schema + 'description',
  title: NS.dcterms + 'title',
  created: NS.dcterms + 'created',
  modified: NS.dcterms + 'modified',
  creator: NS.dcterms + 'creator',
};

// ── Code ──────────────────────────────────────────────────────
export const Code = {
  T: {
    Package: NS.code + 'Package',
    File: NS.code + 'File',
    Class: NS.code + 'Class',
    Interface: NS.code + 'Interface',
    Function: NS.code + 'Function',
    TypeAlias: NS.code + 'TypeAlias',
    Enum: NS.code + 'Enum',
    ExternalModule: NS.code + 'ExternalModule',
  },
  P: {
    path: NS.code + 'path',
    package: NS.code + 'package',
    language: NS.code + 'language',
    lineCount: NS.code + 'lineCount',
    startLine: NS.code + 'startLine',
    endLine: NS.code + 'endLine',
    kind: NS.code + 'kind',
    contains: NS.code + 'contains',
    definedIn: NS.code + 'definedIn',
    imports: NS.code + 'imports',
    exports: NS.code + 'exports',
    extends: NS.code + 'extends',
    implements: NS.code + 'implements',
    isExported: NS.code + 'isExported',
    isAsync: NS.code + 'isAsync',
    paramCount: NS.code + 'paramCount',
  },
  uri: {
    package: (name) => `urn:dkg:code:package:${encodeURIComponent(name)}`,
    file: (pkgName, relPath) =>
      `urn:dkg:code:file:${encodeURIComponent(pkgName)}/${encodeURIComponent(relPath)}`,
    decl: (fileId, name, kind) =>
      `${fileId}#${kind}:${encodeURIComponent(name)}`,
    module: (name) => `urn:dkg:code:module:${encodeURIComponent(name)}`,
  },
};

// ── GitHub ────────────────────────────────────────────────────
export const Github = {
  T: {
    Repository: NS.github + 'Repository',
    PullRequest: NS.github + 'PullRequest',
    Issue: NS.github + 'Issue',
    Commit: NS.github + 'Commit',
    Review: NS.github + 'Review',
    User: NS.github + 'User',
    Label: NS.github + 'Label',
  },
  P: {
    number: NS.github + 'number',
    state: NS.github + 'state',
    merged: NS.github + 'merged',
    mergedAt: NS.github + 'mergedAt',
    closedAt: NS.github + 'closedAt',
    body: NS.github + 'body',
    authoredBy: NS.github + 'authoredBy',
    reviewedBy: NS.github + 'reviewedBy',
    assignedTo: NS.github + 'assignedTo',
    hasLabel: NS.github + 'hasLabel',
    affects: NS.github + 'affects',        // PR/commit -> code:File
    inRepo: NS.github + 'inRepo',
    closes: NS.github + 'closes',           // PR -> Issue
    sha: NS.github + 'sha',
    parentCommit: NS.github + 'parentCommit',
    verdict: NS.github + 'verdict',         // approved / changes_requested / commented
    url: NS.github + 'url',
    additions: NS.github + 'additions',
    deletions: NS.github + 'deletions',
    changedFiles: NS.github + 'changedFiles',
  },
  uri: {
    repo: (owner, name) => `urn:dkg:github:repo:${owner}/${name}`,
    pr: (owner, name, number) => `urn:dkg:github:pr:${owner}/${name}/${number}`,
    issue: (owner, name, number) => `urn:dkg:github:issue:${owner}/${name}/${number}`,
    commit: (owner, name, sha) => `urn:dkg:github:commit:${owner}/${name}/${sha}`,
    review: (owner, name, prNumber, reviewId) =>
      `urn:dkg:github:review:${owner}/${name}/${prNumber}/${reviewId}`,
    user: (login) => `urn:dkg:github:user:${encodeURIComponent(login)}`,
    label: (repoOwner, repoName, label) =>
      `urn:dkg:github:label:${repoOwner}/${repoName}/${encodeURIComponent(label)}`,
  },
};

// ── Decisions ─────────────────────────────────────────────────
export const Decisions = {
  T: {
    Decision: NS.decisions + 'Decision',
  },
  P: {
    status: NS.decisions + 'status',          // proposed / accepted / superseded / rejected
    date: NS.decisions + 'date',
    context: NS.decisions + 'context',
    outcome: NS.decisions + 'outcome',
    consequences: NS.decisions + 'consequences',
    alternatives: NS.decisions + 'alternatives',
    affects: NS.decisions + 'affects',          // Decision -> code:File | code:Package
    recordedIn: NS.decisions + 'recordedIn',    // Decision -> github:PullRequest
    supersedes: NS.decisions + 'supersedes',    // Decision -> Decision
    proposedBy: NS.decisions + 'proposedBy',    // Decision -> github:User
  },
  uri: {
    decision: (slug) => `urn:dkg:decision:${encodeURIComponent(slug)}`,
  },
};

// ── Tasks ─────────────────────────────────────────────────────
export const Tasks = {
  T: {
    Task: NS.tasks + 'Task',
  },
  P: {
    status: NS.tasks + 'status',         // todo / in_progress / blocked / done / cancelled
    priority: NS.tasks + 'priority',     // p0..p3
    assignee: NS.tasks + 'assignee',     // Task -> github:User
    dueDate: NS.tasks + 'dueDate',
    dependsOn: NS.tasks + 'dependsOn',           // Task -> Task
    relatedDecision: NS.tasks + 'relatedDecision', // Task -> Decision
    relatedPR: NS.tasks + 'relatedPR',             // Task -> github:PullRequest
    relatedIssue: NS.tasks + 'relatedIssue',       // Task -> github:Issue
    touches: NS.tasks + 'touches',                 // Task -> code:File | code:Package
    estimate: NS.tasks + 'estimate',               // int (hours)
  },
  uri: {
    task: (slug) => `urn:dkg:task:${encodeURIComponent(slug)}`,
  },
};

// ── Profile ───────────────────────────────────────────────────
/**
 * The profile ontology is how a project declares to any DKG-aware UI how
 * it wants to be displayed: which sub-graphs exist, which entity types
 * get which icon/color/label, which graph views the project ships with,
 * and what prompt hints the LLM should use when composing GenUI.
 */
export const Profile = {
  T: {
    Profile: NS.profile + 'Profile',
    SubGraphBinding: NS.profile + 'SubGraphBinding',
    EntityTypeBinding: NS.profile + 'EntityTypeBinding',
    ViewConfig: NS.profile + 'ViewConfig',
    // A FilterChip declares an interactive filter for an entity type in a
    // sub-graph page (e.g. status chips for decisions, priority chips for
    // tasks). The UI reads these and renders a chip row above the entity
    // list with zero domain-specific code.
    FilterChip: NS.profile + 'FilterChip',
    // A SavedQuery is a ViewConfig that carries a SPARQL query instead of a
    // declarative includeTypes list. Rendered as a pill; click runs the
    // query and dumps results into the current entity list.
    SavedQuery: NS.profile + 'SavedQuery',
  },
  P: {
    appliesTo: NS.profile + 'appliesTo',         // Profile -> context graph id (IRI or literal)
    ofProfile: NS.profile + 'ofProfile',         // Binding/View -> Profile
    forSubGraph: NS.profile + 'forSubGraph',     // SubGraphBinding / FilterChip / SavedQuery -> sub-graph name
    forType: NS.profile + 'forType',             // EntityTypeBinding / FilterChip -> rdf:type IRI
    displayName: NS.profile + 'displayName',
    icon: NS.profile + 'icon',                   // emoji / short glyph
    color: NS.profile + 'color',                 // hex
    label: NS.profile + 'label',
    rank: NS.profile + 'rank',                   // ordering int
    primaryColor: NS.profile + 'primaryColor',
    accentColor: NS.profile + 'accentColor',
    detailHint: NS.profile + 'detailHint',       // prose prompt hint for GenUI composer
    heroComponent: NS.profile + 'heroComponent', // registered component name to spotlight at top
    includeType: NS.profile + 'includeType',     // ViewConfig -> class IRI (one triple per type)
    emphasizePredicate: NS.profile + 'emphasizePredicate', // ViewConfig -> predicate IRI
    nodeSize: NS.profile + 'nodeSize',           // "degree" | "uniform"
    defaultView: NS.profile + 'defaultView',     // Profile -> ViewConfig
    // ── Filter chip extension ────────────────────────────────────
    // A chip filters the entity list by (forSubGraph + forType) matching
    // `onPredicate = value`. Multiple chips stack as OR within the same
    // predicate, AND across predicates.
    onPredicate: NS.profile + 'onPredicate',     // FilterChip -> predicate IRI
    chipValue: NS.profile + 'chipValue',         // FilterChip -> literal value (repeat per enum value)
    // ── Timeline extension ───────────────────────────────────────
    // Opts a sub-graph into the Timeline tab. The UI picks up the declared
    // predicate and renders a time-sorted ribbon of the sub-graph's entities.
    timelinePredicate: NS.profile + 'timelinePredicate', // SubGraphBinding -> predicate IRI (a date/dateTime)
    // ── Saved SPARQL queries (ViewConfig extension) ──────────────
    // A SavedQuery ViewConfig renders as a pill above the entity list. On
    // click the UI runs the query against the project's SPARQL endpoint
    // and displays the result set as the filtered entity list.
    sparqlQuery: NS.profile + 'sparqlQuery',     // SavedQuery -> literal SPARQL text
    resultColumn: NS.profile + 'resultColumn',   // SavedQuery -> literal column name yielding ?uri
  },
  uri: {
    profile: (projectId) => `urn:dkg:profile:${encodeURIComponent(projectId)}`,
    binding: (projectId, slug) =>
      `urn:dkg:profile:${encodeURIComponent(projectId)}:binding:${encodeURIComponent(slug)}`,
    view: (projectId, slug) =>
      `urn:dkg:profile:${encodeURIComponent(projectId)}:view:${encodeURIComponent(slug)}`,
    chip: (projectId, slug) =>
      `urn:dkg:profile:${encodeURIComponent(projectId)}:chip:${encodeURIComponent(slug)}`,
    query: (projectId, slug) =>
      `urn:dkg:profile:${encodeURIComponent(projectId)}:query:${encodeURIComponent(slug)}`,
  },
};

// ── Shared literal/uri helpers ────────────────────────────────
export function uri(s) {
  return `<${s}>`;
}

export function lit(value, datatype = null, lang = null) {
  const esc = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  if (lang) return `"${esc}"@${lang}`;
  if (datatype) return `"${esc}"^^<${datatype}>`;
  return `"${esc}"`;
}

/** Emit-safe triple sink with dedup. */
export function createTripleSink() {
  const triples = [];
  const seen = new Set();
  return {
    triples,
    emit(s, p, o) {
      const key = `${s}|${p}|${o}`;
      if (seen.has(key)) return;
      seen.add(key);
      triples.push({ subject: s, predicate: p, object: o });
    },
    size() {
      return triples.length;
    },
  };
}
