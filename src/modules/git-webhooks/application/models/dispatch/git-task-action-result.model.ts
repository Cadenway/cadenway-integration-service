/** Task's terminal response. Transport failure must throw so the claim can be retried. */
export type GitTaskActionResult =
  | { readonly disposition: 'unavailable' }
  | {
      readonly disposition: 'applied' | 'no_op';
      readonly taskId: string;
      readonly listId: string;
      readonly spaceId: string;
    };
