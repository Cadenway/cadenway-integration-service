import type { GitWebhookInput } from '../../../../models/deliveries/git-webhook-input.model.js';

/** Authenticates the original bytes with the receiver's dedicated signing secret. */
export interface GitWebhookVerifier {
  // #region Properties
  /** Returns the SHA-256 digest of the authenticated body, or null on failure. */
  readonly verify: (input: GitWebhookInput, signingSecret: string) => string | null;
  // #endregion
}
