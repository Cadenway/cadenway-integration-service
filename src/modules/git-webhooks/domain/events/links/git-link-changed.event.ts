/**
 * A material link change to publish with Integration's assigned link ID and Task's placement.
 * Provider references and message contents stay out of the event. Every change carries the
 * version it assigned, one higher than the previous fact of the link.
 */
export type GitLinkChanged =
  | {
      readonly type:
        | 'branch-created'
        | 'pull-request-opened'
        | 'pull-request-closed'
        | 'pull-request-merged'
        | 'pull-request-reopened'
        | 'checks-completed';
      readonly version: number;
    }
  | {
      /** Any other projection change, naming the changed `GitLink` members. */
      readonly type: 'link-updated';
      readonly version: number;
      readonly changed: readonly string[];
    };
