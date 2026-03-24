/**
 * RDF Transformer — converts GitHub API JSON to RDF quads.
 *
 * Each transform function takes a GitHub API response object and returns
 * an array of Quads per the GitHub Code Ontology (gh:).
 *
 * All quads include a graph URI for named graph scoping.
 */

import {
  GH, RDF, PROV,
  type Quad,
  repoUri, userUri, prUri, issueUri, commitUri, branchUri,
  reviewUri, reviewCommentUri, issueCommentUri, labelUri, milestoneUri, fileDiffUri,
  tripleUri, tripleStr, tripleInt, tripleBool, tripleDateTime,
} from './uri.js';

// --- Repository ---

export function transformRepository(json: any, graph: string): Quad[] {
  const owner = json.owner?.login;
  const repo = json.name;
  if (!owner || !repo) return [];

  const uri = repoUri(owner, repo);
  const quads: Quad[] = [
    tripleUri(uri, `${RDF}type`, `${GH}Repository`, graph),
    tripleStr(uri, `${GH}fullName`, `${owner}/${repo}`, graph),
  ];

  if (typeof json.id === 'number') quads.push(tripleInt(uri, `${GH}githubId`, json.id, graph));
  if (json.node_id) quads.push(tripleStr(uri, `${GH}nodeId`, json.node_id, graph));
  if (json.description) quads.push(tripleStr(uri, `${GH}description`, json.description, graph));
  if (json.html_url) quads.push(tripleStr(uri, `${GH}htmlUrl`, json.html_url, graph));
  if (json.url) quads.push(tripleStr(uri, `${GH}apiUrl`, json.url, graph));
  if (json.default_branch) quads.push(tripleStr(uri, `${GH}defaultBranch`, json.default_branch, graph));
  if (json.visibility) quads.push(tripleStr(uri, `${GH}visibility`, json.visibility, graph));
  if (json.language) quads.push(tripleStr(uri, `${GH}primaryLanguage`, json.language, graph));
  if (json.license?.spdx_id) quads.push(tripleStr(uri, `${GH}license`, json.license.spdx_id, graph));
  if (typeof json.stargazers_count === 'number') quads.push(tripleInt(uri, `${GH}starCount`, json.stargazers_count, graph));
  if (typeof json.forks_count === 'number') quads.push(tripleInt(uri, `${GH}forkCount`, json.forks_count, graph));
  if (typeof json.open_issues_count === 'number') quads.push(tripleInt(uri, `${GH}openIssueCount`, json.open_issues_count, graph));
  if (typeof json.archived === 'boolean') quads.push(tripleBool(uri, `${GH}archived`, json.archived, graph));

  if (Array.isArray(json.topics)) {
    for (const topic of json.topics) {
      quads.push(tripleStr(uri, `${GH}topics`, topic, graph));
    }
  }

  if (json.created_at) quads.push(tripleDateTime(uri, `${GH}createdAt`, json.created_at, graph));
  if (json.updated_at) quads.push(tripleDateTime(uri, `${GH}updatedAt`, json.updated_at, graph));

  quads.push(tripleDateTime(uri, `${GH}snapshotAt`, new Date().toISOString(), graph));

  // Owner
  if (json.owner) {
    quads.push(...transformUser(json.owner, graph));
    quads.push(tripleUri(uri, `${GH}owner`, userUri(json.owner.login), graph));
  }

  // Fork parent
  if (json.parent?.owner?.login && json.parent?.name) {
    quads.push(tripleUri(uri, `${GH}forkedFrom`, repoUri(json.parent.owner.login, json.parent.name), graph));
  }

  return quads;
}

// --- User ---

export function transformUser(json: any, graph: string): Quad[] {
  if (!json?.login) return [];

  const uri = userUri(json.login);
  const quads: Quad[] = [
    tripleUri(uri, `${RDF}type`, `${GH}User`, graph),
    tripleStr(uri, `${GH}login`, json.login, graph),
  ];

  if (typeof json.id === 'number') quads.push(tripleInt(uri, `${GH}githubId`, json.id, graph));
  if (json.node_id) quads.push(tripleStr(uri, `${GH}nodeId`, json.node_id, graph));
  if (json.avatar_url) quads.push(tripleStr(uri, `${GH}avatarUrl`, json.avatar_url, graph));
  if (json.html_url) quads.push(tripleStr(uri, `${GH}htmlUrl`, json.html_url, graph));
  if (json.type === 'Organization') {
    quads.push(tripleUri(uri, `${RDF}type`, `${GH}Organization`, graph));
  }

  return quads;
}

// --- Pull Request ---

export function transformPullRequest(json: any, owner: string, repo: string, graph: string): Quad[] {
  const number = json.number;
  if (typeof number !== 'number') return [];

  const uri = prUri(owner, repo, number);
  const quads: Quad[] = [
    tripleUri(uri, `${RDF}type`, `${GH}PullRequest`, graph),
    tripleUri(uri, `${RDF}type`, `${PROV}Activity`, graph),
    tripleInt(uri, `${GH}prNumber`, number, graph),
    tripleUri(uri, `${GH}inRepo`, repoUri(owner, repo), graph),
  ];

  if (typeof json.id === 'number') quads.push(tripleInt(uri, `${GH}githubId`, json.id, graph));
  if (json.node_id) quads.push(tripleStr(uri, `${GH}nodeId`, json.node_id, graph));
  if (json.title) quads.push(tripleStr(uri, `${GH}title`, json.title, graph));
  if (json.body) quads.push(tripleStr(uri, `${GH}body`, json.body, graph));
  if (json.state) {
    const state = json.merged_at ? 'merged' : json.state;
    quads.push(tripleStr(uri, `${GH}state`, state, graph));
  }
  if (typeof json.draft === 'boolean') quads.push(tripleBool(uri, `${GH}draft`, json.draft, graph));
  if (json.html_url) quads.push(tripleStr(uri, `${GH}htmlUrl`, json.html_url, graph));

  if (json.created_at) quads.push(tripleDateTime(uri, `${GH}createdAt`, json.created_at, graph));
  if (json.updated_at) quads.push(tripleDateTime(uri, `${GH}updatedAt`, json.updated_at, graph));
  if (json.closed_at) quads.push(tripleDateTime(uri, `${GH}closedAt`, json.closed_at, graph));
  if (json.merged_at) quads.push(tripleDateTime(uri, `${GH}mergedAt`, json.merged_at, graph));

  if (json.base?.ref) quads.push(tripleStr(uri, `${GH}baseBranch`, json.base.ref, graph));
  if (json.head?.ref) quads.push(tripleStr(uri, `${GH}headBranch`, json.head.ref, graph));
  if (json.head?.sha) quads.push(tripleStr(uri, `${GH}headSha`, json.head.sha, graph));

  if (json.merge_commit_sha) {
    quads.push(tripleUri(uri, `${GH}mergeCommit`, commitUri(owner, repo, json.merge_commit_sha), graph));
  }

  if (typeof json.additions === 'number') quads.push(tripleInt(uri, `${GH}totalAdditions`, json.additions, graph));
  if (typeof json.deletions === 'number') quads.push(tripleInt(uri, `${GH}totalDeletions`, json.deletions, graph));
  if (typeof json.changed_files === 'number') quads.push(tripleInt(uri, `${GH}changedFileCount`, json.changed_files, graph));

  // Author
  if (json.user?.login) {
    quads.push(...transformUser(json.user, graph));
    quads.push(tripleUri(uri, `${GH}author`, userUri(json.user.login), graph));
    quads.push(tripleUri(uri, `${PROV}wasAssociatedWith`, userUri(json.user.login), graph));
  }

  // Merged by
  if (json.merged_by?.login) {
    quads.push(...transformUser(json.merged_by, graph));
    quads.push(tripleUri(uri, `${GH}mergedBy`, userUri(json.merged_by.login), graph));
  }

  // Assignees
  if (Array.isArray(json.assignees)) {
    for (const assignee of json.assignees) {
      if (assignee?.login) {
        quads.push(...transformUser(assignee, graph));
        quads.push(tripleUri(uri, `${GH}assignedTo`, userUri(assignee.login), graph));
      }
    }
  }

  // Requested reviewers
  if (Array.isArray(json.requested_reviewers)) {
    for (const reviewer of json.requested_reviewers) {
      if (reviewer?.login) {
        quads.push(...transformUser(reviewer, graph));
        quads.push(tripleUri(uri, `${GH}reviewRequestedFrom`, userUri(reviewer.login), graph));
      }
    }
  }

  // Labels
  if (Array.isArray(json.labels)) {
    for (const label of json.labels) {
      if (label?.name) {
        quads.push(...transformLabel(label, owner, repo, graph));
        quads.push(tripleUri(uri, `${GH}hasLabel`, labelUri(owner, repo, label.name), graph));
      }
    }
  }

  // Milestone
  if (json.milestone?.number) {
    quads.push(...transformMilestone(json.milestone, owner, repo, graph));
    quads.push(tripleUri(uri, `${GH}milestone`, milestoneUri(owner, repo, json.milestone.number), graph));
  }

  return quads;
}

// --- Pull Request Files (FileDiff) ---

export function transformPullRequestFiles(files: any[], owner: string, repo: string, prNumber: number, graph: string): Quad[] {
  const quads: Quad[] = [];
  const prU = prUri(owner, repo, prNumber);

  for (const file of files) {
    if (!file?.filename) continue;
    const fdUri = fileDiffUri(owner, repo, prNumber, file.filename);

    quads.push(tripleUri(fdUri, `${RDF}type`, `${GH}FileDiff`, graph));
    quads.push(tripleStr(fdUri, `${GH}diffPath`, file.filename, graph));
    quads.push(tripleUri(prU, `${GH}prFileDiff`, fdUri, graph));

    if (file.status) quads.push(tripleStr(fdUri, `${GH}diffStatus`, file.status, graph));
    if (typeof file.additions === 'number') quads.push(tripleInt(fdUri, `${GH}additions`, file.additions, graph));
    if (typeof file.deletions === 'number') quads.push(tripleInt(fdUri, `${GH}deletions`, file.deletions, graph));
    if (file.previous_filename) quads.push(tripleStr(fdUri, `${GH}previousPath`, file.previous_filename, graph));
    if (file.patch) quads.push(tripleStr(fdUri, `${GH}patch`, file.patch, graph));
  }

  return quads;
}

// --- Review ---

export function transformReview(json: any, owner: string, repo: string, prNumber: number, graph: string): Quad[] {
  if (!json?.id) return [];

  const uri = reviewUri(owner, repo, prNumber, json.id);
  const quads: Quad[] = [
    tripleUri(uri, `${RDF}type`, `${GH}Review`, graph),
    tripleUri(uri, `${RDF}type`, `${PROV}Activity`, graph),
    tripleUri(uri, `${GH}reviewOf`, prUri(owner, repo, prNumber), graph),
  ];

  if (typeof json.id === 'number') quads.push(tripleInt(uri, `${GH}githubId`, json.id, graph));
  if (json.node_id) quads.push(tripleStr(uri, `${GH}nodeId`, json.node_id, graph));
  if (json.state) quads.push(tripleStr(uri, `${GH}reviewState`, json.state, graph));
  if (json.body) quads.push(tripleStr(uri, `${GH}body`, json.body, graph));
  if (json.submitted_at) quads.push(tripleDateTime(uri, `${GH}submittedAt`, json.submitted_at, graph));
  if (json.commit_id) quads.push(tripleUri(uri, `${GH}commitReviewed`, commitUri(owner, repo, json.commit_id), graph));
  if (json.html_url) quads.push(tripleStr(uri, `${GH}htmlUrl`, json.html_url, graph));

  if (json.user?.login) {
    quads.push(...transformUser(json.user, graph));
    quads.push(tripleUri(uri, `${GH}author`, userUri(json.user.login), graph));
    quads.push(tripleUri(uri, `${PROV}wasAssociatedWith`, userUri(json.user.login), graph));
  }

  return quads;
}

// --- Review Comment ---

export function transformReviewComment(json: any, owner: string, repo: string, prNumber: number, graph: string): Quad[] {
  if (!json?.id) return [];

  const uri = reviewCommentUri(owner, repo, prNumber, json.id);
  const quads: Quad[] = [
    tripleUri(uri, `${RDF}type`, `${GH}ReviewComment`, graph),
  ];

  if (typeof json.id === 'number') quads.push(tripleInt(uri, `${GH}githubId`, json.id, graph));
  if (json.node_id) quads.push(tripleStr(uri, `${GH}nodeId`, json.node_id, graph));
  if (json.body) quads.push(tripleStr(uri, `${GH}commentBody`, json.body, graph));
  if (json.path) quads.push(tripleStr(uri, `${GH}commentPath`, json.path, graph));
  if (typeof json.line === 'number') quads.push(tripleInt(uri, `${GH}commentLine`, json.line, graph));
  if (json.side) quads.push(tripleStr(uri, `${GH}commentSide`, json.side, graph));
  if (json.created_at) quads.push(tripleDateTime(uri, `${GH}createdAt`, json.created_at, graph));
  if (json.updated_at) quads.push(tripleDateTime(uri, `${GH}updatedAt`, json.updated_at, graph));
  if (json.html_url) quads.push(tripleStr(uri, `${GH}htmlUrl`, json.html_url, graph));

  if (json.pull_request_review_id) {
    quads.push(tripleUri(uri, `${GH}inReview`, reviewUri(owner, repo, prNumber, json.pull_request_review_id), graph));
  }

  if (json.in_reply_to_id) {
    quads.push(tripleUri(uri, `${GH}replyTo`, reviewCommentUri(owner, repo, prNumber, json.in_reply_to_id), graph));
  }

  if (json.user?.login) {
    quads.push(...transformUser(json.user, graph));
    quads.push(tripleUri(uri, `${GH}author`, userUri(json.user.login), graph));
  }

  return quads;
}

// --- Issue ---

export function transformIssue(json: any, owner: string, repo: string, graph: string): Quad[] {
  const number = json.number;
  if (typeof number !== 'number') return [];

  // Skip pull requests disguised as issues (GitHub API includes PRs in /issues)
  if (json.pull_request) return [];

  const uri = issueUri(owner, repo, number);
  const quads: Quad[] = [
    tripleUri(uri, `${RDF}type`, `${GH}Issue`, graph),
    tripleInt(uri, `${GH}issueNumber`, number, graph),
    tripleUri(uri, `${GH}inRepo`, repoUri(owner, repo), graph),
  ];

  if (typeof json.id === 'number') quads.push(tripleInt(uri, `${GH}githubId`, json.id, graph));
  if (json.node_id) quads.push(tripleStr(uri, `${GH}nodeId`, json.node_id, graph));
  if (json.title) quads.push(tripleStr(uri, `${GH}title`, json.title, graph));
  if (json.body) quads.push(tripleStr(uri, `${GH}body`, json.body, graph));
  if (json.state) quads.push(tripleStr(uri, `${GH}state`, json.state, graph));
  if (json.html_url) quads.push(tripleStr(uri, `${GH}htmlUrl`, json.html_url, graph));

  if (json.created_at) quads.push(tripleDateTime(uri, `${GH}createdAt`, json.created_at, graph));
  if (json.updated_at) quads.push(tripleDateTime(uri, `${GH}updatedAt`, json.updated_at, graph));
  if (json.closed_at) quads.push(tripleDateTime(uri, `${GH}closedAt`, json.closed_at, graph));

  if (json.user?.login) {
    quads.push(...transformUser(json.user, graph));
    quads.push(tripleUri(uri, `${GH}author`, userUri(json.user.login), graph));
  }

  if (Array.isArray(json.assignees)) {
    for (const assignee of json.assignees) {
      if (assignee?.login) {
        quads.push(...transformUser(assignee, graph));
        quads.push(tripleUri(uri, `${GH}assignedTo`, userUri(assignee.login), graph));
      }
    }
  }

  if (Array.isArray(json.labels)) {
    for (const label of json.labels) {
      if (label?.name) {
        quads.push(...transformLabel(label, owner, repo, graph));
        quads.push(tripleUri(uri, `${GH}hasLabel`, labelUri(owner, repo, label.name), graph));
      }
    }
  }

  if (json.milestone?.number) {
    quads.push(...transformMilestone(json.milestone, owner, repo, graph));
    quads.push(tripleUri(uri, `${GH}milestone`, milestoneUri(owner, repo, json.milestone.number), graph));
  }

  return quads;
}

// --- Issue Comment ---

export function transformIssueComment(json: any, owner: string, repo: string, issueNumber: number, graph: string): Quad[] {
  if (!json?.id) return [];

  const uri = issueCommentUri(owner, repo, issueNumber, json.id);
  const quads: Quad[] = [
    tripleUri(uri, `${RDF}type`, `${GH}IssueComment`, graph),
    tripleUri(uri, `${GH}commentOn`, issueUri(owner, repo, issueNumber), graph),
  ];

  if (typeof json.id === 'number') quads.push(tripleInt(uri, `${GH}githubId`, json.id, graph));
  if (json.node_id) quads.push(tripleStr(uri, `${GH}nodeId`, json.node_id, graph));
  if (json.body) quads.push(tripleStr(uri, `${GH}commentBody`, json.body, graph));
  if (json.created_at) quads.push(tripleDateTime(uri, `${GH}createdAt`, json.created_at, graph));
  if (json.updated_at) quads.push(tripleDateTime(uri, `${GH}updatedAt`, json.updated_at, graph));
  if (json.html_url) quads.push(tripleStr(uri, `${GH}htmlUrl`, json.html_url, graph));

  if (json.user?.login) {
    quads.push(...transformUser(json.user, graph));
    quads.push(tripleUri(uri, `${GH}author`, userUri(json.user.login), graph));
  }

  return quads;
}

// --- Commit ---

export function transformCommit(json: any, owner: string, repo: string, graph: string): Quad[] {
  const sha = json.sha;
  if (!sha) return [];

  const uri = commitUri(owner, repo, sha);
  const quads: Quad[] = [
    tripleUri(uri, `${RDF}type`, `${GH}Commit`, graph),
    tripleUri(uri, `${RDF}type`, `${PROV}Activity`, graph),
    tripleStr(uri, `${GH}sha`, sha, graph),
    tripleStr(uri, `${GH}shortSha`, sha.slice(0, 7), graph),
    tripleUri(uri, `${GH}inRepo`, repoUri(owner, repo), graph),
  ];

  if (json.node_id) quads.push(tripleStr(uri, `${GH}nodeId`, json.node_id, graph));
  const commitData = json.commit ?? json;

  if (commitData.message) quads.push(tripleStr(uri, `${GH}message`, commitData.message, graph));
  if (json.html_url) quads.push(tripleStr(uri, `${GH}htmlUrl`, json.html_url, graph));

  if (commitData.committer?.date) quads.push(tripleDateTime(uri, `${GH}committedAt`, commitData.committer.date, graph));
  if (commitData.author?.date) quads.push(tripleDateTime(uri, `${GH}authoredAt`, commitData.author.date, graph));

  // Author user (from top-level, not commit.author which is git identity)
  if (json.author?.login) {
    quads.push(...transformUser(json.author, graph));
    quads.push(tripleUri(uri, `${GH}author`, userUri(json.author.login), graph));
    quads.push(tripleUri(uri, `${PROV}wasAssociatedWith`, userUri(json.author.login), graph));
  }

  // Parents
  if (Array.isArray(json.parents)) {
    for (const parent of json.parents) {
      if (parent?.sha) {
        quads.push(tripleUri(uri, `${GH}parentCommit`, commitUri(owner, repo, parent.sha), graph));
      }
    }
    if (json.parents.length > 1) {
      quads.push(tripleBool(uri, `${GH}isMergeCommit`, true, graph));
    }
  }

  // Stats
  if (json.stats) {
    if (typeof json.stats.additions === 'number') quads.push(tripleInt(uri, `${GH}totalAdditions`, json.stats.additions, graph));
    if (typeof json.stats.deletions === 'number') quads.push(tripleInt(uri, `${GH}totalDeletions`, json.stats.deletions, graph));
  }

  return quads;
}

// --- Label ---

export function transformLabel(json: any, owner: string, repo: string, graph: string): Quad[] {
  if (!json?.name) return [];

  const uri = labelUri(owner, repo, json.name);
  const quads: Quad[] = [
    tripleUri(uri, `${RDF}type`, `${GH}Label`, graph),
    tripleStr(uri, `${GH}labelName`, json.name, graph),
  ];

  if (json.color) quads.push(tripleStr(uri, `${GH}labelColor`, json.color, graph));

  return quads;
}

// --- Milestone ---

export function transformMilestone(json: any, owner: string, repo: string, graph: string): Quad[] {
  if (!json?.number) return [];

  const uri = milestoneUri(owner, repo, json.number);
  const quads: Quad[] = [
    tripleUri(uri, `${RDF}type`, `${GH}Milestone`, graph),
    tripleStr(uri, `${GH}milestoneTitle`, json.title ?? `Milestone ${json.number}`, graph),
  ];

  if (json.due_on) quads.push(tripleDateTime(uri, `${GH}dueOn`, json.due_on, graph));
  if (json.state) quads.push(tripleStr(uri, `${GH}state`, json.state, graph));

  return quads;
}

// --- Branch ---

export function transformBranch(json: any, owner: string, repo: string, graph: string): Quad[] {
  if (!json?.name) return [];

  const uri = branchUri(owner, repo, json.name);
  const quads: Quad[] = [
    tripleUri(uri, `${RDF}type`, `${GH}Branch`, graph),
    tripleStr(uri, `${GH}branchName`, json.name, graph),
    tripleUri(uri, `${GH}inRepo`, repoUri(owner, repo), graph),
  ];

  if (typeof json.protected === 'boolean') quads.push(tripleBool(uri, `${GH}protected`, json.protected, graph));
  if (json.commit?.sha) {
    quads.push(tripleUri(uri, `${GH}headCommit`, commitUri(owner, repo, json.commit.sha), graph));
  }

  return quads;
}
