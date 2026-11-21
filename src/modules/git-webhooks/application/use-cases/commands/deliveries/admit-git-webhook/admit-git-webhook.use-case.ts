import { readVerifiedGitChecks } from '../../../../../domain/policies/deliveries/read-verified-git-checks.policy.js';
import { readVerifiedGitDelivery } from '../../../../../domain/policies/deliveries/read-verified-git-delivery.policy.js';
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
      const prior = await transaction.checkDeliveryId(deliveryId, digest);
      if (prior !== 'new') return prior;

      const identity = repositoryIdentity(input.provider, body);
      if (identity === null) {
        return supportedEvent(verifiedInput) ? 'authentication-failed' : 'ignored';
      }
      const mapping = await transaction.findMapping(identity);
      if (mapping === null) {
        return supportedEvent(verifiedInput) ? 'authentication-failed' : 'ignored';
      }
      const fact = readFact(mapping, body);
      if (fact.kind === 'repository_mismatch') {
        return supportedEvent(verifiedInput) ? 'authentication-failed' : 'ignored';
      }
      if (fact.kind === 'actionable' && !matchesEvent(verifiedInput, fact.trigger)) {
        return 'invalid-delivery';
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

function readFact(mapping: GitDeliveryMapping, body: unknown): VerifiedGitDelivery {
  const fact = readVerifiedGitDelivery(mapping.binding, body);
  if (fact.kind !== 'ignored') return fact;
  const checks = readVerifiedGitChecks(mapping.binding, body);
  return checks === null
    ? fact
    : {
        kind: 'actionable',
        trigger: 'pr_checks',
        requestNumber: checks.requestNumber,
        checks,
        taskKeys: [],
        closingTaskKeys: [],
      };
}

async function selectWork(
  transaction: GitDeliveryTransaction,
  mapping: GitDeliveryMapping,
  fact: Actionable,
): Promise<Parameters<GitDeliveryTransaction['admit']>[0]['work']> {
  if (fact.trigger !== 'pr_closed' && fact.trigger !== 'pr_head' && fact.trigger !== 'pr_checks') {
    return { mapping, fact };
  }
  const taskKeys = await transaction.findRequestTaskKeys(
    mapping.binding,
    fact.requestNumber,
    fact.trigger === 'pr_checks' ? fact.checks.headSha : undefined,
  );
  if (taskKeys === null) return null;
  const predecessors = await transaction.findPendingRequestWork(
    mapping.binding,
    fact.requestNumber,
    fact.trigger === 'pr_checks' ? ['pr_open', 'pr_merged', 'pr_head'] : ['pr_open', 'pr_merged'],
  );
  if (predecessors === null) return null;
  const targets = new Set(taskKeys);
  for (const predecessor of predecessors) {
    for (const taskKey of predecessor.taskKeys) targets.add(taskKey);
  }
  if (targets.size === 0 || targets.size > 20) return null;
  return {
    mapping,
    fact: { ...fact, taskKeys: [...targets] },
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
