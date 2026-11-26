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

/** Isolates link-producing dispatch from workers that only know Task status actions. */
export const GIT_LINK_DISPATCH_QUEUE = {
  ...GIT_DISPATCH_QUEUE,
  name: 'integration.dispatch-git-link',
  // Start promptly while allowing a preceding status action to complete its retries.
  retryLimit: 11,
  retryDelaySeconds: 2,
} as const satisfies JobQueueDeclaration;

/**
 * Link receipts in the current format: merge intents and the reopen, member update and head
 * check facts. Only workers that know them consume this queue, while workers of the previous
 * release keep draining `integration.dispatch-git-link` during a rolling deployment.
 */
export const GIT_LINK_DISPATCH_V2_QUEUE = {
  ...GIT_LINK_DISPATCH_QUEUE,
  name: 'integration.dispatch-git-link.v2',
} as const satisfies JobQueueDeclaration;

/** Continues link removals after the first transaction marks a task as permanently purged. */
export const GIT_PURGE_QUEUE = {
  name: 'integration.purge-task-git-links',
  retryLimit: 4,
  retryDelaySeconds: 15,
  retryDelayMaxSeconds: 120,
  expireInSeconds: 30,
} as const satisfies JobQueueDeclaration;

/**
 * Submits a pending merge intent. The use case schedules each retry itself, with backoff inside
 * Task's receipt window; the queue retries only an attempt that failed before it could settle.
 */
export const GIT_MERGE_INTENT_QUEUE = {
  name: 'integration.submit-git-merge-intent',
  retryLimit: 5,
  retryDelaySeconds: 30,
  retryDelayMaxSeconds: 600,
  expireInSeconds: 30,
  retentionSeconds: 48 * 60 * 60,
} as const satisfies JobQueueDeclaration;

/** Hourly pruning of old check observations and report of links and intents to follow up. */
export const GIT_LINK_MAINTENANCE_QUEUE = {
  name: 'integration.git-link-maintenance',
  retryLimit: 2,
  retryDelaySeconds: 60,
  expireInSeconds: 120,
  retentionSeconds: 60 * 60,
} as const satisfies JobQueueDeclaration;

/** Pages through the links whose current head is an observed check head, to refresh them. */
export const GIT_HEAD_CHECKS_QUEUE = {
  name: 'integration.refresh-git-head-checks',
  retryLimit: 5,
  retryDelaySeconds: 15,
  retryDelayMaxSeconds: 300,
  expireInSeconds: 30,
  retentionSeconds: 48 * 60 * 60,
} as const satisfies JobQueueDeclaration;
