import { readVerifiedGitChecks } from '../../../../../domain/policies/deliveries/read-verified-git-checks.policy.js';
import { readVerifiedGitDelivery } from '../../../../../domain/policies/deliveries/read-verified-git-delivery.policy.js';
import type { VerifiedGitChecks } from '../../../../../domain/value-objects/checks/verified-git-checks.value-object.js';
import type { VerifiedGitDelivery } from '../../../../../domain/value-objects/deliveries/verified-git-delivery.value-object.js';
import type { GitDeliveryMapping } from '../../../../models/deliveries/git-delivery-mapping.model.js';
import type { GitRepositoryIdentity } from '../../../../models/deliveries/git-repository-identity.model.js';
import type { GitWebhookVerifier } from '../../../../ports/outbound/security/deliveries/git-webhook-verifier.port.js';
import type { GitDeliveryTransaction } from '../../../../ports/outbound/transactions/deliveries/git-delivery-transaction.port.js';
import type { GitDeliveryUnitOfWork } from '../../../../ports/outbound/transactions/deliveries/git-delivery-unit-of-work.port.js';
import type { AdmitGitWebhookInput } from './admit-git-webhook.input.js';
import type { AdmitGitWebhookOutput } from './admit-git-webhook.output.js';

/** Authenticates a provider delivery and durably admits its bounded work. */
export class AdmitGitWebhook {
  // #region Constructor
  /** Uses receiver-scoped persistence and a provider-specific signature verifier. */
  public constructor(
    private readonly work: GitDeliveryUnitOfWork,
    private readonly verifier: GitWebhookVerifier,
  ) {}
  // #endregion

  // #region Methods
  /** Verifies the original bytes before parsing and commits the receipt with any admitted work. */
  public async execute(input: AdmitGitWebhookInput): Promise<AdmitGitWebhookOutput> {
    const receiver = await this.work.findReceiver(input.bindingId, input.provider);
    if (receiver?.provider !== input.provider) {
      return { status: 'authentication-failed' };
    }
    const verifiedInput = { ...input, rawBody: Uint8Array.from(input.rawBody) };
    const digest = this.verifier.verify(verifiedInput, receiver.signingSecret);
    if (digest === null) return { status: 'authentication-failed' };
    const deliveryId =
      input.provider === 'github' ? input.deliveryId.toLowerCase() : input.deliveryId;

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(verifiedInput.rawBody));
    } catch {
      return { status: 'invalid-delivery' };
    }

    const result = await this.work.run(receiver, async (transaction) => {
      const prior = await transaction.checkDelivery(deliveryId, digest);
      if (prior !== 'new') return prior;

      const identity = repositoryIdentity(input.provider, body);
      if (identity === null) {
        return supportedEvent(verifiedInput) ? 'authentication-failed' : 'ignored';
      }
      const mapping = await transaction.findMapping(identity);
      if (mapping === null) {
        return supportedEvent(verifiedInput) ? 'authentication-failed' : 'ignored';
      }
      const { fact, checks } = readFact(mapping, body);
      if (fact.kind === 'repository_mismatch') {
        return supportedEvent(verifiedInput) ? 'authentication-failed' : 'ignored';
      }
      if (
        (fact.kind === 'actionable' && !matchesEvent(verifiedInput, fact.trigger)) ||
        (checks !== null && !matchesEvent(verifiedInput, 'pr_checks'))
      ) {
        return 'invalid-delivery';
      }
      // Observations are kept per repository and head, also before any link exists.
      if (checks !== null) {
        await transaction.recordCheckObservation(mapping.binding, checks.observation);
      }
      const work = fact.kind === 'actionable' ? await selectWork(transaction, mapping, fact) : null;
      return transaction.admit({
        deliveryId,
        digest,
        work,
      });
    });
    if (!result.active || result.result === 'authentication-failed') {
      return { status: 'authentication-failed' };
    }
    return result.result === 'conflict' || result.result === 'invalid-delivery'
      ? { status: 'invalid-delivery' }
      : { status: 'accepted' };
  }
  // #endregion
}

type Actionable = Extract<VerifiedGitDelivery, { readonly kind: 'actionable' }>;

/** Reads a link fact, or else a check observation and the one request it names, if any. */
function readFact(
  mapping: GitDeliveryMapping,
  body: unknown,
): { readonly fact: VerifiedGitDelivery; readonly checks: VerifiedGitChecks | null } {
  const fact = readVerifiedGitDelivery(mapping.binding, body);
  if (fact.kind !== 'ignored') return { fact, checks: null };
  const checks = readVerifiedGitChecks(mapping.binding, body);
  const request = checks?.request;
  if (checks === null || request === undefined) return { fact, checks };
  const { observation } = checks;
  return {
    checks,
    fact: {
      kind: 'actionable',
      trigger: 'pr_checks',
      requestNumber: request.number,
      checks: {
        requestNumber: request.number,
        headSha: observation.headSha,
        attemptId: observation.attemptId,
        completedAtMs: observation.observedAtMs,
      },
      ...(request.state === undefined ? {} : { requestState: request.state }),
      taskKeys: [],
      closingTaskKeys: [],
    },
  };
}

async function selectWork(
  transaction: GitDeliveryTransaction,
  mapping: GitDeliveryMapping,
  fact: Actionable,
): Promise<Parameters<GitDeliveryTransaction['admit']>[0]['work']> {
  if (fact.trigger === 'branch' || fact.trigger === 'pr_open') {
    return { mapping, fact };
  }
  const taskKeys = await transaction.findRequestTaskKeys(
    mapping.binding,
    fact.requestNumber,
    fact.trigger === 'pr_checks' ? fact.checks.headSha : undefined,
  );
  if (taskKeys === null && fact.trigger !== 'pr_merged') return null;
  const pending = await transaction.findPendingRequestWork(
    mapping,
    fact.requestNumber,
    fact.trigger === 'pr_checks'
      ? ['pr_open', 'pr_merged', 'pr_head', 'pr_updated']
      : ['pr_open', 'pr_merged'],
  );
  if (pending === null && fact.trigger !== 'pr_merged') return null;
  const predecessors = pending ?? [];
  const historicalTargets = new Set(taskKeys);
  for (const predecessor of predecessors) {
    for (const taskKey of predecessor.taskKeys) historicalTargets.add(taskKey);
  }
  if (historicalTargets.size > 20 && fact.trigger !== 'pr_merged') return null;
  // A busy request must not lose its recorded links or its bounded signed merge references.
  const inferredTargets = historicalTargets.size <= 20 ? historicalTargets : (taskKeys ?? []);
  const targets =
    fact.trigger === 'pr_merged'
      ? new Set([...inferredTargets, ...fact.taskKeys])
      : historicalTargets;
  if (targets.size === 0) return null;
  return {
    mapping,
    fact:
      fact.trigger === 'pr_merged'
        ? {
            ...fact,
            taskKeys: [...targets],
            referencedTaskKeys: fact.taskKeys,
          }
        : { ...fact, taskKeys: [...targets] },
    ...(predecessors.length === 0 ? {} : { prerequisiteIds: predecessors.map(({ id }) => id) }),
  };
}

const eventNames = {
  github: { branch: 'create', request: 'pull_request', checks: 'check_suite' },
  gitlab: { branch: 'Push Hook', request: 'Merge Request Hook', checks: 'Pipeline Hook' },
} as const;

function matchesEvent(input: AdmitGitWebhookInput, trigger: Actionable['trigger']): boolean {
  const events = eventNames[input.provider];
  if (trigger === 'branch') return input.event === events.branch;
  if (trigger === 'pr_checks') return input.event === events.checks;
  return input.event === events.request;
}

function supportedEvent(input: AdmitGitWebhookInput): boolean {
  return Object.values<string>(eventNames[input.provider]).includes(input.event);
}

function repositoryIdentity(
  provider: 'github' | 'gitlab',
  body: unknown,
): GitRepositoryIdentity | null {
  const delivery = object(body);
  const repository = object(provider === 'github' ? delivery?.repository : delivery?.project);
  const repositoryId = repository?.id;
  if (!providerId(repositoryId)) return null;
  if (provider === 'gitlab') return { provider, repositoryId };
  const installationId = object(delivery?.installation)?.id;
  return providerId(installationId) ? { provider, repositoryId, installationId } : null;
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function providerId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
