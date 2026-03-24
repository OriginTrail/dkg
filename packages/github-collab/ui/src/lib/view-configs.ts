/**
 * ViewConfig definitions for the GitHub Collaboration graph views.
 * Each config controls how graph data is visually rendered.
 */

import type { ViewConfig } from '@origintrail-official/dkg-graph-viz';

const GH = 'https://ontology.dkg.io/ghcode#';

export const CODE_STRUCTURE_VIEW: ViewConfig = {
  name: 'Code Structure',
  palette: 'midnight',
  nodeTypes: {
    [`${GH}Repository`]: { color: '#22d3ee', shape: 'hexagon', sizeMultiplier: 1.5 },
    [`${GH}File`]: { color: '#6b7280', shape: 'circle' },
    [`${GH}Class`]: { color: '#3b82f6', shape: 'hexagon' },
    [`${GH}Interface`]: { color: '#8b5cf6', shape: 'hexagon' },
    [`${GH}Function`]: { color: '#34d399', shape: 'circle' },
    [`${GH}Method`]: { color: '#10b981', shape: 'circle' },
    [`${GH}Package`]: { color: '#f59e0b', shape: 'hexagon' },
    [`${GH}Module`]: { color: '#6366f1', shape: 'hexagon' },
    [`${GH}User`]: { color: '#ec4899', shape: 'circle' },
  },
  circleTypes: ['File', 'Function', 'Method', 'User'],
  defaultSparql: `CONSTRUCT { ?s ?p ?o }
WHERE {
  ?s a ?type ; ?p ?o .
  FILTER(?type IN (
    <${GH}Repository>, <${GH}File>, <${GH}Class>,
    <${GH}Function>, <${GH}Package>
  ))
} LIMIT 500`,
};

export const DEPENDENCY_FLOW_VIEW: ViewConfig = {
  name: 'Dependency Flow',
  palette: 'midnight',
  nodeTypes: {
    [`${GH}Package`]: { color: '#f59e0b', shape: 'hexagon', sizeMultiplier: 1.3 },
    [`${GH}Module`]: { color: '#6366f1', shape: 'hexagon' },
    [`${GH}File`]: { color: '#6b7280', shape: 'circle' },
    [`${GH}Import`]: { color: '#a78bfa', shape: 'circle' },
    [`${GH}Export`]: { color: '#34d399', shape: 'circle' },
  },
  animation: {
    linkParticles: true,
    linkParticleCount: 1,
    linkParticleSpeed: 0.004,
    linkParticleColor: 'rgba(99, 102, 241, 0.5)',
  },
  defaultSparql: `CONSTRUCT { ?s ?p ?o }
WHERE {
  { ?s a <${GH}Package> ; ?p ?o }
  UNION
  { ?s <${GH}dependsOn> ?o . ?s ?p ?o }
  UNION
  { ?s <${GH}imports> ?o . ?s ?p ?o }
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
  'code-structure': CODE_STRUCTURE_VIEW,
  'dependency-flow': DEPENDENCY_FLOW_VIEW,
  'pr-impact': PR_IMPACT_VIEW,
  'branch-diff': BRANCH_DIFF_VIEW,
  'agent-activity': AGENT_ACTIVITY_VIEW,
};
