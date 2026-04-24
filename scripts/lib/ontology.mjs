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
  agent: 'http://dkg.io/ontology/agent/',
  // Conversation capture — chat turns produced by coding assistants
  // (Cursor, Claude Code, etc.) that agents promote to SWM so the
  // team can search/summarise across sessions. Deliberately thin so
  // any MCP-capable tool can emit compatible triples.
  chat: 'http://dkg.io/ontology/chat/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  schema: 'http://schema.org/',
  dcterms: 'http://purl.org/dc/terms/',
  foaf: 'http://xmlns.com/foaf/0.1/',
  // Standard PROV-O — used for cross-cutting attribution that any
  // DKG-aware UI can rely on without knowing domain ontologies.
  prov: 'http://www.w3.org/ns/prov#',
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

// ── Agent ─────────────────────────────────────────────────────
/**
 * First-class agent identity. In a multi-agent DKG project, every
 * decision / task / commit is authored by *someone* — human or AI,
 * driven by some framework — and users need to see who wrote what at
 * a glance. Agents are entities in the project's `meta` sub-graph,
 * referenced from domain triples via `prov:wasAttributedTo`.
 *
 * URI scheme: `urn:dkg:agent:{slug}` — slug is usually
 * `{framework}-{operator}` for AI agents ("claude-code-branarakic")
 * or just the operator handle for humans ("branarakic").
 */
export const Agent = {
  T: {
    Agent: NS.agent + 'Agent',
    HumanAgent: NS.agent + 'HumanAgent',
    AIAgent: NS.agent + 'AIAgent',
  },
  P: {
    // Which framework the agent runs on — "claude-code", "openclaw",
    // "hermes", "gemini", "human". UIs use this to pick a glyph/color.
    framework: NS.agent + 'framework',
    // For AI agents: the human operator who runs them. Agent -> Agent URI.
    operator:  NS.agent + 'operator',
    // Wallet public key (EVM-style 0x… address) — the canonical identity
    // on the DKG. Signatures, reputation, TRAC stake, all hang off this.
    // Humans have a wallet they control; AI agents run with a delegated
    // wallet from the operator.
    walletAddress: NS.agent + 'walletAddress',
    // Stable peer-id from the agent's libp2p identity, when known.
    peerId:    NS.agent + 'peerId',
    // Avatar URL or data: URI.
    avatar:    NS.agent + 'avatar',
    // When the agent first participated in this project.
    joinedAt:  NS.agent + 'joinedAt',
    // Optional free-form reputation / trust notes for UI surfacing.
    reputation: NS.agent + 'reputation',
  },
  // PROV-O attribution predicates any domain triple can use:
  //   decisions:Decision prov:wasAttributedTo <agent>
  //   tasks:Task         prov:wasAttributedTo <agent>
  //   github:Commit      prov:wasAttributedTo <agent>
  Prov: {
    wasAttributedTo:   NS.prov + 'wasAttributedTo',
    wasGeneratedBy:    NS.prov + 'wasGeneratedBy',
    wasInvalidatedBy:  NS.prov + 'wasInvalidatedBy',
  },
  // Per-layer transition attribution. These sit on the *entity* and
  // record who actually fired each promote/publish step. The UI reads
  // these to render the Provenance Trail as "Created by X · Promoted by
  // Y · Published by Z". When a value isn't set yet (e.g. the seed
  // script did a bulk promote) the UI falls back to `wasAttributedTo`.
  Transition: {
    createdBy:   NS.agent + 'createdBy',   // WM: first draft author
    promotedBy:  NS.agent + 'promotedBy',  // WM -> SWM actor
    publishedBy: NS.agent + 'publishedBy', // SWM -> VM actor
    createdAt:   NS.agent + 'createdAt',
    promotedAt:  NS.agent + 'promotedAt',
    publishedAt: NS.agent + 'publishedAt',
  },
  uri: {
    agent: (slug) => `urn:dkg:agent:${encodeURIComponent(slug)}`,
  },
};

// ── Chat ──────────────────────────────────────────────────────
/**
 * Captured chat conversations between a human operator and their coding
 * assistant (Cursor, Claude Code, …). A `Session` groups `Turn`s;
 * each Turn is one user↔assistant exchange with optional tool calls.
 *
 * We keep this ontology intentionally thin so other agent frameworks
 * can emit compatible triples with minimal code:
 *
 *   <session> a chat:Session ;
 *             chat:speakerTool "cursor" ;
 *             schema:name "Refactor DaemonService" ;
 *             dcterms:created "2026-04-18T14:22:00Z"^^xsd:dateTime ;
 *             prov:wasAttributedTo <agent:branarakic> .
 *
 *   <turn-001> a chat:Turn ;
 *              chat:inSession <session> ;
 *              chat:turnIndex 1 ;
 *              chat:userPrompt "make the hook fail open"
 *              chat:assistantResponse "…" ;
 *              dcterms:created "…"^^xsd:dateTime ;
 *              prov:wasAttributedTo <agent:claude-code-branarakic> .
 *
 * The markdown body of each Turn is the assertion payload so the text
 * layer stays human-readable; triples describe structure + links.
 *
 * URIs:
 *   urn:dkg:chat:session:{slug}
 *   urn:dkg:chat:session:{slug}#turn:{index}
 */
export const Chat = {
  T: {
    Session: NS.chat + 'Session',
    Turn: NS.chat + 'Turn',
    ToolCall: NS.chat + 'ToolCall',
  },
  P: {
    // Which tool/framework produced this session — "cursor",
    // "claude-code", "aider", … UI picks the glyph. Identical in
    // purpose to agent:framework but lives on Session/Turn so a
    // single agent can drive multiple tools.
    speakerTool: NS.chat + 'speakerTool',
    // Session ↔ Turn link.
    inSession: NS.chat + 'inSession',
    // 1-based ordinal within a Session so UIs can render the thread.
    turnIndex: NS.chat + 'turnIndex',
    // Raw user prompt and assistant response text (truncated / summarised
    // according to the session's privacy setting). The full conversation
    // lives in the markdown assertion body; these predicates are the
    // query-friendly snapshot.
    userPrompt: NS.chat + 'userPrompt',
    assistantResponse: NS.chat + 'assistantResponse',
    // Optional tool calls issued during this turn (subject is Turn).
    hasToolCall: NS.chat + 'hasToolCall',
    // ToolCall details.
    toolName: NS.chat + 'toolName',
    toolInput: NS.chat + 'toolInput',
    toolOutputHash: NS.chat + 'toolOutputHash',
    // Which project / file / decision the turn was *about*. Powers the
    // "agents have been chatting about this file" pill in entity detail.
    aboutEntity: NS.chat + 'aboutEntity',            // Turn/Session -> any URI
    // "private" | "team" | "public". Agents flip this to "team" when
    // auto-promoting to SWM so the UI knows whether to show a session
    // in the shared-with-me feed.
    privacy: NS.chat + 'privacy',
    // Content fingerprint — used to dedupe duplicate captures emitted
    // by the hook (e.g. retries after transient failures).
    contentHash: NS.chat + 'contentHash',
    // Free-form summary when one side of the turn is compressed.
    summary: NS.chat + 'summary',
  },
  uri: {
    session: (slug) => `urn:dkg:chat:session:${encodeURIComponent(slug)}`,
    turn: (sessionSlug, index) =>
      `urn:dkg:chat:session:${encodeURIComponent(sessionSlug)}#turn:${index}`,
    toolCall: (sessionSlug, turnIndex, callIndex) =>
      `urn:dkg:chat:session:${encodeURIComponent(sessionSlug)}#turn:${turnIndex}:call:${callIndex}`,
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
    // ── Layer-transition UX (EntityTypeBinding + SubGraphBinding) ──
    // Domain-aware copy for the Verify-on-DKG CTA. The same button
    // behaves differently across ontologies: a Decision "proposes to
    // team" → "ratifies on-chain", a Task "shares with team" →
    // "anchors"; a Character in a book project might "submit for
    // editorial review" → "publish as canon". Declaring the copy in
    // the profile means the UI needs zero changes per domain.
    //
    //   promoteLabel / promoteHint  — WM → SWM step (button + tooltip)
    //   publishLabel / publishHint  — SWM → VM  step (button + tooltip)
    //
    // Leaving all four unset on an EntityTypeBinding hides the CTA for
    // that type, which is correct for derived artifacts (code:File,
    // github:Commit) that shouldn't be manually progressed.
    promoteLabel: NS.profile + 'promoteLabel',       // EntityTypeBinding -> literal
    promoteHint:  NS.profile + 'promoteHint',        // EntityTypeBinding -> literal
    publishLabel: NS.profile + 'publishLabel',       // EntityTypeBinding -> literal
    publishHint:  NS.profile + 'publishHint',        // EntityTypeBinding -> literal
    // `sourceAssertion` names the WM assertion that a sub-graph's
    // importer writes into. The UI needs this to promote a single
    // entity from WM -> SWM (the promote API takes an assertion name
    // + a selection). Declaring it on the SubGraphBinding lets any
    // future importer wire itself up without touching UI code.
    sourceAssertion: NS.profile + 'sourceAssertion', // SubGraphBinding -> literal assertion name
    // ── Chat capture policy (Profile-level) ────────────────────────
    // When the capture hook wakes up for this project, should the
    // session's turns be written straight to WM (private) or auto-
    // promoted to SWM (visible to teammates on the same CG)? The
    // sentinel values are "wm" and "swm"; the default is "swm" to
    // match the agent-autonomy story. Humans still need to publish
    // to VM by hand.
    defaultChatLayer: NS.profile + 'defaultChatLayer', // Profile -> "wm" | "swm"
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
