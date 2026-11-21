import {
  GIT_BRANCH_CREATED_V1,
  GIT_CHECKS_COMPLETED_V1,
  GIT_PR_CLOSED_V1,
  GIT_PR_MERGED_V1,
  GIT_PR_OPENED_V1,
  eventSchemas,
} from '@cadenway/contracts/events/integration-service';
import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';
import type { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';

import type { GitTaskActionResult } from '../../../../application/models/dispatch/git-task-action-result.model.js';
import type { GitLinkChanged } from '../../../../domain/events/links/git-link-changed.event.js';

const pullRequestEventName = {
  'pull-request-opened': GIT_PR_OPENED_V1,
  'pull-request-merged': GIT_PR_MERGED_V1,
  'pull-request-closed': GIT_PR_CLOSED_V1,
} as const satisfies Record<
  Exclude<GitLinkChanged['type'], 'branch-created' | 'checks-completed'>,
  keyof typeof eventSchemas
>;

interface AuthorizedLinkChange {
  // #region Properties
  /** Tenant of the verified mapping and link. */
  readonly organizationId: string;

  /** Local Cadenway integration acting on this task. */
  readonly integrationId: string;

  /** Stable Task business key from the settled dispatch. */
  readonly taskKey: string;

  /** Stable UUID assigned by the link repository. */
  readonly gitLinkId: string;

  /** Material domain change and its per-link version. */
  readonly event: GitLinkChanged;

  /** Placement returned by the authorized Task action. */
  readonly placement: Pick<
    Exclude<GitTaskActionResult, { readonly disposition: 'unavailable' }>,
    'listId' | 'spaceId'
  >;
  // #endregion
}

/** Appends a minimal Git link fact inside the transaction that records the link change. */
export class GitLinkChangedOutbox {
  // #region Constructor
  /** Uses the kit's transactional writer and published schemas. */
  public constructor(private readonly writer: Pick<OutboxWriter, 'append'>) {}
  // #endregion

  // #region Methods
  /** Records the material change with the link's stable identity and Task's authorized placement. */
  public async append(
    scope: TransactionScope<DatabaseSchema>,
    change: AuthorizedLinkChange,
  ): Promise<void> {
    if (scope.kind !== 'tenant' || scope.organizationId !== change.organizationId) {
      throw new Error('Git link event does not belong to the tenant transaction.');
    }

    const data = {
      organizationId: change.organizationId,
      actor: { type: 'git' as const, id: change.integrationId },
      version: change.event.version,
      taskKey: change.taskKey,
      spaceId: change.placement.spaceId,
      listId: change.placement.listId,
      gitLinkId: change.gitLinkId,
    };

    if (change.event.type === 'branch-created') {
      await this.writer.append(scope, eventSchemas, GIT_BRANCH_CREATED_V1, {
        ...data,
        changed: ['branch'],
      });
      return;
    }
    if (change.event.type === 'checks-completed') {
      await this.writer.append(scope, eventSchemas, GIT_CHECKS_COMPLETED_V1, {
        ...data,
        changed: ['checks'],
      });
      return;
    }

    await this.writer.append(scope, eventSchemas, pullRequestEventName[change.event.type], {
      ...data,
      changed: ['state'],
    });
  }
  // #endregion
}
