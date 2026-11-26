import type { GitLinkFollowUpReporter } from '../../../../ports/outbound/reports/maintenance/git-link-follow-up-reporter.port.js';
import type { GitLinkMaintenanceUnitOfWork } from '../../../../ports/outbound/transactions/maintenance/git-link-maintenance-unit-of-work.port.js';
import type { RunGitLinkMaintenanceInput } from './run-git-link-maintenance.input.js';
import type { RunGitLinkMaintenanceOutput } from './run-git-link-maintenance.output.js';

const pruneBatch = 1_000;
const maxPruneBatches = 20;
const reportLimit = 100;

/**
 * Prunes check observations kept 7 days after their last update for a head that is no link's
 * current head ("Checks", Integration AsyncAPI), resumes pending merge intents whose submission
 * job is gone, and reports what an operator follows up: each link newly marked
 * `reconciliation pending` and each merge intent left unconfirmed past Task's receipt window
 * ("Reconciliation" and "Merge intent"). A follow-up is marked reported only once it has been
 * emitted, so a pass that stops in between reports it again. Each step is bounded.
 */
export class RunGitLinkMaintenance {
  // #region Constructor
  /** Uses the cross-organization maintenance transactions and the operator report. */
  public constructor(
    private readonly work: GitLinkMaintenanceUnitOfWork,
    private readonly reporter: GitLinkFollowUpReporter,
  ) {}
  // #endregion

  // #region Methods
  /** Runs one pass in bounded batches; `signal` stops pruning between batches. */
  public async execute(input: RunGitLinkMaintenanceInput): Promise<RunGitLinkMaintenanceOutput> {
    const { signal } = input;
    let prunedObservations = 0;
    for (let batch = 0; batch < maxPruneBatches; batch += 1) {
      signal?.throwIfAborted();
      const pruned = await this.work.pruneCheckObservations(pruneBatch);
      prunedObservations += pruned;
      if (pruned < pruneBatch) break;
    }
    signal?.throwIfAborted();
    const resumedMergeIntents = await this.work.resumePendingMergeIntents(reportLimit);

    const reconciliationPending = await this.work.findReconciliationPending(reportLimit);
    if (reconciliationPending.length !== 0) {
      await this.reporter.report('reconciliation-pending', reconciliationPending);
      await this.work.markReconciliationReported(reconciliationPending);
    }
    const unconfirmedMergeIntents = await this.work.findUnconfirmedMergeIntents(reportLimit);
    if (unconfirmedMergeIntents.length !== 0) {
      await this.reporter.report('unconfirmed-merge-intent', unconfirmedMergeIntents);
      await this.work.markMergeIntentsReported(unconfirmedMergeIntents);
    }
    return {
      prunedObservations,
      resumedMergeIntents,
      reconciliationPending,
      unconfirmedMergeIntents,
    };
  }
  // #endregion
}
