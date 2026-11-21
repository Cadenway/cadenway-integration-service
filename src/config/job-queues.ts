import type { JobQueueDeclaration } from '@cadenway/nest-jobs/provisioning';

/** Bounded attempts leave a wide margin inside Task's 24-hour command receipt window. */
export const GIT_DISPATCH_QUEUE = {
  name: 'integration.dispatch-git-action',
  retryLimit: 4,
  retryDelaySeconds: 15,
  retryDelayMaxSeconds: 120,
  expireInSeconds: 30,
  // Keep expired work long enough for the worker to reject it into the dead-letter queue.
  retentionSeconds: 48 * 60 * 60,
} as const satisfies JobQueueDeclaration;
