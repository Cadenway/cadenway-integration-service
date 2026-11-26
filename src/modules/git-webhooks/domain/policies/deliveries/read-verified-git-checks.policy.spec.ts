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
const suiteTime = Date.UTC(2026, 10, 8, 20, 18, 44);
const gitlabPipeline = {
  id: 31,
  iid: 3,
  ref: 'master',
  tag: false,
  sha: headSha,
  source: 'merge_request_event',
  status: 'failed',
  created_at: '2026-11-08 20:10:00 UTC',
  finished_at: '2026-11-08T20:18:44.125Z',
};
const gitlabMergeRequest = {
  iid: 44,
  source_branch: 'cad-482-sso',
  source_project_id: 701,
  target_project_id: 701,
  title: 'CAD-482 écran de connexion',
  state: 'opened',
};
const gitlabCompleted = {
  object_kind: 'pipeline',
  object_attributes: gitlabPipeline,
  project: { id: 701 },
  merge_request: gitlabMergeRequest,
  commit: { id: headSha, message: 'References CAD-482.' },
  builds: [{ status: 'failed' }, { status: 'success' }, { status: 'skipped' }],
};
const pipelineTime = Date.UTC(2026, 10, 8, 20, 18, 44, 125);

describe('readVerifiedGitChecks', () => {
  it('reads a completed GitHub suite and the single same-repository PR it names', () => {
    expect(readVerifiedGitChecks(githubBinding, githubCompleted)).toEqual({
      observation: {
        provider: 'github',
        attemptId: 315,
        headSha,
        observedAtMs: suiteTime,
        completedAtMs: suiteTime,
        status: 'completed',
        conclusion: 'startup_failure',
      },
      request: { number: 214 },
    });
  });

  it.each(['requested', 'rerequested'])(
    'reads a GitHub %s suite as a running observation',
    (action) => {
      expect(
        readVerifiedGitChecks(githubBinding, {
          ...githubCompleted,
          action,
          check_suite: { ...githubSuite, status: 'queued', conclusion: null },
        }),
      ).toMatchObject({
        observation: { status: 'queued', conclusion: null, completedAtMs: null },
        request: { number: 214 },
      });
    },
  );

  it.each([
    { pull_requests: undefined },
    { pull_requests: [] },
    { pull_requests: [githubPullRequest, { ...githubPullRequest, number: 215 }] },
    { pull_requests: [{ ...githubPullRequest, number: '214' }] },
    { head_branch: null },
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
  ])('keeps the observation but names no request for ambiguous PR evidence', (overrides) => {
    const checks = readVerifiedGitChecks(githubBinding, {
      ...githubCompleted,
      check_suite: { ...githubSuite, ...overrides },
    });
    expect(checks?.observation).toMatchObject({ attemptId: 315, headSha });
    expect(checks).not.toHaveProperty('request');
  });

  it('reads a GitLab merge request pipeline with its jobs and the request state', () => {
    expect(readVerifiedGitChecks(gitlabBinding, gitlabCompleted)).toEqual({
      observation: {
        provider: 'gitlab',
        attemptId: 31,
        headSha,
        observedAtMs: pipelineTime,
        completedAtMs: pipelineTime,
        status: 'failed',
        jobTotal: 3,
        jobFailed: 1,
      },
      request: { number: 44, state: { state: 'open', observedAtMs: pipelineTime } },
    });
  });

  it.each(['created', 'pending', 'running'])(
    'orders a %s GitLab pipeline by its creation time in the GitLab format',
    (status) => {
      expect(
        readVerifiedGitChecks(gitlabBinding, {
          ...gitlabCompleted,
          builds: undefined,
          object_attributes: { ...gitlabPipeline, status, finished_at: null },
        }),
      ).toMatchObject({
        observation: {
          status,
          observedAtMs: Date.UTC(2026, 10, 8, 20, 10),
          completedAtMs: null,
        },
      });
    },
  );

  it.each([
    { action: 'created' },
    { repository: { id: 502 } },
    { installation: { id: 42 } },
    { installation: undefined },
  ])('ignores GitHub envelopes without a supported action and verified binding', (overrides) => {
    expect(readVerifiedGitChecks(githubBinding, { ...githubCompleted, ...overrides })).toBeNull();
  });

  it.each([
    { id: 0 },
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { status: 'in_progress' },
    { status: 'unknown' },
    { conclusion: null },
    { conclusion: 'in_progress' },
    { updated_at: undefined },
    { updated_at: '2026-02-30T20:18:44Z' },
    { updated_at: '2026-11-08T20:18:44' },
    { updated_at: '1970-01-01T00:00:00Z' },
    { updated_at: '2026-11-08T20:18:44Z\n' },
    { head_sha: '0'.repeat(40) },
  ])('ignores malformed GitHub suite evidence', (overrides) => {
    expect(
      readVerifiedGitChecks(githubBinding, {
        ...githubCompleted,
        check_suite: { ...githubSuite, ...overrides },
      }),
    ).toBeNull();
  });

  it('ignores a requested GitHub suite that already carries a conclusion', () => {
    expect(
      readVerifiedGitChecks(githubBinding, {
        ...githubCompleted,
        action: 'requested',
        check_suite: { ...githubSuite, status: 'queued' },
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
    { sha: 'invalid' },
    { finished_at: null },
    { finished_at: '2026-11-08T20:18:44-24:00' },
    { status: 'running', created_at: null },
  ])('ignores a GitLab pipeline without explicit MR evidence and provider time', (overrides) => {
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
