import {
  ApplyGitTaskStatusActionInternalParams,
  ApplyGitTaskStatusActionInternalResponse,
} from '@cadenway/contracts/validators/internal/task-service';
import {
  type InternalHttpClient,
  type InternalRequestInit,
  ProblemException,
} from '@cadenway/nest-common';

import type { GitDispatchClaim } from '../../../application/models/dispatch/git-dispatch-claim.model.js';
import type { GitTaskActionResult } from '../../../application/models/dispatch/git-task-action-result.model.js';
import type { GitTaskAction } from '../../../application/ports/outbound/actions/dispatch/git-task-action.port.js';
import { getTaskServiceInternalRoutes } from './generated/task-service.js';

const gitTaskReceipt = ApplyGitTaskStatusActionInternalResponse.strict();

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
  /** Sends the durable command key and accepts only a receipt for the authorized space. */
  public async apply(
    claim: GitDispatchClaim,
    status: 'progress' | 'review' | 'done' | null,
  ): Promise<GitTaskActionResult> {
    const { taskKey } = ApplyGitTaskStatusActionInternalParams.parse({ taskKey: claim.taskKey });
    const { binding, integrationId, mappingAuthorUserId, spaceId } = claim.mapping;
    const options: InternalRequestInit = {
      claims: {
        organizationId: claim.organizationId,
        actor: { type: 'git', id: integrationId },
      },
      headers: { 'Idempotency-Key': claim.commandKey },
    };

    try {
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
      if (
        response.status !== 200 ||
        response.headers.get('Cache-Control') !== 'private, no-store' ||
        contentType !== 'application/json'
      ) {
        throw new Error('Task did not return a private Git action receipt.');
      }

      const receipt = gitTaskReceipt.safeParse(response.data);
      if (!receipt.success || receipt.data.spaceId !== spaceId) {
        throw new Error('The Task Git action receipt does not match the authorized placement.');
      }
      return receipt.data;
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
  // #endregion
}
