/**
 * Task's answer to one merge intent submission: a confirmation (`applied` or `no_op`, including a
 * replay), a definitive refusal with its stable reason, or a failure to retry under the same key.
 */
export type GitMergeIntentOutcome =
  | { readonly kind: 'confirmed'; readonly disposition: 'applied' | 'no_op' }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'failed' };
