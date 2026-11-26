import {
  ApplyGitTaskStatusActionInternalParams,
  ApplyGitTaskStatusActionInternalResponse,
} from '@cadenway/contracts/validators/internal/task-service';
import {
  type InternalHttpClient,
  type InternalRequestInit,
  ProblemException,
} from '@cadenway/nest-common';
import { randomUUID } from 'node:crypto';

import type { GitDispatchClaim } from '../../../application/models/dispatch/git-dispatch-claim.model.js';
import type { GitTaskActionResult } from '../../../application/models/dispatch/git-task-action-result.model.js';
import type { GitMergeIntentCommand } from '../../../application/models/merges/git-merge-intent-command.model.js';
import type { GitMergeIntentOutcome } from '../../../application/models/merges/git-merge-intent-outcome.model.js';
import type { GitTaskAction } from '../../../application/ports/outbound/actions/dispatch/git-task-action.port.js';
import { getTaskServiceInternalRoutes } from './generated/task-service.js';

const gitTaskReceipt = ApplyGitTaskStatusActionInternalResponse.strict();
type GitTaskStatus = Parameters<GitTaskAction['apply']>[1];
type AuthorizedGitTaskActionResult = Exclude<GitTaskActionResult, { disposition: 'unavailable' }>;

/** Applies an authorized Git dispatch claim through Task's idempotent internal command. */
export class GitTaskHttpAdapter implements GitTaskAction {
  // #region Properties
  /** Generated Task operation using the service's signing transport. */
  private readonly routes: ReturnType<typeof getTaskServiceInternalRoutes>;
  // #endregion

  // #region Constructor
  /** Uses the Integration-signed HTTP client configured for Task. */
  public constructor(http: InternalHttpClient) {
    this.routes = getTaskServiceInternalRoutes((path, init) => {
      if (typeof path !== 'string') throw new Error('Expected a generated Task request path.');
      return http.fetch(path, init);
    });
  }
  // #endregion

  // #region Methods
  /** Resolves authorized placement even when Task replays the original status decision. */
  public async apply(claim: GitDispatchClaim, status: GitTaskStatus): Promise<GitTaskActionResult> {
    try {
      const original = await this.send(claim, status, { key: claim.commandKey, idempotent: true });
      if (!original.replayed) return original.receipt;

      // A placement recheck must run once with a new key. Its own replay could be stale too.
      const current = await this.send(claim, null, { key: randomUUID(), idempotent: false });
      if (
        current.replayed ||
        current.receipt.disposition !== 'no_op' ||
        current.receipt.taskId !== original.receipt.taskId
      ) {
        throw new Error('Task did not confirm current placement for the original Git action.');
      }
      return { ...current.receipt, disposition: original.receipt.disposition };
    } catch (error) {
      if (
        error instanceof ProblemException &&
        error.problem.status === 404 &&
        error.problem.code === 'task.not-found'
      ) {
        return { disposition: 'unavailable' };
      }
      throw error;
    }
  }

  /**
   * Submits the merge's `done` status under the intent's command key. Task confirms with a
   * receipt, also on a replay. `task.not-found`, `task.trashed`, a reused key and an invalid
   * request are definitive refusals; anything else, including a timeout, a transport error,
   * `409` or `503`, is a failure to retry under the same key.
   */
  public async submitMergeIntent(command: GitMergeIntentCommand): Promise<GitMergeIntentOutcome> {
    try {
      const { receipt } = await this.send(command, command.status, {
        key: command.commandKey,
        idempotent: true,
      });
      return { kind: 'confirmed', disposition: receipt.disposition };
    } catch (error) {
      if (error instanceof ProblemException) {
        const { status, code } = error.problem;
        if (
          code === 'task.trashed' ||
          (status === 404 && code === 'task.not-found') ||
          (status === 422 && code === 'idempotency.key-reused') ||
          (status === 400 && code === 'request.invalid')
        ) {
          return { kind: 'refused', reason: code };
        }
      }
      return { kind: 'failed' };
    }
  }

  /** Sends the signed Git action and validates the private receipt and its replay metadata. */
  private async send(
    claim: Pick<GitDispatchClaim, 'organizationId' | 'taskKey' | 'mapping'>,
    status: GitTaskStatus,
    request: { readonly key: string; readonly idempotent: boolean },
  ): Promise<{ readonly receipt: AuthorizedGitTaskActionResult; readonly replayed: boolean }> {
    const { taskKey } = ApplyGitTaskStatusActionInternalParams.parse({ taskKey: claim.taskKey });
    const { binding, integrationId, mappingAuthorUserId, spaceId } = claim.mapping;
    const options: InternalRequestInit = {
      claims: {
        organizationId: claim.organizationId,
        actor: { type: 'git', id: integrationId },
      },
      headers: { 'Idempotency-Key': request.key },
      idempotent: request.idempotent,
    };
    const response = await this.routes.applyGitTaskStatusActionInternal(
      taskKey,
      { provider: binding.provider, spaceId, mappingAuthorUserId, status },
      options,
    );
    const contentType = response.headers
      .get('Content-Type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    const replayed = response.headers.get('Idempotent-Replayed');
    if (
      response.status !== 200 ||
      response.headers.get('Cache-Control') !== 'private, no-store' ||
      contentType !== 'application/json' ||
      (replayed !== null && replayed !== 'true')
    ) {
      throw new Error('Task did not return a private Git action receipt.');
    }

    const receipt = gitTaskReceipt.safeParse(response.data);
    if (!receipt.success || receipt.data.spaceId !== spaceId) {
      throw new Error('The Task Git action receipt does not match the authorized placement.');
    }
    return { receipt: receipt.data, replayed: replayed === 'true' };
  }
  // #endregion
}
