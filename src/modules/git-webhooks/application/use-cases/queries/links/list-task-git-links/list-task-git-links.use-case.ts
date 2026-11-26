import type { TaskGitLinkReader } from '../../../../ports/outbound/persistence/links/task-git-link-reader.port.js';
import type { ListTaskGitLinksInput } from './list-task-git-links.input.js';
import type { ListTaskGitLinksOutput } from './list-task-git-links.output.js';

/**
 * Lists a task's links for the Development panel (App.dc.html:4328–4360) through
 * `listTaskGitLinksInternal`. Task visibility is decided before the gateway calls it; the read
 * only bounds itself by the verified organization and the task key, and writes nothing.
 */
export class ListTaskGitLinks {
  // #region Constructor
  /** Uses the tenant-scoped link read port. */
  public constructor(private readonly links: TaskGitLinkReader) {}
  // #endregion

  // #region Methods
  /** Reads one extra link to tell whether another page exists. */
  public async execute(input: ListTaskGitLinksInput): Promise<ListTaskGitLinksOutput> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('The Git link page size is out of range.');
    }
    const rows = await this.links.listTaskLinks({ ...input, limit: input.limit + 1 });
    const items = rows.slice(0, input.limit);
    const last = items.at(-1);
    return {
      items,
      next:
        rows.length > input.limit && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }
  // #endregion
}
