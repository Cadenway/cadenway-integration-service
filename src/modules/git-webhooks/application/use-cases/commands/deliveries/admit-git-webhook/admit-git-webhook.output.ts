/** Stable intake outcome. An accepted replay or intentionally ignored event is acknowledged. */
export type AdmitGitWebhookOutput =
  | { readonly status: 'accepted' }
  | { readonly status: 'authentication-failed' }
  | { readonly status: 'invalid-delivery' };
