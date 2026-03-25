/**
 * ViewConfig definitions for the GitHub Collaboration graph views.
 * Each config controls how graph data is visually rendered.
 */

import type { ViewConfig } from '@origintrail-official/dkg-graph-viz';

const GH = 'https://ontology.dkg.io/ghcode#';

export const REPO_OVERVIEW_VIEW: ViewConfig = {
  name: 'Overview',
  palette: 'midnight',
  nodeTypes: {
    [`${GH}Repository`]: { color: '#22d3ee', shape: 'hexagon', sizeMultiplier: 2.0 },
    [`${GH}PullRequest`]: { color: '#8b5cf6', shape: 'hexagon', sizeMultiplier: 1.2 },
    [`${GH}Issue`]: { color: '#f97316', shape: 'hexagon' },
    [`${GH}User`]: { color: '#ec4899', shape: 'circle' },
    [`${GH}Branch`]: { color: '#34d399', shape: 'circle' },
    [`${GH}Commit`]: { color: '#6b7280', shape: 'circle' },
  },
  circleTypes: ['User', 'Branch', 'Commit'],
  defaultSparql: `CONSTRUCT { ?s ?p ?o }
WHERE {
  ?s a ?type ; ?p ?o .
  FILTER(?type IN (
    <${GH}Repository>, <${GH}PullRequest>, <${GH}Issue>,
    <${GH}User>, <${GH}Branch>
  ))
} LIMIT 300`,
};

export const ISSUES_VIEW: ViewConfig = {
  name: 'Issues',
  palette: 'midnight',
  nodeTypes: {
    [`${GH}Issue`]: { color: '#f97316', shape: 'hexagon', sizeMultiplier: 1.5 },
    [`${GH}User`]: { color: '#ec4899', shape: 'circle' },
    [`${GH}Label`]: { color: '#fbbf24', shape: 'circle' },
    [`${GH}Milestone`]: { color: '#22d3ee', shape: 'hexagon' },
  },
  circleTypes: ['User', 'Label'],
  defaultSparql: `CONSTRUCT { ?s ?p ?o }
WHERE {
  ?s a <${GH}Issue> ; ?p ?o .
} LIMIT 500`,
};

export const PR_IMPACT_VIEW: ViewConfig = {
  name: 'PR Impact',
  palette: 'midnight',
  nodeTypes: {
    [`${GH}PullRequest`]: { color: '#22d3ee', shape: 'hexagon', sizeMultiplier: 1.8 },
    [`${GH}Review`]: { color: '#a78bfa', shape: 'circle' },
    [`${GH}ReviewComment`]: { color: '#818cf8', shape: 'circle' },
    [`${GH}FileDiff`]: { color: '#fbbf24', shape: 'circle' },
    [`${GH}Commit`]: { color: '#34d399', shape: 'hexagon' },
    [`${GH}User`]: { color: '#ec4899', shape: 'circle' },
    [`${GH}Label`]: { color: '#f97316', shape: 'circle' },
  },
  circleTypes: ['Review', 'ReviewComment', 'FileDiff', 'User', 'Label'],
  defaultSparql: `CONSTRUCT { ?s ?p ?o }
WHERE {
  ?s a <${GH}PullRequest> ; ?p ?o .
} LIMIT 500`,
};

export const BRANCH_DIFF_VIEW: ViewConfig = {
  name: 'Branch Diff',
  palette: 'midnight',
  nodeTypes: {
    [`${GH}Branch`]: { color: '#22d3ee', shape: 'hexagon', sizeMultiplier: 1.5 },
    [`${GH}Commit`]: { color: '#34d399', shape: 'hexagon' },
    [`${GH}FileDiff`]: { color: '#fbbf24', shape: 'circle' },
    [`${GH}Merge`]: { color: '#8b5cf6', shape: 'hexagon' },
  },
  circleTypes: ['FileDiff'],
  animation: {
    linkParticles: true,
    linkParticleCount: 1,
    linkParticleSpeed: 0.003,
    linkParticleColor: 'rgba(34, 211, 238, 0.4)',
  },
  defaultSparql: `CONSTRUCT { ?s ?p ?o }
WHERE {
  { ?s a <${GH}Branch> ; ?p ?o }
  UNION
  { ?s a <${GH}Commit> ; ?p ?o }
} LIMIT 500`,
};

export const AGENT_ACTIVITY_VIEW: ViewConfig = {
  name: 'Agent Activity',
  palette: 'midnight',
  nodeTypes: {
    [`${GH}User`]: { color: '#22d3ee', shape: 'hexagon', sizeMultiplier: 1.4 },
    [`${GH}PullRequest`]: { color: '#fbbf24', shape: 'hexagon' },
    [`${GH}Issue`]: { color: '#f97316', shape: 'hexagon' },
    [`${GH}Review`]: { color: '#a78bfa', shape: 'circle' },
    [`${GH}Commit`]: { color: '#34d399', shape: 'circle' },
  },
  circleTypes: ['Review', 'Commit'],
  defaultSparql: `CONSTRUCT { ?s ?p ?o }
WHERE {
  { ?s a <${GH}User> ; ?p ?o }
  UNION
  { ?pr <${GH}author> ?s . ?pr ?p ?o }
} LIMIT 500`,
};

export const ALL_VIEWS: Record<string, ViewConfig> = {
  'pr-impact': PR_IMPACT_VIEW,
  'repo-overview': REPO_OVERVIEW_VIEW,
  'branch-diff': BRANCH_DIFF_VIEW,
  'issues': ISSUES_VIEW,
  'agent-activity': AGENT_ACTIVITY_VIEW,
};
