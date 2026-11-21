import type { GitTaskAction } from '../../../../ports/outbound/actions/dispatch/git-task-action.port.js';
import type { GitDispatchUnitOfWork } from '../../../../ports/outbound/transactions/dispatch/git-dispatch-unit-of-work.port.js';
import type { DispatchGitDeliveryInput } from './dispatch-git-delivery.input.js';
import type { DispatchGitDeliveryOutput } from './dispatch-git-delivery.output.js';

/** Dispatches one authenticated delivery target through Task's idempotent command. */
export class DispatchGitDelivery {
  // #region Constructor
  /** Binds the durable decision and the Task-owned action. */
  public constructor(
    private readonly work: GitDispatchUnitOfWork,
    private readonly task: GitTaskAction,
  ) {}
  // #endregion

  // #region Methods
  /** Resumes the target's claim and finalizes it after Task confirms the action. */
  public async execute(input: DispatchGitDeliveryInput): Promise<DispatchGitDeliveryOutput> {
    const prepared = await this.work.prepare(input);
    if (prepared.status !== 'ready') return { status: prepared.status };
    const { claim } = prepared;
    if (claim.organizationId !== input.organizationId) {
      throw new Error('The reserved Git delivery does not belong to this organization.');
    }
    if (claim.taskKey !== input.taskKey || !claim.fact.taskKeys.includes(input.taskKey)) {
      throw new Error('The reserved Git delivery target does not match the task.');
    }
    const status = {
      branch: 'progress',
      pr_open: 'review',
      pr_merged: claim.fact.closingTaskKeys.includes(input.taskKey) ? 'done' : null,
    } as const;
    const result = await this.task.apply(claim, status[claim.fact.trigger]);
    if (result.disposition !== 'unavailable' && result.spaceId !== claim.mapping.spaceId) {
      throw new Error('The Task receipt does not match the authorized mapped space.');
    }
    return {
      status: await this.work.finish({ ...input, claim, result }),
    };
  }
  // #endregion
}
