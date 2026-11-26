import type { GitTaskAction } from '../../../../ports/outbound/actions/dispatch/git-task-action.port.js';
import type { GitMergeIntentUnitOfWork } from '../../../../ports/outbound/transactions/merges/git-merge-intent-unit-of-work.port.js';
import type { SubmitGitMergeIntentInput } from './submit-git-merge-intent.input.js';
import type { SubmitGitMergeIntentOutput } from './submit-git-merge-intent.output.js';

/**
 * Submits the pending Task status command of a verified merge ("Merge intent", Integration
 * AsyncAPI) and records Task's answer. Idempotent per attempt: the command key never changes,
 * and a superseded or already handled intent sends nothing more.
 */
export class SubmitGitMergeIntent {
  // #region Constructor
  /** Binds the intent's short transactions and Task's idempotent command. */
  public constructor(
    private readonly work: GitMergeIntentUnitOfWork,
    private readonly task: Pick<GitTaskAction, 'submitMergeIntent'>,
  ) {}
  // #endregion

  // #region Methods
  /** Claims the next attempt, sends it outside any transaction and settles its answer. */
  public async execute(input: SubmitGitMergeIntentInput): Promise<SubmitGitMergeIntentOutput> {
    const prepared = await this.work.prepare(input);
    if (prepared.status === 'unavailable') {
      const status = await this.work.settle({
        ...input,
        attempt: prepared.attempt,
        outcome: { kind: 'failed' },
      });
      return { status: status === 'superseded' ? 'settled' : status };
    }
    if (prepared.status !== 'ready') return { status: prepared.status };

    const { command } = prepared;
    if (command.organizationId !== input.organizationId || command.linkId !== input.linkId) {
      throw new Error('The merge intent does not belong to this link.');
    }
    const outcome = await this.task.submitMergeIntent(command);
    const status = await this.work.settle({ ...input, attempt: command.attempt, outcome });
    return { status: status === 'superseded' ? 'settled' : status };
  }
  // #endregion
}
