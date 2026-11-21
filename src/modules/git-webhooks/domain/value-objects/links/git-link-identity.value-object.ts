import type { GitReceiverBinding } from '../deliveries/git-receiver-binding.value-object.js';

/**
 * Stable relation between a Task identity and a provider object at the verified repository binding.
 * The receiver distinguishes GitLab projects with the same local ID on separate instances.
 */
export type GitLinkIdentity = {
  readonly organizationId: string;
  readonly receiverId: string;
  readonly binding: GitReceiverBinding;
  readonly taskId: string;
} & (
  | { readonly kind: 'branch'; readonly ref: string }
  | { readonly kind: 'pull-request'; readonly requestNumber: number }
);
