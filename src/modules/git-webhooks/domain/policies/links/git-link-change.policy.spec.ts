import { describe, expect, it } from 'vitest';

import { InvalidGitLinkError } from '../../errors/links/invalid-git-link.error.js';
import type { GitReceiverBinding } from '../../value-objects/deliveries/git-receiver-binding.value-object.js';
import { gitLinkDeliveryOf, gitLinkIdentity } from './git-link-change.policy.js';

const scope = {
  organizationId: '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f',
  receiverId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01',
  taskId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e02',
  binding: {
    provider: 'github',
    repositoryId: 100,
    installationId: 200,
  } satisfies GitReceiverBinding,
};
const target = { kind: 'actionable', taskKeys: ['CAD-482'], closingTaskKeys: [] } as const;
const branch = { ...target, trigger: 'branch', branch: 'feature/CAD-482' } as const;
const opened = { ...target, trigger: 'pr_open', requestNumber: 214 } as const;
const merged = { ...target, trigger: 'pr_merged', requestNumber: 214 } as const;
const closed = { ...target, trigger: 'pr_closed', requestNumber: 214 } as const;
const head = { sha: 'b'.repeat(40), observedAtMs: Date.UTC(2026, 10, 8, 20, 18, 44) };
const completedChecks = {
  ...target,
  trigger: 'pr_checks',
  requestNumber: 214,
  checks: {
    requestNumber: 214,
    headSha: head.sha,
    attemptId: 315,
    completedAtMs: head.observedAtMs + 60_000,
  },
} as const;

describe('Git link identity', () => {
  it('retains the exact case of a branch reference and distinguishes branch and request identities', () => {
    expect(gitLinkIdentity(scope, branch)).toEqual({
      ...scope,
      kind: 'branch',
      ref: 'feature/CAD-482',
    });
    expect(gitLinkIdentity(scope, branch)).not.toEqual(
      gitLinkIdentity(scope, { ...branch, branch: 'feature/cad-482' }),
    );
    expect(gitLinkIdentity(scope, { ...branch, branch: '214' })).not.toEqual(
      gitLinkIdentity(scope, opened),
    );
  });

  it('shares one request identity across open and merge in the same repository and task', () => {
    expect(gitLinkIdentity(scope, opened)).toEqual(gitLinkIdentity(scope, merged));
    expect(gitLinkIdentity(scope, opened)).toEqual(gitLinkIdentity(scope, closed));
    const otherScopes = [
      { ...scope, organizationId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03' },
      { ...scope, taskId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03' },
      { ...scope, receiverId: '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e03' },
      { ...scope, binding: { ...scope.binding, repositoryId: 101 } },
      { ...scope, binding: { ...scope.binding, installationId: 201 } },
      { ...scope, binding: { provider: 'gitlab', repositoryId: 100 } as const },
    ];
    for (const otherScope of otherScopes) {
      expect(gitLinkIdentity(otherScope, opened)).not.toEqual(gitLinkIdentity(scope, opened));
    }
  });

  it('refuses checks correlated with another request', () => {
    expect(() => gitLinkIdentity(scope, { ...completedChecks, requestNumber: 215 })).toThrow(
      InvalidGitLinkError,
    );
  });

  it('refuses an empty branch or a non-positive provider request number', () => {
    expect(() => gitLinkIdentity(scope, { ...branch, branch: '' })).toThrow(InvalidGitLinkError);
    expect(() => gitLinkIdentity(scope, { ...opened, requestNumber: 0 })).toThrow(
      InvalidGitLinkError,
    );
  });
});

describe('Git link delivery contribution', () => {
  it('lets a branch, an opening and a merge citing CAD-482 create the link', () => {
    expect(gitLinkDeliveryOf(branch, 'CAD-482')).toMatchObject({ kind: 'branch', creates: true });
    expect(gitLinkDeliveryOf(opened, 'CAD-482')).toMatchObject({
      creates: true,
      lifecycle: { state: 'open', observedAtMs: null },
    });
    expect(gitLinkDeliveryOf(merged, 'CAD-482')).toMatchObject({
      creates: true,
      lifecycle: { state: 'merged' },
    });
  });

  it('only updates existing links for an inferred merge target, a closure or a reopen', () => {
    expect(
      gitLinkDeliveryOf({ ...merged, referencedTaskKeys: ['CAD-483'] }, 'CAD-482').creates,
    ).toBe(false);
    expect(gitLinkDeliveryOf(closed, 'CAD-482')).toMatchObject({
      creates: false,
      lifecycle: { state: 'closed' },
    });
    expect(
      gitLinkDeliveryOf({ ...target, trigger: 'pr_reopened', requestNumber: 214 }, 'CAD-482'),
    ).toMatchObject({ creates: false, lifecycle: { state: 'open' } });
  });

  it('orders a lifecycle action at the request provider time and records where CAD-482 was found', () => {
    const delivery = gitLinkDeliveryOf(
      {
        ...opened,
        head,
        request: {
          state: { state: 'open', observedAtMs: head.observedAtMs },
          members: { title: 'feat(auth): unified SSO sign-in screen' },
        },
        linkSources: { 'CAD-482': 'title' },
      },
      'CAD-482',
    );
    expect(delivery).toEqual({
      kind: 'pull-request',
      creates: true,
      lifecycle: { state: 'open', observedAtMs: head.observedAtMs },
      members: { title: 'feat(auth): unified SSO sign-in screen' },
      membersObservedAtMs: head.observedAtMs,
      head,
      checksHeadSha: null,
      linkSource: 'title',
    });
  });

  it('realigns from the reported state of an update and of a GitLab pipeline only', () => {
    const state = { state: 'merged', observedAtMs: head.observedAtMs } as const;
    expect(
      gitLinkDeliveryOf(
        {
          ...target,
          trigger: 'pr_updated',
          requestNumber: 214,
          request: { state, members: {} },
        },
        'CAD-482',
      ).lifecycle,
    ).toEqual(state);
    expect(gitLinkDeliveryOf({ ...completedChecks, requestState: state }, 'CAD-482')).toMatchObject(
      { lifecycle: state, checksHeadSha: head.sha, creates: false },
    );
    expect(gitLinkDeliveryOf(completedChecks, 'CAD-482').lifecycle).toBeNull();
    expect(
      gitLinkDeliveryOf({ ...target, trigger: 'pr_head', requestNumber: 214, head }, 'CAD-482'),
    ).toMatchObject({ lifecycle: null, head, creates: false });
  });
});
