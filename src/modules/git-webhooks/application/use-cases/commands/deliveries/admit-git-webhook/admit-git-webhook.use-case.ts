import { readVerifiedGitDelivery } from '../../../../../domain/policies/deliveries/read-verified-git-delivery.policy.js';
import type { GitRepositoryIdentity } from '../../../../models/deliveries/git-repository-identity.model.js';
import type { GitWebhookVerifier } from '../../../../ports/outbound/security/deliveries/git-webhook-verifier.port.js';
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
      const fact = readVerifiedGitDelivery(mapping.binding, body);
      if (fact.kind === 'repository_mismatch') {
        return supportedEvent(verifiedInput) ? 'authentication-failed' : 'ignored';
      }
      const eventMatches =
        fact.kind === 'actionable' &&
        ((input.provider === 'github' &&
          ((input.event === 'create' && fact.trigger === 'branch') ||
            (input.event === 'pull_request' && fact.trigger !== 'branch'))) ||
          (input.provider === 'gitlab' &&
            ((input.event === 'Push Hook' && fact.trigger === 'branch') ||
              (input.event === 'Merge Request Hook' && fact.trigger !== 'branch'))));
      if (fact.kind === 'actionable' && !eventMatches) return 'invalid-delivery';
      return transaction.admit({
        deliveryId,
        digest,
        work: eventMatches ? { mapping, fact } : null,
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

function supportedEvent(input: AdmitGitWebhookInput): boolean {
  return input.provider === 'github'
    ? input.event === 'create' || input.event === 'pull_request'
    : input.event === 'Push Hook' || input.event === 'Merge Request Hook';
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
