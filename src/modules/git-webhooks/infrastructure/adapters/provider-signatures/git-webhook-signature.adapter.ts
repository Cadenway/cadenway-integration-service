import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = 1_048_576;
const MAX_GITLAB_SIGNATURE_LENGTH = 4_096;
const MAX_GITLAB_TIMESTAMP_SKEW_SECONDS = 300;
const GITHUB_SIGNATURE_PREFIX = 'sha256=';
const GITLAB_SIGNING_TOKEN_PREFIX = 'whsec_';
const GITLAB_SIGNATURE_VERSION = 'v1,';
const GITHUB_SIGNATURE = /^sha256=[a-f0-9]{64}$/u;
const GITLAB_DELIVERY_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const GITLAB_TIMESTAMP = /^[0-9]{1,12}$/u;
const SHA256_BASE64 = /^[A-Za-z0-9+/]{43}=$/u;

interface GitLabWebhookVerification {
  // #region Properties
  /** Original request bytes. */
  readonly rawBody: Uint8Array;
  readonly deliveryId: string;

  /** Original decimal timestamp text from GitLab, in Unix seconds. */
  readonly timestamp: string;
  readonly signature: string | undefined;
  readonly signingToken: string;

  /** Receiver clock in whole Unix seconds. */
  readonly currentUnixSeconds: number;
  // #endregion
}

/** Authenticates the exact GitHub body bytes and returns their SHA-256 digest on success. */
export function verifyGitHubWebhook(
  rawBody: Uint8Array,
  signature: string | undefined,
  webhookSecret: string,
): string | null {
  if (
    rawBody.byteLength > MAX_BODY_BYTES ||
    !signature ||
    !GITHUB_SIGNATURE.test(signature) ||
    webhookSecret.length === 0
  ) {
    return null;
  }

  const supplied = Buffer.from(signature.slice(GITHUB_SIGNATURE_PREFIX.length), 'hex');
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest();
  return timingSafeEqual(expected, supplied) ? bodyDigest(rawBody) : null;
}

/** Verifies a fresh GitLab Standard Webhooks signature and returns the digest of the exact body. */
export function verifyGitLabWebhook({
  rawBody,
  deliveryId,
  timestamp,
  signature,
  signingToken,
  currentUnixSeconds,
}: GitLabWebhookVerification): string | null {
  if (
    rawBody.byteLength > MAX_BODY_BYTES ||
    !signature ||
    signature.length > MAX_GITLAB_SIGNATURE_LENGTH ||
    !GITLAB_DELIVERY_ID.test(deliveryId) ||
    !GITLAB_TIMESTAMP.test(timestamp) ||
    !Number.isSafeInteger(currentUnixSeconds) ||
    Math.abs(currentUnixSeconds - Number(timestamp)) > MAX_GITLAB_TIMESTAMP_SKEW_SECONDS ||
    !signingToken.startsWith(GITLAB_SIGNING_TOKEN_PREFIX)
  ) {
    return null;
  }

  const key = decodeSha256Base64(signingToken.slice(GITLAB_SIGNING_TOKEN_PREFIX.length));
  if (!key) {
    return null;
  }

  const expected = createHmac('sha256', key)
    .update(`${deliveryId}.${timestamp}.`)
    .update(rawBody)
    .digest();
  let matches = false;

  for (const candidate of signature.split(' ')) {
    if (candidate.startsWith(GITLAB_SIGNATURE_VERSION)) {
      const supplied = decodeSha256Base64(candidate.slice(GITLAB_SIGNATURE_VERSION.length));
      if (supplied) {
        matches = timingSafeEqual(expected, supplied) || matches;
      }
    }
  }

  return matches ? bodyDigest(rawBody) : null;
}

function decodeSha256Base64(value: string): Buffer | null {
  if (!SHA256_BASE64.test(value)) {
    return null;
  }

  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

function bodyDigest(rawBody: Uint8Array): string {
  return createHash('sha256').update(rawBody).digest('hex');
}
