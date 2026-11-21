import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyGitHubWebhook, verifyGitLabWebhook } from './git-webhook-signature.adapter.js';

const rawBody = Buffer.from('{\r\n  "project": "Dépôt 🚀"\r\n}\n');
const rawBodyDigest = 'fb877eb137e0d0485851c7ed62a576edd90850a18f07509788dd3b68e8226ff2';
const gitLabFixtureKey = Buffer.alloc(32, 0xa8);
const gitLabFixture = {
  rawBody,
  deliveryId: '0ac042a6-88d9-4e1e-bef2-109fdb000001',
  timestamp: '1760000000',
  signature: 'v1,PD3Uk4SaZ7ZzeYiVwdBMHJTo16TLwHnB5QUCyMJ/F2w=',
  signingToken: `whsec_${gitLabFixtureKey.toString('base64')}`,
  currentUnixSeconds: 1_760_000_000,
};

describe('GitHub signature', () => {
  const fixtureSecret = "It's a Secret to Everybody";
  const fixtureBody = Buffer.from('Hello, World!');
  const fixtureSignature =
    'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

  it('matches the published GitHub test vector', () => {
    expect(verifyGitHubWebhook(fixtureBody, fixtureSignature, fixtureSecret)).toBe(
      'dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f',
    );
  });

  it('authenticates only the precise byte range and rejects reserialized JSON', () => {
    const signature = `sha256=${createHmac('sha256', fixtureSecret).update(rawBody).digest('hex')}`;
    const frame = Buffer.concat([Buffer.from('prefix'), rawBody, Buffer.from('suffix')]);
    const payload = frame.subarray(6, 6 + rawBody.byteLength);
    const reserialized = Buffer.from('{"project":"Dépôt 🚀"}');

    expect(verifyGitHubWebhook(payload, signature, fixtureSecret)).toBe(rawBodyDigest);
    expect(verifyGitHubWebhook(reserialized, signature, fixtureSecret)).toBeNull();
  });

  it.each([
    undefined,
    '',
    'sha1=757107ea0eb2509fc211221cce984b8a37570b6d7',
    'sha256=1',
    fixtureSignature.toUpperCase(),
    `${fixtureSignature}\n`,
    `${fixtureSignature}, ${fixtureSignature}`,
  ])('rejects an invalid signature header %j', (signature) => {
    expect(verifyGitHubWebhook(fixtureBody, signature, fixtureSecret)).toBeNull();
  });

  it('rejects a missing or different secret', () => {
    expect(verifyGitHubWebhook(fixtureBody, fixtureSignature, '')).toBeNull();
    expect(verifyGitHubWebhook(fixtureBody, fixtureSignature, 'another fixture')).toBeNull();
  });

  it('accepts the body size limit and rejects a valid signature beyond it', () => {
    const atLimit = Buffer.alloc(1_048_576);
    const aboveLimit = Buffer.alloc(1_048_577);
    const sign = (body: Uint8Array): string =>
      `sha256=${createHmac('sha256', fixtureSecret).update(body).digest('hex')}`;

    expect(verifyGitHubWebhook(atLimit, sign(atLimit), fixtureSecret)).toMatch(/^[0-9a-f]{64}$/u);
    expect(verifyGitHubWebhook(aboveLimit, sign(aboveLimit), fixtureSecret)).toBeNull();
  });
});

describe('GitLab signature', () => {
  it('authenticates the signed message ID, original timestamp and exact body independently', () => {
    expect(verifyGitLabWebhook(gitLabFixture)).toBe(rawBodyDigest);
    expect(
      verifyGitLabWebhook({
        ...gitLabFixture,
        deliveryId: '0ac042a6-88d9-4e1e-bef2-109fdb000002',
      }),
    ).toBeNull();
    expect(verifyGitLabWebhook({ ...gitLabFixture, timestamp: '1760000001' })).toBeNull();
    expect(
      verifyGitLabWebhook({ ...gitLabFixture, rawBody: Buffer.from('{"project":"Dépôt 🚀"}') }),
    ).toBeNull();
  });

  it('uses the timestamp and delivery ID spellings as supplied', () => {
    const deliveryId = gitLabFixture.deliveryId.toUpperCase();
    const timestamp = `0${gitLabFixture.timestamp}`;
    const signature = signGitLab(rawBody, deliveryId, timestamp);

    expect(verifyGitLabWebhook({ ...gitLabFixture, deliveryId, timestamp, signature })).toBe(
      rawBodyDigest,
    );
  });

  it.each([-300, -1, 0, 1, 300])('accepts a clock difference of %i seconds', (difference) => {
    expect(
      verifyGitLabWebhook({
        ...gitLabFixture,
        currentUnixSeconds: gitLabFixture.currentUnixSeconds + difference,
      }),
    ).toBe(rawBodyDigest);
  });

  it.each([-301, 301, Number.NaN, 0.5])(
    'rejects an invalid clock difference of %i',
    (difference) => {
      expect(
        verifyGitLabWebhook({
          ...gitLabFixture,
          currentUnixSeconds: gitLabFixture.currentUnixSeconds + difference,
        }),
      ).toBeNull();
    },
  );

  it('rejects malformed delivery fields even if the values were signed', () => {
    const malformed = {
      deliveryId: 'message.with.dots',
      timestamp: '1.760000000e9',
    };

    for (const fields of [
      { deliveryId: malformed.deliveryId },
      { timestamp: malformed.timestamp },
    ]) {
      const input = { ...gitLabFixture, ...fields };
      const signature = signGitLab(input.rawBody, input.deliveryId, input.timestamp);
      expect(verifyGitLabWebhook({ ...input, signature })).toBeNull();
    }
  });

  it('supports multiple signatures, checking a valid v1 among previous and unfamiliar signatures', () => {
    const previous = `v1,${Buffer.alloc(32, 0x19).toString('base64')}`;
    const signature = `v2,unknown v1,short ${previous} ${gitLabFixture.signature}`;

    expect(verifyGitLabWebhook({ ...gitLabFixture, signature })).toBe(rawBodyDigest);
    expect(
      verifyGitLabWebhook({ ...gitLabFixture, signature: `v2,unknown ${previous}` }),
    ).toBeNull();
  });

  it.each([
    undefined,
    '',
    gitLabFixture.signature.replace(/^v1,/u, 'v2,'),
    gitLabFixture.signature.replace(/w=$/u, 'x='),
    gitLabFixture.signature.replace('=', ''),
    `${gitLabFixture.signature},${gitLabFixture.signature}`,
  ])('rejects an unsupported or noncanonical signature %j', (signature) => {
    expect(verifyGitLabWebhook({ ...gitLabFixture, signature })).toBeNull();
  });

  it.each([
    'legacy fixture token',
    'whsec_',
    `whsec_${Buffer.alloc(31).toString('base64')}`,
    `whsec_${Buffer.alloc(32, 0x33).toString('base64')}`,
  ])('rejects an invalid test signing token %j', (signingToken) => {
    expect(verifyGitLabWebhook({ ...gitLabFixture, signingToken })).toBeNull();
  });

  it('bounds the signature header before scanning rotation candidates', () => {
    const unknownSignature = 'v2,'.padEnd(4_096 - gitLabFixture.signature.length - 1, 'a');
    const atLimit = `${unknownSignature} ${gitLabFixture.signature}`;

    expect(verifyGitLabWebhook({ ...gitLabFixture, signature: atLimit })).toBe(rawBodyDigest);
    expect(verifyGitLabWebhook({ ...gitLabFixture, signature: `a${atLimit}` })).toBeNull();
  });

  it('accepts the body size limit and rejects a valid signature beyond it', () => {
    const atLimit = Buffer.alloc(1_048_576);
    const aboveLimit = Buffer.alloc(1_048_577);

    expect(
      verifyGitLabWebhook({ ...gitLabFixture, rawBody: atLimit, signature: signGitLab(atLimit) }),
    ).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      verifyGitLabWebhook({
        ...gitLabFixture,
        rawBody: aboveLimit,
        signature: signGitLab(aboveLimit),
      }),
    ).toBeNull();
  });
});

function signGitLab(
  body: Uint8Array,
  deliveryId = gitLabFixture.deliveryId,
  timestamp = gitLabFixture.timestamp,
): string {
  const message = Buffer.concat([Buffer.from(`${deliveryId}.${timestamp}.`), body]);
  return `v1,${createHmac('sha256', gitLabFixtureKey).update(message).digest('base64')}`;
}
