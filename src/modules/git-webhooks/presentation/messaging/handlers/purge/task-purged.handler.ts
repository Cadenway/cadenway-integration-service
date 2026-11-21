import { eventSchemas, TASK_PURGED_V1 } from '@cadenway/contracts/events/integration-service';
import { requireOrganizationId } from '@cadenway/nest-common';
import type { EventConsumers } from '@cadenway/nest-messaging';
import type { OnApplicationBootstrap } from '@nestjs/common';

import type { PurgeTaskGitLinks } from '../../../../application/use-cases/commands/purge/purge-task-git-links/purge-task-git-links.use-case.js';

/** Applies terminal Task facts through the broker's event receipt transaction. */
export class TaskPurgedHandler implements OnApplicationBootstrap {
  // #region Constructor
  /** Binds the event consumer and the shared batch command. */
  public constructor(
    private readonly consumers: Pick<EventConsumers, 'subscribe'>,
    private readonly command: Pick<PurgeTaskGitLinks, 'execute'>,
  ) {}
  // #endregion

  // #region Methods
  /** Replays retained purge facts when the durable is first created. */
  public async onApplicationBootstrap(): Promise<void> {
    await this.consumers.subscribe({
      handler: 'purge-task-git-links',
      schemas: eventSchemas,
      event: TASK_PURGED_V1,
      deliverPolicy: 'all',
      handle: async (event, { signal }) => {
        signal.throwIfAborted();
        const organizationId = requireOrganizationId();
        if (organizationId !== event.organizationId) {
          throw new Error('Task purge tenant does not match its verified broker context.');
        }
        try {
          await this.command.execute({
            organizationId,
            eventId: event.id.toLowerCase(),
            taskKey: event.key,
            batch: 0,
            signal,
          });
        } catch {
          throw new Error('Git purge batch did not complete.');
        }
      },
    });
  }
  // #endregion
}
