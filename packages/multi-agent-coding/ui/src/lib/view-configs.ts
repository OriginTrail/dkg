/**
 * ViewConfig definitions for the GitHub Collaboration graph views.
 * Each config controls how graph data is visually rendered.
 *
 * Design principles:
 * - Distinct, high-contrast colors per entity type
 * - Size hierarchy: central entities largest, supporting entities smallest
 * - Labels visible at low zoom via early fade-in thresholds
 * - Circles for leaf/supporting entities, hexagons for primary entities
 * - Subtle edges that don't dominate the visual field
 */

import type { ViewConfig } from '@origintrail-official/dkg-graph-viz';

const GH = 'https://ontology.dkg.io/ghcode#';

// ── Color palette ──
// High-contrast colors chosen for dark backgrounds (midnight palette).
// Each entity type has a unique hue to be distinguishable at a glance.
const COLORS = {
  repository: '#f59e0b', // amber/gold — central, important
  pullRequest: '#a855f7', // violet/purple
  issue: '#f97316',       // orange
  commit: '#22c55e',      // green
  branch: '#06b6d4',      // cyan
  file: '#94a3b8',        // silver/gray
  directory: '#64748b',   // slate/darker gray
  class: '#3b82f6',       // blue
  function: '#ec4899',    // pink/magenta
  user: '#14b8a6',        // teal
  review: '#c084fc',      // light purple/lavender
  reviewComment: '#818cf8', // indigo
  fileDiff: '#eab308',    // yellow
  label: '#fb923c',       // light orange
  milestone: '#22d3ee',   // light cyan
  merge: '#8b5cf6',       // deep purple
  agentSession: '#4ade80', // bright green
  decision: '#fbbf24',    // warm yellow
  codeClaim: '#f97316',   // orange
  annotation: '#a78bfa',  // soft violet
  import: '#fbbf24',      // yellow
};

// ── Shared palette overrides for better edge visibility ──
const EDGE_OVERRIDES = {
  edgeColor: 'rgba(100, 120, 180, 0.25)',
  edgeLabel: '#7f8fa6',
};

export const REPO_OVERVIEW_VIEW: ViewConfig = {
  name: 'Overview',
  palette: 'midnight',
  paletteOverrides: EDGE_OVERRIDES,
  nodeTypes: {
    [`${GH}Repository`]: { color: COLORS.repository, shape: 'hexagon', sizeMultiplier: 1.2 },
    [`${GH}PullRequest`]: { color: COLORS.pullRequest, shape: 'hexagon', sizeMultiplier: 0.8 },
    [`${GH}Issue`]: { color: COLORS.issue, shape: 'hexagon', sizeMultiplier: 0.7 },
    [`${GH}User`]: { color: COLORS.user, shape: 'circle', sizeMultiplier: 0.4 },
    [`${GH}Branch`]: { color: COLORS.branch, shape: 'circle', sizeMultiplier: 0.5 },
    [`${GH}Commit`]: { color: COLORS.commit, shape: 'circle', sizeMultiplier: 0.35 },
  },
  circleTypes: ['User', 'Branch', 'Commit'],
  tooltip: {
    titleProperties: ['name', 'title', 'fullName'],
    titleMaxLength: 50,
  },
  defaultSparql: `CONSTRUCT { ?s ?p ?o }
WHERE {
  ?s a ?type ; ?p ?o .
  FILTER(?type IN (
    <${GH}Repository>, <${GH}PullRequest>, <${GH}Issue>,
    <${GH}User>, <${GH}Branch>
  ))
} LIMIT 200`,
};

export const ISSUES_VIEW: ViewConfig = {
  name: 'Issues',
  palette: 'midnight',
  paletteOverrides: EDGE_OVERRIDES,
  nodeTypes: {
    [`${GH}Issue`]: { color: COLORS.issue, shape: 'hexagon', sizeMultiplier: 0.9 },
    [`${GH}User`]: { color: COLORS.user, shape: 'circle', sizeMultiplier: 0.4 },
    [`${GH}Label`]: { color: COLORS.label, shape: 'circle', sizeMultiplier: 0.35 },
    [`${GH}Milestone`]: { color: COLORS.milestone, shape: 'hexagon', sizeMultiplier: 0.7 },
  },
  circleTypes: ['User', 'Label'],
  tooltip: {
    titleProperties: ['title', 'name'],
    titleMaxLength: 60,
  },
  defaultSparql: `CONSTRUCT { ?s ?p ?o }
WHERE {
  ?s a <${GH}Issue> ; ?p ?o .
} LIMIT 500`,
};

export const PR_IMPACT_VIEW: ViewConfig = {
  name: 'PR Impact',
  palette: 'midnight',
  paletteOverrides: EDGE_OVERRIDES,
  nodeTypes: {
    [`${GH}PullRequest`]: { color: COLORS.pullRequest, shape: 'hexagon', sizeMultiplier: 1.0 },
    [`${GH}Review`]: { color: COLORS.review, shape: 'circle', sizeMultiplier: 0.5 },
    [`${GH}ReviewComment`]: { color: COLORS.reviewComment, shape: 'circle', sizeMultiplier: 0.35 },
    [`${GH}FileDiff`]: { color: COLORS.fileDiff, shape: 'circle', sizeMultiplier: 0.35 },
    [`${GH}Commit`]: { color: COLORS.commit, shape: 'circle', sizeMultiplier: 0.4 },
    [`${GH}User`]: { color: COLORS.user, shape: 'circle', sizeMultiplier: 0.4 },
    [`${GH}Label`]: { color: COLORS.label, shape: 'circle', sizeMultiplier: 0.35 },
    [`${GH}File`]: { color: COLORS.file, shape: 'circle', sizeMultiplier: 0.35 },
  },
  circleTypes: ['Review', 'ReviewComment', 'FileDiff', 'User', 'Label', 'File', 'Commit'],
  tooltip: {
    titleProperties: ['title', 'name', 'path'],
    titleMaxLength: 60,
    subtitleTemplate: '{author} · {date}',
  },
  defaultSparql: `CONSTRUCT { ?s ?p ?o }
WHERE {
  ?s a <${GH}PullRequest> ; ?p ?o .
} LIMIT 300`,
};

export const BRANCH_DIFF_VIEW: ViewConfig = {
  name: 'Branch Diff',
  palette: 'midnight',
  paletteOverrides: EDGE_OVERRIDES,
  nodeTypes: {
    [`${GH}Branch`]: { color: COLORS.branch, shape: 'hexagon', sizeMultiplier: 0.9 },
    [`${GH}Commit`]: { color: COLORS.commit, shape: 'hexagon', sizeMultiplier: 0.6 },
    [`${GH}FileDiff`]: { color: COLORS.fileDiff, shape: 'circle', sizeMultiplier: 0.35 },
    [`${GH}Merge`]: { color: COLORS.merge, shape: 'hexagon', sizeMultiplier: 0.7 },
  },
  circleTypes: ['FileDiff'],
  tooltip: {
    titleProperties: ['name', 'message', 'path'],
    titleMaxLength: 50,
  },
  defaultSparql: `CONSTRUCT { ?s ?p ?o }
WHERE {
  ?s a ?type ; ?p ?o .
  FILTER(?type IN (<${GH}Branch>, <${GH}Commit>, <${GH}Merge>))
} LIMIT 300`,
};

export const AGENT_ACTIVITY_VIEW: ViewConfig = {
  name: 'Agent Activity',
  palette: 'midnight',
  paletteOverrides: EDGE_OVERRIDES,
  nodeTypes: {
    [`${GH}AgentSession`]: { color: COLORS.agentSession, shape: 'hexagon', sizeMultiplier: 0.9 },
    [`${GH}Decision`]: { color: COLORS.decision, shape: 'hexagon', sizeMultiplier: 0.7 },
    [`${GH}ClaimedRegion`]: { color: COLORS.codeClaim, shape: 'circle', sizeMultiplier: 0.4 },
    [`${GH}File`]: { color: COLORS.file, shape: 'circle', sizeMultiplier: 0.35 },
    [`${GH}PullRequest`]: { color: COLORS.pullRequest, shape: 'hexagon', sizeMultiplier: 0.7 },
    [`${GH}Annotation`]: { color: COLORS.annotation, shape: 'circle', sizeMultiplier: 0.3 },
  },
  circleTypes: ['ClaimedRegion', 'File', 'Annotation'],
  tooltip: {
    titleProperties: ['agentName', 'goal', 'decisionSummary', 'name'],
    titleMaxLength: 60,
  },
  defaultSparql: `CONSTRUCT { ?s ?p ?o }
WHERE {
  ?s a ?type ; ?p ?o .
  FILTER(?type IN (
    <${GH}AgentSession>, <${GH}Decision>,
    <${GH}ClaimedRegion>, <${GH}Annotation>
  ))
} LIMIT 300`,
};

export const CODE_STRUCTURE_VIEW: ViewConfig = {
  name: 'Code Structure',
  palette: 'midnight',
  paletteOverrides: EDGE_OVERRIDES,
  nodeTypes: {
    [`${GH}Class`]: { color: COLORS.class, shape: 'hexagon', sizeMultiplier: 0.8 },
    [`${GH}Function`]: { color: COLORS.function, shape: 'circle', sizeMultiplier: 0.4 },
    [`${GH}Interface`]: { color: '#8b5cf6', shape: 'hexagon', sizeMultiplier: 0.6 },
    [`${GH}Method`]: { color: COLORS.function, shape: 'circle', sizeMultiplier: 0.3 },
    [`${GH}TypeAlias`]: { color: '#a78bfa', shape: 'circle', sizeMultiplier: 0.3 },
    [`${GH}Enum`]: { color: '#fb923c', shape: 'hexagon', sizeMultiplier: 0.5 },
    [`${GH}File`]: { color: COLORS.file, shape: 'circle', sizeMultiplier: 0.25 },
  },
  circleTypes: ['Function', 'Method', 'TypeAlias', 'File'],
  tooltip: {
    titleProperties: ['name', 'signature', 'path'],
    titleMaxLength: 50,
  },
  defaultSparql: `CONSTRUCT { ?s ?p ?o }
WHERE {
  ?s a ?type ; ?p ?o .
  FILTER(?type IN (
    <${GH}Class>, <${GH}Function>, <${GH}Interface>,
    <${GH}Method>, <${GH}TypeAlias>, <${GH}Enum>
  ))
} LIMIT 500`,
};

export const DEPENDENCY_FLOW_VIEW: ViewConfig = {
  name: 'Dependency Flow',
  palette: 'midnight',
  paletteOverrides: EDGE_OVERRIDES,
  nodeTypes: {
    [`${GH}Import`]: { color: COLORS.import, shape: 'circle', sizeMultiplier: 0.4 },
    [`${GH}Class`]: { color: COLORS.class, shape: 'hexagon', sizeMultiplier: 0.8 },
    [`${GH}Function`]: { color: COLORS.function, shape: 'circle', sizeMultiplier: 0.4 },
    [`${GH}File`]: { color: COLORS.file, shape: 'circle', sizeMultiplier: 0.3 },
  },
  circleTypes: ['File', 'Import', 'Function'],
  tooltip: {
    titleProperties: ['name', 'importSource', 'path'],
    titleMaxLength: 40,
  },
  defaultSparql: `CONSTRUCT { ?s ?p ?o }
WHERE {
  ?s a <${GH}Import> ; ?p ?o .
} LIMIT 500`,
};

export const FILES_VIEW: ViewConfig = {
  name: 'Files',
  palette: 'midnight',
  paletteOverrides: EDGE_OVERRIDES,
  nodeTypes: {
    [`${GH}File`]: { color: COLORS.file, shape: 'circle', sizeMultiplier: 0.4 },
    [`${GH}Directory`]: { color: COLORS.directory, shape: 'hexagon', sizeMultiplier: 0.7 },
    [`${GH}Repository`]: { color: COLORS.repository, shape: 'hexagon', sizeMultiplier: 1.2 },
  },
  circleTypes: ['File'],
  tooltip: {
    titleProperties: ['filePath', 'dirPath', 'name'],
    titleMaxLength: 50,
  },
  defaultSparql: `CONSTRUCT { ?s ?p ?o }
WHERE {
  ?s a ?type ; ?p ?o .
  FILTER(?type IN (<${GH}File>, <${GH}Directory>))
} LIMIT 300`,
};

export const ALL_VIEWS: Record<string, ViewConfig> = {
  'pr-impact': PR_IMPACT_VIEW,
  'repo-overview': REPO_OVERVIEW_VIEW,
  'code-structure': CODE_STRUCTURE_VIEW,
  'dependency-flow': DEPENDENCY_FLOW_VIEW,
  'files': FILES_VIEW,
  'branch-diff': BRANCH_DIFF_VIEW,
  'issues': ISSUES_VIEW,
  'agent-activity': AGENT_ACTIVITY_VIEW,
};
