/**
 * Canned GitHub API response fixtures for tests.
 *
 * Based on real GitHub REST API v3 response shapes.
 * See: https://docs.github.com/en/rest
 */

export const sampleUser = {
  login: 'octocat',
  id: 1,
  node_id: 'MDQ6VXNlcjE=',
  avatar_url: 'https://github.com/images/error/octocat_happy.gif',
  type: 'User',
  html_url: 'https://github.com/octocat',
};

export const sampleRepository = {
  id: 1296269,
  node_id: 'MDEwOlJlcG9zaXRvcnkxMjk2MjY5',
  name: 'Hello-World',
  full_name: 'octocat/Hello-World',
  private: false,
  owner: sampleUser,
  html_url: 'https://github.com/octocat/Hello-World',
  description: 'This your first repo!',
  fork: false,
  url: 'https://api.github.com/repos/octocat/Hello-World',
  default_branch: 'main',
  created_at: '2011-01-26T19:01:12Z',
  updated_at: '2024-01-01T00:00:00Z',
};

export const samplePullRequest = {
  id: 1,
  node_id: 'MDExOlB1bGxSZXF1ZXN0MQ==',
  number: 42,
  state: 'open' as const,
  title: 'Add feature X',
  body: 'This PR adds feature X to the project.',
  user: sampleUser,
  html_url: 'https://github.com/octocat/Hello-World/pull/42',
  created_at: '2024-01-15T10:00:00Z',
  updated_at: '2024-01-16T14:30:00Z',
  merged_at: null,
  merge_commit_sha: null,
  head: {
    ref: 'feature-x',
    sha: 'abc1234567890def1234567890abcdef12345678',
    repo: sampleRepository,
  },
  base: {
    ref: 'main',
    sha: 'def0987654321abc0987654321fedcba09876543',
    repo: sampleRepository,
  },
  draft: false,
  additions: 150,
  deletions: 30,
  changed_files: 5,
  labels: [{ id: 1, name: 'enhancement', color: '84b6eb' }],
  requested_reviewers: [],
  comments: 2,
  review_comments: 1,
  commits: 3,
};

export const sampleReview = {
  id: 100,
  node_id: 'MDE3OlB1bGxSZXF1ZXN0UmV2aWV3MTAw',
  user: { ...sampleUser, login: 'reviewer-1', id: 2 },
  body: 'Looks good overall, a few minor suggestions.',
  state: 'APPROVED' as const,
  html_url: 'https://github.com/octocat/Hello-World/pull/42#pullrequestreview-100',
  pull_request_url: 'https://api.github.com/repos/octocat/Hello-World/pulls/42',
  submitted_at: '2024-01-16T12:00:00Z',
  commit_id: 'abc1234567890def1234567890abcdef12345678',
};

export const sampleIssue = {
  id: 200,
  node_id: 'MDU6SXNzdWUyMDA=',
  number: 10,
  state: 'open' as const,
  title: 'Bug: crash on startup',
  body: 'The app crashes when launched without config file.',
  user: sampleUser,
  html_url: 'https://github.com/octocat/Hello-World/issues/10',
  created_at: '2024-01-10T08:00:00Z',
  updated_at: '2024-01-12T09:00:00Z',
  closed_at: null,
  labels: [{ id: 2, name: 'bug', color: 'd73a4a' }],
  assignees: [sampleUser],
  comments: 3,
};

export const sampleCommit = {
  sha: 'abc1234567890def1234567890abcdef12345678',
  node_id: 'MDY6Q29tbWl0YWJjMTIz',
  html_url: 'https://github.com/octocat/Hello-World/commit/abc1234567890def1234567890abcdef12345678',
  commit: {
    message: 'feat: add feature X implementation',
    author: {
      name: 'Octocat',
      email: 'octocat@github.com',
      date: '2024-01-15T10:00:00Z',
    },
    committer: {
      name: 'Octocat',
      email: 'octocat@github.com',
      date: '2024-01-15T10:00:00Z',
    },
    tree: { sha: 'tree123', url: '' },
  },
  author: sampleUser,
  committer: sampleUser,
  parents: [{ sha: 'parent123', url: '', html_url: '' }],
};

/** Webhook payload for a pull_request event (opened). */
export const samplePullRequestWebhook = {
  action: 'opened' as const,
  number: samplePullRequest.number,
  pull_request: samplePullRequest,
  repository: sampleRepository,
  sender: sampleUser,
};

/** Webhook payload for a pull_request_review event (submitted). */
export const sampleReviewWebhook = {
  action: 'submitted' as const,
  review: sampleReview,
  pull_request: samplePullRequest,
  repository: sampleRepository,
  sender: sampleReview.user,
};

/** Webhook payload for an issues event (opened). */
export const sampleIssueWebhook = {
  action: 'opened' as const,
  issue: sampleIssue,
  repository: sampleRepository,
  sender: sampleUser,
};
