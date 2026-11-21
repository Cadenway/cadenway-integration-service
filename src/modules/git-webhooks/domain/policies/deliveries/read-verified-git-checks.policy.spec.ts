import { describe, expect, it } from 'vitest';

import type { GitReceiverBinding } from '../../value-objects/deliveries/git-receiver-binding.value-object.js';
import { readVerifiedGitChecks } from './read-verified-git-checks.policy.js';

const headSha = 'bcbb5ec396a2c0f828686f14fac9b80b780504f2';
const githubBinding: GitReceiverBinding = {
  provider: 'github',
  repositoryId: 501,
  installationId: 41,
};
const gitlabBinding: GitReceiverBinding = { provider: 'gitlab', repositoryId: 701 };
const githubRepository = { id: 501, full_name: 'atelier-nord/web' };
const githubPullRequest = {
  number: 214,
  head: { ref: 'cad-482-sso', sha: headSha, repo: githubRepository },
  base: { ref: 'main', sha: 'f'.repeat(40), repo: githubRepository },
  url: 'https://provider.invalid/private-pull-request',
};
const githubSuite = {
  id: 315,
  status: 'completed',
  conclusion: 'startup_failure',
  head_branch: 'cad-482-sso',
  head_sha: headSha,
  updated_at: '2026-11-08T16:18:44-04:00',
  pull_requests: [githubPullRequest],
};
const githubCompleted = {
  action: 'completed',
  repository: githubRepository,
  installation: { id: 41 },
  check_suite: githubSuite,
};
const gitlabPipeline = {
  id: 31,
  iid: 3,
  ref: 'master',
  tag: false,
  sha: headSha,
  source: 'merge_request_event',
  status: 'failed',
  finished_at: '2026-11-08T20:18:44.125Z',
};
const gitlabMergeRequest = {
  iid: 44,
  source_branch: 'cad-482-sso',
  source_project_id: 701,
  target_project_id: 701,
  title: 'CAD-482 écran de connexion',
};
const gitlabCompleted = {
  object_kind: 'pipeline',
  object_attributes: gitlabPipeline,
  project: { id: 701 },
  merge_request: gitlabMergeRequest,
  commit: { id: headSha, message: 'References CAD-482.' },
};

describe('readVerifiedGitChecks', () => {
  it('extracts a single same-repository GitHub PR and the authenticated suite revision and time', () => {
    expect(readVerifiedGitChecks(githubBinding, githubCompleted)).toEqual({
      requestNumber: 214,
      headSha,
      attemptId: 315,
      completedAtMs: Date.UTC(2026, 10, 8, 20, 18, 44),
    });
  });

  it('extracts the documented GitLab MR and pipeline correlation without request text', () => {
    expect(readVerifiedGitChecks(gitlabBinding, gitlabCompleted)).toEqual({
      requestNumber: 44,
      headSha,
      attemptId: 31,
      completedAtMs: Date.UTC(2026, 10, 8, 20, 18, 44, 125),
    });
  });

  it.each([
    { action: 'rerequested' },
    { repository: { id: 502 } },
    { installation: { id: 42 } },
    { installation: undefined },
  ])('ignores GitHub envelopes without the terminal action and verified binding', (overrides) => {
    expect(readVerifiedGitChecks(githubBinding, { ...githubCompleted, ...overrides })).toBeNull();
  });

  it.each([
    { id: 0 },
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { status: 'in_progress' },
    { conclusion: null },
    { conclusion: 'in_progress' },
    { updated_at: undefined },
    { updated_at: '2026-02-30T20:18:44Z' },
    { updated_at: '2026-11-08T20:18:44' },
    { updated_at: '1970-01-01T00:00:00Z' },
    { updated_at: '2026-11-08T20:18:44Z\n' },
    { head_sha: '0'.repeat(40) },
    { head_branch: null },
    { pull_requests: undefined },
    { pull_requests: [] },
    { pull_requests: [githubPullRequest, { ...githubPullRequest, number: 215 }] },
    { pull_requests: [{ ...githubPullRequest, number: '214' }] },
    {
      pull_requests: [{ ...githubPullRequest, head: { ...githubPullRequest.head, ref: 'other' } }],
    },
    {
      pull_requests: [
        { ...githubPullRequest, head: { ...githubPullRequest.head, sha: 'a'.repeat(40) } },
      ],
    },
    {
      pull_requests: [
        { ...githubPullRequest, head: { ...githubPullRequest.head, repo: { id: 502 } } },
      ],
    },
    {
      pull_requests: [
        { ...githubPullRequest, base: { ...githubPullRequest.base, repo: { id: 502 } } },
      ],
    },
  ])('ignores malformed, ambiguous or cross-repository GitHub suite evidence', (overrides) => {
    expect(
      readVerifiedGitChecks(githubBinding, {
        ...githubCompleted,
        check_suite: { ...githubSuite, ...overrides },
      }),
    ).toBeNull();
  });

  it.each([
    { object_kind: 'merge_request' },
    { project: { id: 702 } },
    { merge_request: null },
    { merge_request: { ...gitlabMergeRequest, iid: 0 } },
    { merge_request: { ...gitlabMergeRequest, source_project_id: 702 } },
    { merge_request: { ...gitlabMergeRequest, target_project_id: 702 } },
    { commit: { id: 'a'.repeat(40) } },
    { commit: undefined },
  ])('ignores invalid or cross-project GitLab MR correlation', (overrides) => {
    expect(readVerifiedGitChecks(gitlabBinding, { ...gitlabCompleted, ...overrides })).toBeNull();
  });

  it.each([
    { id: -1 },
    { tag: true },
    { source: 'push' },
    { status: 'manual' },
    { status: 'running' },
    { sha: 'invalid' },
    { finished_at: null },
    { finished_at: '2026-11-08T20:18:44-24:00' },
  ])('ignores a GitLab pipeline without explicit terminal MR evidence', (overrides) => {
    expect(
      readVerifiedGitChecks(gitlabBinding, {
        ...gitlabCompleted,
        object_attributes: { ...gitlabPipeline, ...overrides },
      }),
    ).toBeNull();
  });

  it('does not infer a provider or a pull request from unstructured parts of a delivery', () => {
    expect(readVerifiedGitChecks(githubBinding, gitlabCompleted)).toBeNull();
    expect(readVerifiedGitChecks(gitlabBinding, githubCompleted)).toBeNull();
    expect(readVerifiedGitChecks(githubBinding, ['CAD-482'])).toBeNull();
  });
});
