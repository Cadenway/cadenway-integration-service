import {
  ReceiveGitHubWebhookInternalBody,
  ReceiveGitHubWebhookInternalHeader,
  ReceiveGitHubWebhookInternalQueryParams,
  ReceiveGitLabWebhookInternalBody,
  ReceiveGitLabWebhookInternalHeader,
  ReceiveGitLabWebhookInternalQueryParams,
} from '@cadenway/contracts/validators/internal/integration-service';
import { InternalAccess, principalOf, ProblemException } from '@cadenway/nest-common';
import { Controller, Header, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { AdmitGitWebhook } from '../../../../application/use-cases/commands/deliveries/admit-git-webhook/admit-git-webhook.use-case.js';
import type { AdmitGitWebhookInput } from '../../../../application/use-cases/commands/deliveries/admit-git-webhook/admit-git-webhook.input.js';
import type { AdmitGitWebhookOutput } from '../../../../application/use-cases/commands/deliveries/admit-git-webhook/admit-git-webhook.output.js';

/** Rejects a malformed delivery without reflecting submitted values. */
function invalidRequest(): never {
  throw new ProblemException({ status: 400, code: 'request.invalid' });
}

/** Gives unknown receivers and invalid provider credentials the same response. */
function authenticationFailed(): never {
  throw new ProblemException({ status: 403, code: 'webhook.authentication-failed' });
}

/** Reads one provider header, refusing duplicates rather than accepting a joined value. */
function singleHeader(
  request: Request,
  name: string,
  duplicate: () => never = invalidRequest,
): string | undefined {
  const expected = name.toLowerCase();
  let found: string | undefined;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== expected) continue;
    if (found !== undefined) return duplicate();
    found = request.rawHeaders[index + 1];
  }
  return found;
}

/** Enforces the exact system actor and organization-free token accepted by the webhook contract. */
function authorize(request: Request): void {
  const principal = principalOf(request);
  if (principal === undefined) {
    throw new ProblemException({ status: 401, code: 'auth.token-missing' });
  }
  if (principal.issuer !== 'api-gateway') {
    throw new ProblemException({ status: 403, code: 'auth.issuer-not-allowed' });
  }
  if (principal.actor.type !== 'system' || principal.actor.id !== 'api-gateway') {
    throw new ProblemException({ status: 403, code: 'auth.actor-not-allowed' });
  }
  if (principal.organizationId !== null) {
    throw new ProblemException({ status: 403, code: 'auth.organization-not-allowed' });
  }
}

/** Receives raw provider deliveries from the authenticated API gateway. */
@Controller('internal/v1/webhooks')
@InternalAccess({ issuers: ['api-gateway'], actors: ['system'], organization: 'optional' })
export class GitWebhooksController {
  // #region Constructor
  /** Binds the application intake that authenticates and durably admits deliveries. */
  public constructor(private readonly admit: AdmitGitWebhook) {}
  // #endregion

  // #region Methods
  /** Authenticates a GitHub body and acknowledges it after durable admission. */
  @Post('github')
  @HttpCode(204)
  @Header('Cache-Control', 'private, no-store')
  public async github(@Req() request: Request): Promise<void> {
    authorize(request);
    const query = ReceiveGitHubWebhookInternalQueryParams.strict().safeParse(request.query);
    if (
      !query.success ||
      request.is('application/json') !== 'application/json' ||
      !Buffer.isBuffer(request.body)
    ) {
      return invalidRequest();
    }
    if (!ReceiveGitHubWebhookInternalBody.safeParse(request.body).success) return invalidRequest();
    const signature = singleHeader(request, 'X-Hub-Signature-256', authenticationFailed);
    if (signature === undefined) return authenticationFailed();
    const headers = ReceiveGitHubWebhookInternalHeader.safeParse({
      'X-GitHub-Delivery': singleHeader(request, 'X-GitHub-Delivery'),
      'X-GitHub-Event': singleHeader(request, 'X-GitHub-Event'),
      'X-Hub-Signature-256': signature,
    });
    if (!headers.success) {
      if (
        !ReceiveGitHubWebhookInternalHeader.shape['X-Hub-Signature-256'].safeParse(signature)
          .success
      ) {
        return authenticationFailed();
      }
      return invalidRequest();
    }
    const result = await this.accept({
      provider: 'github',
      bindingId: query.data.bindingId,
      deliveryId: headers.data['X-GitHub-Delivery'],
      event: headers.data['X-GitHub-Event'],
      signature,
      rawBody: request.body,
    });
    this.respond(result.status);
  }

  /** Authenticates a GitLab signed delivery and acknowledges it after durable admission. */
  @Post('gitlab')
  @HttpCode(204)
  @Header('Cache-Control', 'private, no-store')
  public async gitlab(@Req() request: Request): Promise<void> {
    authorize(request);
    const query = ReceiveGitLabWebhookInternalQueryParams.strict().safeParse(request.query);
    if (
      !query.success ||
      request.is('application/json') !== 'application/json' ||
      !Buffer.isBuffer(request.body)
    ) {
      return invalidRequest();
    }
    if (!ReceiveGitLabWebhookInternalBody.safeParse(request.body).success) return invalidRequest();
    const signature = singleHeader(request, 'webhook-signature', authenticationFailed);
    const timestamp = singleHeader(request, 'webhook-timestamp', authenticationFailed);
    const credential = ReceiveGitLabWebhookInternalHeader.shape;
    if (
      !credential['webhook-signature'].safeParse(signature).success ||
      !credential['webhook-timestamp'].safeParse(timestamp).success
    ) {
      return authenticationFailed();
    }
    const headers = ReceiveGitLabWebhookInternalHeader.safeParse({
      'webhook-id': singleHeader(request, 'webhook-id'),
      'X-Gitlab-Event': singleHeader(request, 'X-Gitlab-Event'),
      'webhook-timestamp': timestamp,
      'webhook-signature': signature,
    });
    if (!headers.success) return invalidRequest();
    const result = await this.accept({
      provider: 'gitlab',
      bindingId: query.data.bindingId,
      deliveryId: headers.data['webhook-id'],
      event: headers.data['X-Gitlab-Event'],
      signature: headers.data['webhook-signature'],
      timestamp: headers.data['webhook-timestamp'],
      currentUnixSeconds: Math.floor(Date.now() / 1000),
      rawBody: request.body,
    });
    this.respond(result.status);
  }

  /** Converts an intake failure to the documented unavailable response. */
  private async accept(input: AdmitGitWebhookInput): Promise<AdmitGitWebhookOutput> {
    try {
      return await this.admit.execute(input);
    } catch {
      throw new ProblemException({ status: 503, code: 'integration.unavailable' });
    }
  }

  /** Maps the intake decision to the documented empty receipt or fixed problem. */
  private respond(status: 'accepted' | 'authentication-failed' | 'invalid-delivery'): void {
    if (status === 'authentication-failed') return authenticationFailed();
    if (status === 'invalid-delivery') {
      throw new ProblemException({ status: 400, code: 'webhook.invalid-delivery' });
    }
  }
  // #endregion
}
