import { describe, expect, it } from 'vitest';

import { InvalidGitLinkError } from '../../errors/links/invalid-git-link.error.js';
import type { GitReceiverBinding } from '../../value-objects/deliveries/git-receiver-binding.value-object.js';
import { decideGitLinkChange, gitLinkIdentity } from './git-link-change.policy.js';

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
const headUpdate = { ...target, trigger: 'pr_head', requestNumber: 214, head } as const;
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

describe('Git link decisions', () => {
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

  it('creates one initial branch fact and leaves its version unchanged on replay', () => {
    const identity = gitLinkIdentity(scope, branch);
    const result = decideGitLinkChange(identity, null, branch);

    expect(result).toEqual({
      state: { identity, status: 'created', version: 1 },
      event: { type: 'branch-created', version: 1 },
    });
    if (result === null) throw new Error('Expected an initial branch fact.');
    expect(decideGitLinkChange(identity, result.state, branch)).toBeNull();
  });

  it('advances open to merged once and ignores an older open delivery after merge', () => {
    const identity = gitLinkIdentity(scope, opened);
    const initial = decideGitLinkChange(identity, null, opened);
    if (initial === null) throw new Error('Expected an initial pull request fact.');
    expect(initial).toEqual({
      state: { identity, status: 'open', version: 1 },
      event: { type: 'pull-request-opened', version: 1 },
    });
    expect(decideGitLinkChange(identity, initial.state, opened)).toBeNull();

    const terminal = decideGitLinkChange(identity, initial.state, merged);
    if (terminal === null) throw new Error('Expected a pull request merge fact.');
    expect(terminal).toEqual({
      state: { identity, status: 'merged', version: 2 },
      event: { type: 'pull-request-merged', version: 2 },
    });
    expect(decideGitLinkChange(identity, terminal.state, opened)).toBeNull();
    expect(decideGitLinkChange(identity, terminal.state, merged)).toBeNull();
  });

  it('records a merge that arrives first and refuses the later open as a regression', () => {
    const identity = gitLinkIdentity(scope, merged);
    const result = decideGitLinkChange(identity, null, merged);

    expect(result).toEqual({
      state: { identity, status: 'merged', version: 1 },
      event: { type: 'pull-request-merged', version: 1 },
    });
    if (result === null) throw new Error('Expected an initial terminal fact.');
    expect(decideGitLinkChange(identity, result.state, opened)).toBeNull();
  });

  it('records a close once and ignores a late open both before and after a verified merge', () => {
    const identity = gitLinkIdentity(scope, opened);
    const initial = decideGitLinkChange(identity, null, opened);
    if (initial === null) throw new Error('Expected an initial pull request fact.');

    const closure = decideGitLinkChange(identity, initial.state, closed);
    expect(closure).toEqual({
      state: { identity, status: 'closed', version: 2 },
      event: { type: 'pull-request-closed', version: 2 },
    });
    if (closure === null) throw new Error('Expected a pull request close fact.');
    expect(decideGitLinkChange(identity, closure.state, closed)).toBeNull();
    expect(decideGitLinkChange(identity, closure.state, opened)).toBeNull();

    const terminal = decideGitLinkChange(identity, closure.state, merged);
    expect(terminal).toEqual({
      state: { identity, status: 'merged', version: 3 },
      event: { type: 'pull-request-merged', version: 3 },
    });
    if (terminal === null) throw new Error('Expected a pull request merge fact.');
    expect(decideGitLinkChange(identity, terminal.state, opened)).toBeNull();
    expect(decideGitLinkChange(identity, terminal.state, closed)).toBeNull();
  });

  it('records a close that arrives before the corresponding open as the initial version', () => {
    const identity = gitLinkIdentity(scope, closed);
    const closure = decideGitLinkChange(identity, null, closed);
    expect(closure).toEqual({
      state: { identity, status: 'closed', version: 1 },
      event: { type: 'pull-request-closed', version: 1 },
    });
    if (closure === null) throw new Error('Expected an initial pull request close fact.');
    expect(decideGitLinkChange(identity, closure.state, opened)).toBeNull();
  });

  it.each([headUpdate, completedChecks])(
    'keeps $trigger out of the lifecycle transition',
    (fact) => {
      const identity = gitLinkIdentity(scope, opened);
      const initial = decideGitLinkChange(identity, null, opened);
      if (initial === null) throw new Error('Expected an initial pull request fact.');

      expect(gitLinkIdentity(scope, fact)).toEqual(identity);
      expect(decideGitLinkChange(identity, null, fact)).toBeNull();
      expect(decideGitLinkChange(identity, initial.state, fact)).toBeNull();
    },
  );

  it('refuses to attach check evidence to a different request number', () => {
    expect(() => gitLinkIdentity(scope, { ...completedChecks, requestNumber: 215 })).toThrow(
      InvalidGitLinkError,
    );
  });

  it('refuses an unrelated existing link or a delivery for a different provider object', () => {
    const identity = gitLinkIdentity(scope, opened);
    const existing = {
      identity: gitLinkIdentity(
        { ...scope, binding: { ...scope.binding, repositoryId: 101 } },
        opened,
      ),
      status: 'open',
      version: 1,
    } as const;

    expect(() => decideGitLinkChange(identity, existing, merged)).toThrow(InvalidGitLinkError);
    expect(() => decideGitLinkChange(identity, null, branch)).toThrow(InvalidGitLinkError);
    expect(() => decideGitLinkChange(identity, null, { ...merged, requestNumber: 215 })).toThrow(
      InvalidGitLinkError,
    );
  });

  it('refuses invalid snapshots and version overflow before returning any fact', () => {
    const identity = gitLinkIdentity(scope, opened);
    expect(() =>
      decideGitLinkChange(identity, { identity, status: 'created', version: 1 }, merged),
    ).toThrow(InvalidGitLinkError);
    expect(() =>
      decideGitLinkChange(identity, { identity, status: 'open', version: 0 }, merged),
    ).toThrow(InvalidGitLinkError);
    expect(() =>
      decideGitLinkChange(
        identity,
        { identity, status: 'open', version: Number.MAX_SAFE_INTEGER },
        merged,
      ),
    ).toThrow(InvalidGitLinkError);
  });

  it('refuses an empty branch or a non-positive provider request number', () => {
    expect(() => gitLinkIdentity(scope, { ...branch, branch: '' })).toThrow(InvalidGitLinkError);
    expect(() => gitLinkIdentity(scope, { ...opened, requestNumber: 0 })).toThrow(
      InvalidGitLinkError,
    );
  });
});
