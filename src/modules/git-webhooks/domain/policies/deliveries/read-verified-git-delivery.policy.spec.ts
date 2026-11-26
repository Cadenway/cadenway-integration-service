import { describe, expect, it } from 'vitest';

import type { GitReceiverBinding } from '../../value-objects/deliveries/git-receiver-binding.value-object.js';
import { readVerifiedGitDelivery } from './read-verified-git-delivery.policy.js';

const githubBinding: GitReceiverBinding = {
  provider: 'github',
  installationId: 41,
  repositoryId: 501,
};
const gitlabBinding: GitReceiverBinding = { provider: 'gitlab', repositoryId: 701 };
const githubRepository = { id: 501, full_name: 'atelier-nord/web' };
const githubCreate = {
  repository: githubRepository,
  installation: { id: 41 },
  master_branch: 'main',
  ref_type: 'branch',
  ref: 'cad-482-ecran-connexion-sso',
};
const githubPullRequest = {
  repository: githubRepository,
  installation: { id: 41 },
  number: 214,
  action: 'opened',
  pull_request: {
    number: 214,
    state: 'open',
    merged: false,
    head: { ref: 'cad-482-ecran-connexion-sso', repo: githubRepository },
    base: { ref: 'main', repo: githubRepository },
    title: 'feat(auth) : écran de connexion SSO unifié (CAD-482)',
    body: null,
  },
};
const previousHead = 'a'.repeat(40);
const observedHead = 'b'.repeat(40);
const githubSync = {
  ...githubPullRequest,
  action: 'synchronize',
  before: previousHead,
  after: observedHead,
  pull_request: {
    ...githubPullRequest.pull_request,
    head: { ...githubPullRequest.pull_request.head, sha: observedHead },
    updated_at: '2026-11-08T16:18:44-04:00',
  },
};
const gitlabProject = { id: 701, path_with_namespace: 'atelier-nord/auth' };
const gitlabNewBranch = {
  object_kind: 'push',
  event_name: 'push',
  project: gitlabProject,
  project_id: 701,
  before: '0'.repeat(40),
  after: 'a'.repeat(40),
  ref: 'refs/heads/cad-479-limite-debit-jetons',
  commits: [{ message: 'CAD-482 : squelette de l’écran SSO' }],
};
const gitlabMergeRequest = {
  object_kind: 'merge_request',
  event_type: 'merge_request',
  project: gitlabProject,
  object_attributes: {
    iid: 31,
    state: 'opened',
    action: 'open',
    source_project_id: 701,
    target_project_id: 701,
    source_branch: 'rotation-cles',
    title: 'Rotation automatique des clés (CAD-466)',
    description: null,
    last_commit: { message: 'Prend en charge CAD-482' },
  },
};
const gitlabUpdate = {
  ...gitlabMergeRequest,
  object_attributes: {
    ...gitlabMergeRequest.object_attributes,
    action: 'update',
    oldrev: previousHead,
    last_commit: { id: observedHead, message: 'Prend en charge CAD-482' },
    updated_at: '2026-11-08T20:18:44.125Z',
  },
};

describe('readVerifiedGitDelivery', () => {
  it('recognizes the GitHub branch by signed create fields even if its repository was renamed', () => {
    expect(
      readVerifiedGitDelivery(githubBinding, {
        ...githubCreate,
        repository: { ...githubRepository, full_name: 'atelier-nord/new-web' },
      }),
    ).toMatchObject({
      kind: 'actionable',
      trigger: 'branch',
      branch: 'cad-482-ecran-connexion-sso',
      taskKeys: ['CAD-482'],
      closingTaskKeys: [],
    });
  });

  it('recognizes the opened GitHub PR for CAD-482 once despite case and repeated mentions', () => {
    expect(readVerifiedGitDelivery(githubBinding, githubPullRequest)).toMatchObject({
      kind: 'actionable',
      trigger: 'pr_open',
      requestNumber: 214,
      taskKeys: ['CAD-482'],
      closingTaskKeys: [],
    });
  });

  it('keeps valid signed GitHub head metadata on a PR lifecycle fact', () => {
    expect(
      readVerifiedGitDelivery(githubBinding, {
        ...githubPullRequest,
        pull_request: githubSync.pull_request,
      }),
    ).toMatchObject({
      trigger: 'pr_open',
      taskKeys: ['CAD-482'],
      head: { sha: observedHead, observedAtMs: Date.UTC(2026, 10, 8, 20, 18, 44) },
    });
  });

  it('records a same-repository GitHub synchronize as a head-only observation', () => {
    expect(readVerifiedGitDelivery(githubBinding, githubSync)).toMatchObject({
      kind: 'actionable',
      trigger: 'pr_updated',
      requestNumber: 214,
      head: { sha: observedHead, observedAtMs: Date.UTC(2026, 10, 8, 20, 18, 44) },
      taskKeys: [],
      closingTaskKeys: [],
    });
  });

  it.each([
    { ...githubSync, before: '0'.repeat(40) },
    { ...githubSync, before: observedHead },
    { ...githubSync, after: previousHead },
    {
      ...githubSync,
      pull_request: { ...githubSync.pull_request, updated_at: '2026-02-30T20:18:44Z' },
    },
    {
      ...githubSync,
      pull_request: { ...githubSync.pull_request, state: 'closed' },
    },
    {
      ...githubSync,
      pull_request: {
        ...githubSync.pull_request,
        head: { ...githubSync.pull_request.head, repo: { id: 502 } },
      },
    },
  ])('ignores a GitHub synchronize with invalid revision evidence or repository', (body) => {
    expect(readVerifiedGitDelivery(githubBinding, body)).toEqual({ kind: 'ignored' });
  });

  it('recognizes an opened GitHub PR while its merge flag is unavailable', () => {
    expect(
      readVerifiedGitDelivery(githubBinding, {
        ...githubPullRequest,
        pull_request: { ...githubPullRequest.pull_request, merged: null },
      }),
    ).toMatchObject({ kind: 'actionable', trigger: 'pr_open', taskKeys: ['CAD-482'] });
  });

  it('distinguishes a merged GitHub PR and preserves distinct close-on-merge references', () => {
    expect(
      readVerifiedGitDelivery(githubBinding, {
        ...githubPullRequest,
        action: 'closed',
        pull_request: {
          ...githubPullRequest.pull_request,
          state: 'closed',
          merged: true,
          body: 'Fixes CAD-473, closes cad-482 and resolves CAD-466. References CAD-475.',
        },
      }),
    ).toMatchObject({
      kind: 'actionable',
      trigger: 'pr_merged',
      requestNumber: 214,
      taskKeys: ['CAD-482', 'CAD-473', 'CAD-466', 'CAD-475'],
      closingTaskKeys: ['CAD-473', 'CAD-482', 'CAD-466'],
    });
  });

  it('recognizes a GitHub PR closed without a merge and drops closing intent', () => {
    expect(
      readVerifiedGitDelivery(githubBinding, {
        ...githubPullRequest,
        action: 'closed',
        pull_request: {
          ...githubPullRequest.pull_request,
          state: 'closed',
          merged: false,
          body: 'Fixes CAD-473.',
        },
      }),
    ).toMatchObject({
      kind: 'actionable',
      trigger: 'pr_closed',
      requestNumber: 214,
      taskKeys: ['CAD-482', 'CAD-473'],
      closingTaskKeys: [],
    });
  });

  it.each([
    [false, 'pr_closed'],
    [true, 'pr_merged'],
  ])(
    'preserves a reference-free GitHub closure (merged: %s) for request lookup',
    (merged, trigger) => {
      expect(
        readVerifiedGitDelivery(githubBinding, {
          ...githubPullRequest,
          action: 'closed',
          pull_request: {
            ...githubPullRequest.pull_request,
            state: 'closed',
            merged,
            head: { ...githubPullRequest.pull_request.head, ref: 'feature/sso' },
            title: 'Login improvements',
          },
        }),
      ).toMatchObject({
        kind: 'actionable',
        trigger,
        requestNumber: 214,
        taskKeys: [],
        closingTaskKeys: [],
      });
    },
  );

  it.each([
    { ...githubPullRequest, action: 'synchronize' },
    { ...githubPullRequest, action: 'closed' },
    {
      ...githubPullRequest,
      action: 'closed',
      pull_request: { ...githubPullRequest.pull_request, state: 'closed', merged: null },
    },
    { ...githubPullRequest, number: 215 },
    { ...githubCreate, ref_type: 'tag' },
    {
      repository: githubRepository,
      installation: { id: 41 },
      ref_type: 'branch',
      ref: 'cad-482-ecran-connexion-sso',
    },
    { ...githubCreate, ref: 'sans-reference' },
  ])('ignores bound GitHub deliveries without a supported action and exact reference', (body) => {
    expect(readVerifiedGitDelivery(githubBinding, body)).toEqual({ kind: 'ignored' });
  });

  it.each([
    { ...githubPullRequest, repository: { ...githubRepository, id: 502 } },
    { ...githubPullRequest, installation: { id: 42 } },
    { ...githubPullRequest, repository: { ...githubRepository, id: '501' } },
  ])('rejects missing, malformed or different GitHub provider identity', (body) => {
    expect(readVerifiedGitDelivery(githubBinding, body)).toEqual({ kind: 'repository_mismatch' });
  });

  it.each(['head', 'base'] as const)(
    'ignores a GitHub PR with a different %s repository',
    (side) => {
      expect(
        readVerifiedGitDelivery(githubBinding, {
          ...githubPullRequest,
          pull_request: {
            ...githubPullRequest.pull_request,
            [side]: {
              ...githubPullRequest.pull_request[side],
              repo: { ...githubRepository, id: 502 },
            },
          },
        }),
      ).toEqual({ kind: 'ignored' });
    },
  );

  it('recognizes a new GitLab branch and references from the signed commits', () => {
    expect(readVerifiedGitDelivery(gitlabBinding, gitlabNewBranch)).toMatchObject({
      kind: 'actionable',
      trigger: 'branch',
      branch: 'cad-479-limite-debit-jetons',
      taskKeys: ['CAD-479', 'CAD-482'],
      closingTaskKeys: [],
    });
  });

  it('recognizes the GitLab MR from its signed kind, action, state and project identities', () => {
    expect(readVerifiedGitDelivery(gitlabBinding, gitlabMergeRequest)).toMatchObject({
      kind: 'actionable',
      trigger: 'pr_open',
      requestNumber: 31,
      taskKeys: ['CAD-466', 'CAD-482'],
      closingTaskKeys: [],
    });
    expect(
      readVerifiedGitDelivery(gitlabBinding, {
        ...gitlabMergeRequest,
        object_attributes: {
          ...gitlabMergeRequest.object_attributes,
          action: 'merge',
          state: 'merged',
          description: 'Resolves CAD-466.',
        },
      }),
    ).toMatchObject({
      kind: 'actionable',
      trigger: 'pr_merged',
      requestNumber: 31,
      taskKeys: ['CAD-466', 'CAD-482'],
      closingTaskKeys: ['CAD-466'],
    });
  });

  it('keeps valid signed GitLab head metadata on an MR lifecycle fact', () => {
    expect(
      readVerifiedGitDelivery(gitlabBinding, {
        ...gitlabMergeRequest,
        object_attributes: {
          ...gitlabUpdate.object_attributes,
          action: 'open',
        },
      }),
    ).toMatchObject({
      trigger: 'pr_open',
      taskKeys: ['CAD-466', 'CAD-482'],
      head: { sha: observedHead, observedAtMs: Date.UTC(2026, 10, 8, 20, 18, 44, 125) },
    });
  });

  it('records a GitLab update with a changed revision as a head-only observation', () => {
    expect(readVerifiedGitDelivery(gitlabBinding, gitlabUpdate)).toMatchObject({
      kind: 'actionable',
      trigger: 'pr_updated',
      requestNumber: 31,
      head: { sha: observedHead, observedAtMs: Date.UTC(2026, 10, 8, 20, 18, 44, 125) },
      taskKeys: [],
      closingTaskKeys: [],
    });
  });

  it.each([
    { oldrev: observedHead },
    { last_commit: { id: '0'.repeat(40) } },
    { updated_at: undefined },
    { updated_at: '2026-11-08T20:18:44' },
    { target_project_id: 702 },
  ])(
    'ignores a GitLab MR update with contradictory revision, time or project evidence',
    (overrides) => {
      expect(
        readVerifiedGitDelivery(gitlabBinding, {
          ...gitlabUpdate,
          object_attributes: { ...gitlabUpdate.object_attributes, ...overrides },
        }),
      ).toEqual({ kind: 'ignored' });
    },
  );

  it('recognizes a GitLab close in the same project and drops closing intent', () => {
    expect(
      readVerifiedGitDelivery(gitlabBinding, {
        ...gitlabMergeRequest,
        object_attributes: {
          ...gitlabMergeRequest.object_attributes,
          action: 'close',
          state: 'closed',
          description: 'Resolves CAD-473.',
        },
      }),
    ).toMatchObject({
      kind: 'actionable',
      trigger: 'pr_closed',
      requestNumber: 31,
      taskKeys: ['CAD-466', 'CAD-473', 'CAD-482'],
      closingTaskKeys: [],
    });
  });

  it.each([
    { action: 'close', state: 'closed', trigger: 'pr_closed' },
    { action: 'merge', state: 'merged', trigger: 'pr_merged' },
  ])(
    'preserves a reference-free GitLab $action for request lookup',
    ({ action, state, trigger }) => {
      expect(
        readVerifiedGitDelivery(gitlabBinding, {
          ...gitlabMergeRequest,
          object_attributes: {
            ...gitlabMergeRequest.object_attributes,
            action,
            state,
            title: 'Login improvements',
            last_commit: { message: 'Update the login screen' },
          },
        }),
      ).toMatchObject({
        kind: 'actionable',
        trigger,
        requestNumber: 31,
        taskKeys: [],
        closingTaskKeys: [],
      });
    },
  );

  it.each([
    { ...gitlabNewBranch, before: 'b'.repeat(40) },
    { ...gitlabNewBranch, after: '0'.repeat(40) },
    { ...gitlabNewBranch, commits: null },
    { ...gitlabNewBranch, commits: Array.from({ length: 21 }, () => ({ message: 'CAD-482' })) },
    { ...gitlabNewBranch, ref: 'refs/tags/cad-482' },
    { ...gitlabNewBranch, event_name: 'tag_push' },
    { ...gitlabMergeRequest, object_kind: 'note' },
    {
      ...gitlabMergeRequest,
      object_attributes: {
        ...gitlabMergeRequest.object_attributes,
        action: 'close',
        state: 'closed',
        target_project_id: 702,
      },
    },
    {
      ...gitlabMergeRequest,
      object_attributes: { ...gitlabMergeRequest.object_attributes, action: 'close' },
    },
    {
      ...gitlabMergeRequest,
      object_attributes: { ...gitlabMergeRequest.object_attributes, action: 'merge' },
    },
    {
      ...gitlabMergeRequest,
      object_attributes: { ...gitlabMergeRequest.object_attributes, source_project_id: 702 },
    },
    {
      ...gitlabMergeRequest,
      object_attributes: { ...gitlabMergeRequest.object_attributes, target_project_id: 702 },
    },
  ])('ignores GitLab updates, deletions, tags and contradictory or cross-project MRs', (body) => {
    expect(readVerifiedGitDelivery(gitlabBinding, body)).toEqual({ kind: 'ignored' });
  });

  it.each([
    null,
    [],
    { ...gitlabNewBranch, project_id: 702 },
    { ...gitlabMergeRequest, project: { ...gitlabProject, id: 702 } },
  ])('rejects a missing or conflicting GitLab identity', (body) => {
    expect(readVerifiedGitDelivery(gitlabBinding, body)).toEqual({ kind: 'repository_mismatch' });
  });

  it('matches complete keys without extracting substrings or numbers with leading zeroes', () => {
    expect(
      readVerifiedGitDelivery(githubBinding, {
        ...githubPullRequest,
        pull_request: {
          ...githubPullRequest.pull_request,
          head: { ...githubPullRequest.pull_request.head, ref: 'feature/sso' },
          title:
            'CAD-4820, CAD-0482, A-482, ABCDEF-482, _CAD-482, CAD-482a, éCAD-482, CAD-4820000000 and (cad-482).',
        },
      }),
    ).toMatchObject({ taskKeys: ['CAD-4820', 'CAD-482'] });
  });

  it('ignores a delivery with more than twenty distinct references without selecting a subset', () => {
    expect(
      readVerifiedGitDelivery(githubBinding, {
        ...githubPullRequest,
        pull_request: {
          ...githubPullRequest.pull_request,
          body: Array.from({ length: 21 }, (_, index) => `CAD-${String(index + 1)}`).join(' '),
        },
      }),
    ).toEqual({ kind: 'ignored' });
  });

  it('ignores an oversized closure instead of requesting lookup by PR number', () => {
    expect(
      readVerifiedGitDelivery(githubBinding, {
        ...githubPullRequest,
        action: 'closed',
        pull_request: {
          ...githubPullRequest.pull_request,
          state: 'closed',
          body: Array.from({ length: 21 }, (_, index) => `CAD-${String(index + 1)}`).join(' '),
        },
      }),
    ).toEqual({ kind: 'ignored' });
  });

  it('retains an oversized merge fact without selecting any signed task references', () => {
    expect(
      readVerifiedGitDelivery(githubBinding, {
        ...githubPullRequest,
        action: 'closed',
        pull_request: {
          ...githubPullRequest.pull_request,
          state: 'closed',
          merged: true,
          body: Array.from({ length: 21 }, (_, index) => 'Closes CAD-' + String(index + 1)).join(
            ' ',
          ),
        },
      }),
    ).toMatchObject({
      kind: 'actionable',
      trigger: 'pr_merged',
      taskKeys: [],
      closingTaskKeys: [],
    });
  });

  describe('request state and GitLink members', () => {
    const updatedAt = '2026-11-08T10:41:00Z';
    const observedAtMs = Date.UTC(2026, 10, 8, 10, 41);
    const githubRequest = {
      ...githubPullRequest,
      pull_request: {
        ...githubPullRequest.pull_request,
        html_url: 'https://github.com/atelier-nord/web/pull/214',
        draft: false,
        user: { login: 'cmartin' },
        requested_reviewers: [{ login: 'irobert' }],
        requested_teams: [],
        additions: 418,
        deletions: 132,
        head: { ...githubPullRequest.pull_request.head, sha: observedHead },
        updated_at: updatedAt,
      },
      repository: { ...githubRepository, html_url: 'https://github.com/atelier-nord/web' },
    };
    const githubMembers = {
      title: githubPullRequest.pull_request.title,
      draft: false,
      url: 'https://github.com/atelier-nord/web/pull/214',
      repository: { fullName: 'atelier-nord/web', url: 'https://github.com/atelier-nord/web' },
      sourceBranch: 'cad-482-ecran-connexion-sso',
      author: { login: 'cmartin' },
      reviewRequested: true,
      additions: 418,
      deletions: 132,
    };

    it('records the members and provider time of an opened GitHub PR and where CAD-482 was found', () => {
      expect(readVerifiedGitDelivery(githubBinding, githubRequest)).toEqual({
        kind: 'actionable',
        trigger: 'pr_open',
        requestNumber: 214,
        head: { sha: observedHead, observedAtMs },
        request: { state: { state: 'open', observedAtMs }, members: githubMembers },
        taskKeys: ['CAD-482'],
        closingTaskKeys: [],
        linkSources: { 'CAD-482': 'branch' },
      });
    });

    it('recognizes a GitHub reopen as a lifecycle fact for existing links', () => {
      expect(
        readVerifiedGitDelivery(githubBinding, { ...githubRequest, action: 'reopened' }),
      ).toMatchObject({
        trigger: 'pr_reopened',
        request: { state: { state: 'open', observedAtMs } },
      });
    });

    it.each([
      'edited',
      'ready_for_review',
      'converted_to_draft',
      'review_requested',
      'review_request_removed',
    ])('admits the GitHub %s action as a member update without task discovery', (action) => {
      expect(readVerifiedGitDelivery(githubBinding, { ...githubRequest, action })).toEqual({
        kind: 'actionable',
        trigger: 'pr_updated',
        requestNumber: 214,
        head: { sha: observedHead, observedAtMs },
        request: { state: { state: 'open', observedAtMs }, members: githubMembers },
        taskKeys: [],
        closingTaskKeys: [],
      });
    });

    it('reports the merged state of a GitHub edit after the merge, for realignment', () => {
      expect(
        readVerifiedGitDelivery(githubBinding, {
          ...githubRequest,
          action: 'edited',
          pull_request: { ...githubRequest.pull_request, state: 'closed', merged: true },
        }),
      ).toMatchObject({ trigger: 'pr_updated', request: { state: { state: 'merged' } } });
    });

    it('ignores a GitHub member update without a provider time to order it', () => {
      expect(
        readVerifiedGitDelivery(githubBinding, {
          ...githubRequest,
          action: 'edited',
          pull_request: { ...githubRequest.pull_request, updated_at: undefined },
        }),
      ).toEqual({ kind: 'ignored' });
    });

    it('treats empty reviewer lists as no requested review', () => {
      expect(
        readVerifiedGitDelivery(githubBinding, {
          ...githubRequest,
          action: 'review_request_removed',
          pull_request: { ...githubRequest.pull_request, requested_reviewers: [] },
        }),
      ).toMatchObject({ request: { members: { reviewRequested: false } } });
    });

    it('records the GitHub branch address, repository and creator', () => {
      expect(
        readVerifiedGitDelivery(githubBinding, {
          ...githubCreate,
          repository: { ...githubRepository, html_url: 'https://github.com/atelier-nord/web' },
          sender: { login: 'irobert' },
        }),
      ).toMatchObject({
        trigger: 'branch',
        members: {
          url: 'https://github.com/atelier-nord/web/tree/cad-482-ecran-connexion-sso',
          repository: { fullName: 'atelier-nord/web', url: 'https://github.com/atelier-nord/web' },
          author: { login: 'irobert' },
        },
        linkSources: { 'CAD-482': 'branch' },
      });
    });

    it('records the GitLab branch address and pusher and finds CAD-482 in a commit', () => {
      expect(
        readVerifiedGitDelivery(gitlabBinding, {
          ...gitlabNewBranch,
          project: { ...gitlabProject, web_url: 'https://gitlab.example/atelier-nord/auth' },
          user_username: 'cmartin',
          user_name: 'Camille Martin',
        }),
      ).toMatchObject({
        trigger: 'branch',
        members: {
          url: 'https://gitlab.example/atelier-nord/auth/-/tree/cad-479-limite-debit-jetons',
          author: { login: 'cmartin', name: 'Camille Martin' },
        },
        linkSources: { 'CAD-479': 'branch', 'CAD-482': 'commit' },
      });
    });

    it('records the GitLab opener only from the opening delivery', () => {
      const opening = {
        ...gitlabMergeRequest,
        user: { username: 'cmartin', name: 'Camille Martin' },
        reviewers: [{ username: 'irobert' }],
        object_attributes: {
          ...gitlabMergeRequest.object_attributes,
          url: 'https://gitlab.example/atelier-nord/auth/-/merge_requests/31',
          draft: true,
          updated_at: updatedAt,
        },
      };
      expect(readVerifiedGitDelivery(gitlabBinding, opening)).toMatchObject({
        trigger: 'pr_open',
        request: {
          state: { state: 'open', observedAtMs },
          members: {
            draft: true,
            url: 'https://gitlab.example/atelier-nord/auth/-/merge_requests/31',
            author: { login: 'cmartin', name: 'Camille Martin' },
            reviewRequested: true,
          },
        },
        linkSources: { 'CAD-466': 'title', 'CAD-482': 'commit' },
      });
      const update = readVerifiedGitDelivery(gitlabBinding, {
        ...opening,
        object_attributes: { ...opening.object_attributes, action: 'update', draft: false },
      });
      expect(update).toMatchObject({
        trigger: 'pr_updated',
        request: { members: { draft: false } },
      });
      expect(update).not.toHaveProperty('request.members.author');
    });

    it('recognizes a GitLab reopen and a closed-state update', () => {
      expect(
        readVerifiedGitDelivery(gitlabBinding, {
          ...gitlabMergeRequest,
          object_attributes: { ...gitlabMergeRequest.object_attributes, action: 'reopen' },
        }),
      ).toMatchObject({ trigger: 'pr_reopened' });
      expect(
        readVerifiedGitDelivery(gitlabBinding, {
          ...gitlabUpdate,
          object_attributes: {
            ...gitlabUpdate.object_attributes,
            oldrev: undefined,
            state: 'closed',
          },
        }),
      ).toMatchObject({ trigger: 'pr_updated', request: { state: { state: 'closed' } } });
    });
  });
});
