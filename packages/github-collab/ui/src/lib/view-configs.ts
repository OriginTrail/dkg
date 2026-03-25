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
    [`${GH}AgentSession`]: { color: '#4ade80', shape: 'hexagon', sizeMultiplier: 1.5 },
    [`${GH}Decision`]: { color: '#fbbf24', shape: 'hexagon' },
    [`${GH}CodeClaim`]: { color: '#f97316', shape: 'circle' },
    [`${GH}File`]: { color: '#60a5fa', shape: 'circle' },
    [`${GH}PullRequest`]: { color: '#8b5cf6', shape: 'hexagon' },
    [`${GH}Annotation`]: { color: '#a78bfa', shape: 'circle', sizeMultiplier: 0.6 },
  },
  circleTypes: ['CodeClaim', 'File', 'Annotation'],
  defaultSparql: `CONSTRUCT {
  ?session a <${GH}AgentSession> ;
           <${GH}agentName> ?agent ;
           <${GH}sessionStatus> ?status ;
           <${GH}startedAt> ?started ;
           <${GH}goal> ?goal .
  ?session <${GH}modifiedFile> ?file .
  ?claim a <${GH}CodeClaim> ;
         <${GH}claimedFile> ?file ;
         <${GH}claimedBy> ?claimAgent .
  ?decision a <${GH}Decision> ;
            <${GH}decisionSummary> ?decSum ;
            <${GH}madeBy> ?decAgent .
  ?decision <${GH}affectsFile> ?decFile .
  ?session <${GH}relatedPR> ?pr .
}
WHERE {
  {
    ?session a <${GH}AgentSession> ;
             <${GH}agentName> ?agent ;
             <${GH}sessionStatus> ?status ;
             <${GH}startedAt> ?started .
    OPTIONAL { ?session <${GH}goal> ?goal }
    OPTIONAL { ?session <${GH}modifiedFile> ?file }
    OPTIONAL { ?session <${GH}relatedPR> ?pr }
  } UNION {
    ?claim a <${GH}CodeClaim> ;
           <${GH}claimedFile> ?file ;
           <${GH}claimedBy> ?claimAgent ;
           <${GH}claimStatus> "active" .
  } UNION {
    ?decision a <${GH}Decision> ;
              <${GH}decisionSummary> ?decSum ;
              <${GH}madeBy> ?decAgent .
    OPTIONAL { ?decision <${GH}affectsFile> ?decFile }
  }
} LIMIT 500`,
};

export const CODE_STRUCTURE_VIEW: ViewConfig = {
  name: 'Code Structure',
  palette: 'midnight',
  nodeTypes: {
    [`${GH}File`]: { color: '#34d399', shape: 'circle' },
    [`${GH}Directory`]: { color: '#22d3ee', shape: 'hexagon', sizeMultiplier: 1.4 },
    [`${GH}Repository`]: { color: '#8b5cf6', shape: 'hexagon', sizeMultiplier: 2.0 },
  },
  circleTypes: ['File'],
  defaultSparql: `CONSTRUCT { ?s ?p ?o }
WHERE {
  { ?s a <${GH}File> ; ?p ?o }
  UNION
  { ?s a <${GH}Directory> ; ?p ?o }
} LIMIT 500`,
};

export const DEPENDENCY_FLOW_VIEW: ViewConfig = {
  name: 'Dependency Flow',
  palette: 'midnight',
  nodeTypes: {
    [`${GH}File`]: { color: '#34d399', shape: 'circle' },
    [`${GH}Import`]: { color: '#fbbf24', shape: 'circle' },
    [`${GH}Class`]: { color: '#8b5cf6', shape: 'hexagon', sizeMultiplier: 1.3 },
    [`${GH}Function`]: { color: '#ec4899', shape: 'circle' },
  },
  circleTypes: ['File', 'Import', 'Function'],
  animation: {
    linkParticles: true,
    linkParticleCount: 1,
    linkParticleSpeed: 0.003,
    linkParticleColor: 'rgba(251, 191, 36, 0.4)',
  },
  defaultSparql: `CONSTRUCT { ?s ?p ?o }
WHERE {
  { ?s a <${GH}File> ; <${GH}imports> ?o . ?s ?p ?o }
  UNION
  { ?s a <${GH}Class> ; ?p ?o }
  UNION
  { ?s a <${GH}Function> ; ?p ?o }
} LIMIT 500`,
};

export const ALL_VIEWS: Record<string, ViewConfig> = {
  'pr-impact': PR_IMPACT_VIEW,
  'repo-overview': REPO_OVERVIEW_VIEW,
  'code-structure': CODE_STRUCTURE_VIEW,
  'dependency-flow': DEPENDENCY_FLOW_VIEW,
  'branch-diff': BRANCH_DIFF_VIEW,
  'issues': ISSUES_VIEW,
  'agent-activity': AGENT_ACTIVITY_VIEW,
};
