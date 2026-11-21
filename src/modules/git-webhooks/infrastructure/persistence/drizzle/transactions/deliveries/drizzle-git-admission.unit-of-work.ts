import { runWithOrganizationContext } from '@cadenway/nest-common';
import type { DatabaseSchema, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { and, eq } from 'drizzle-orm';

import type { GitWebhookReceiver } from '../../../../../application/models/deliveries/git-webhook-receiver.model.js';
import type { GitDeliveryTransaction } from '../../../../../application/ports/outbound/transactions/deliveries/git-delivery-transaction.port.js';
import type { GitDeliveryUnitOfWork } from '../../../../../application/ports/outbound/transactions/deliveries/git-delivery-unit-of-work.port.js';
import type { GitDispatchJobsProducer } from '../../../../jobs/pg-boss/dispatch/git-dispatch.adapter.js';
import type { DrizzleGitLinkRepository } from '../../repositories/links/drizzle-git-link.repository.js';
import { gitWebhookReceivers } from '../../schemas/deliveries/git-webhook-receivers.schema.js';
import { DrizzleGitDeliveryTransaction } from './drizzle-git-delivery.unit-of-work.js';

/** Verifies the current database registration before admitting signed Git work in its tenant. */
export class DrizzleGitAdmissionUnitOfWork implements GitDeliveryUnitOfWork {
  // #region Constructor
  /** Uses signing credentials supplied by this service's trusted deployment configuration. */
  public constructor(
    private readonly runner: TenantTransactionRunner<DatabaseSchema>,
    private readonly receivers: readonly GitWebhookReceiver[],
    private readonly jobs: GitDispatchJobsProducer,
    private readonly links?: DrizzleGitLinkRepository,
  ) {}
  // #endregion

  // #region Methods
  /** Selects a key using only the configured receiver ID and provider. */
  public findReceiver(
    bindingId: string,
    provider: 'github' | 'gitlab',
  ): Promise<GitWebhookReceiver | null> {
    const receiver = this.receivers.find(
      (entry) => entry.bindingId === bindingId.toLowerCase() && entry.provider === provider,
    );
    return Promise.resolve(receiver ?? null);
  }

  /** Locks the registration and checks its current key revision before the tenant write. */
  public run<T>(
    receiver: GitWebhookReceiver,
    work: (transaction: GitDeliveryTransaction) => Promise<T>,
  ): Promise<{ readonly active: false } | { readonly active: true; readonly result: T }> {
    return runWithOrganizationContext(
      {
        organizationId: receiver.organizationId,
        actor: { type: 'system', id: 'integration-service' },
        role: null,
        scopes: [],
      },
      () =>
        this.runner.run(async (scope) => {
          const locked = await scope.db
            .select({ bindingId: gitWebhookReceivers.id })
            .from(gitWebhookReceivers)
            .where(
              and(
                eq(gitWebhookReceivers.organizationId, receiver.organizationId),
                eq(gitWebhookReceivers.id, receiver.bindingId),
                eq(gitWebhookReceivers.provider, receiver.provider),
                eq(gitWebhookReceivers.revision, receiver.revision),
                eq(gitWebhookReceivers.enabled, true),
              ),
            )
            .limit(1)
            .for('update');
          if (locked.length === 0) return { active: false } as const;
          const transaction = new DrizzleGitDeliveryTransaction(
            scope,
            receiver.organizationId,
            receiver.bindingId,
            receiver.provider,
            receiver.revision,
            this.jobs,
            this.links,
          );
          return { active: true, result: await work(transaction) } as const;
        }),
    );
  }
  // #endregion
}
