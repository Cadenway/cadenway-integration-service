/**
 * Provider identity recorded for the receiver whose dedicated signing key verified the delivery.
 * A GitLab project ID is local to the configured instance that owns the signing key.
 */
export type GitReceiverBinding =
  | {
      readonly provider: 'github';
      readonly repositoryId: number;
      readonly installationId: number;
    }
  | {
      readonly provider: 'gitlab';
      readonly repositoryId: number;
    };
