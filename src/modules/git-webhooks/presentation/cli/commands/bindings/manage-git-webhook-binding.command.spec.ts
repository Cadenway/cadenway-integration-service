import { describe, expect, it, vi } from 'vitest';

import { runGitWebhookBindingCommand } from './manage-git-webhook-binding.command.js';

const organization = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const binding = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01';
const receiver = [
  '--organization',
  organization.toUpperCase(),
  '--binding',
  binding,
  '--provider',
  'github',
  '--revision',
  '1',
];
const mapping = [
  '--repository',
  '123',
  '--integration',
  binding,
  '--space',
  binding,
  '--author',
  binding,
];

describe('Git binding command', () => {
  it('validates exact GitHub installation metadata before opening a transaction', async () => {
    const execute = vi.fn(() => Promise.resolve(true));
    const result = await runGitWebhookBindingCommand(
      ['register', ...receiver, ...mapping, '--installation', '456'],
      execute,
    );
    expect(result).toBe(0);
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      action: 'register',
      organizationId: organization,
      bindingId: binding,
      provider: 'github',
      revision: 1,
      repositoryId: 123,
      installationId: 456,
      spaceId: binding,
      integrationId: binding,
      mappingAuthorUserId: binding,
    });
  });

  it('rejects missing provider metadata or ambiguous destructive arguments', async () => {
    const execute = vi.fn(() => Promise.resolve(true));
    expect(await runGitWebhookBindingCommand(['register', ...receiver, ...mapping], execute)).toBe(
      2,
    );
    expect(
      await runGitWebhookBindingCommand(['revoke', ...receiver, '--revision', '2'], execute),
    ).toBe(2);
    expect(execute).not.toHaveBeenCalled();
  });
});
