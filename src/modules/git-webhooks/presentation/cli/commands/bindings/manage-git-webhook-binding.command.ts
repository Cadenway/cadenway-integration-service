import { parseArgs } from 'node:util';

import { z } from 'zod';

import type { ManageGitWebhookBindingInput } from '../../../../application/use-cases/commands/bindings/manage-git-webhook-binding/manage-git-webhook-binding.input.js';

const id = z.uuidv7().transform((value) => value.toLowerCase());
const positiveInteger = z
  .string()
  .regex(/^[1-9][0-9]*$/u)
  .transform(Number)
  .pipe(z.int().positive());
const receiver = {
  organization: id,
  binding: id,
  provider: z.enum(['github', 'gitlab']),
  revision: positiveInteger,
};
const receiverOptions = z.strictObject(receiver);
const registrationOptions = z.strictObject({
  ...receiver,
  repository: positiveInteger,
  installation: positiveInteger.optional(),
  integration: id,
  space: id,
  author: id,
});

function parseBindingCommand(args: readonly string[]): ManageGitWebhookBindingInput | null {
  const { positionals, values, tokens } = parseArgs({
    args: [...args],
    allowPositionals: true,
    tokens: true,
    options: {
      organization: { type: 'string' },
      binding: { type: 'string' },
      provider: { type: 'string' },
      revision: { type: 'string' },
      repository: { type: 'string' },
      installation: { type: 'string' },
      integration: { type: 'string' },
      space: { type: 'string' },
      author: { type: 'string' },
    },
  });
  const names = tokens.flatMap((token) => (token.kind === 'option' ? [token.name] : []));
  if (positionals.length !== 1 || names.length !== new Set(names).size) return null;
  const [action] = positionals;
  if (action === 'rotate' || action === 'revoke') {
    const metadata = receiverOptions.safeParse(values);
    if (!metadata.success) return null;
    const { organization, binding, provider, revision } = metadata.data;
    return { action, organizationId: organization, bindingId: binding, provider, revision };
  }
  if (action !== 'register') return null;
  const metadata = registrationOptions.safeParse(values);
  if (!metadata.success) return null;
  const {
    organization,
    binding,
    provider,
    revision,
    installation,
    repository,
    integration,
    space,
    author,
  } = metadata.data;
  if ((provider === 'github') !== (installation !== undefined)) return null;
  return {
    action,
    organizationId: organization,
    bindingId: binding,
    provider,
    revision,
    installationId: installation ?? null,
    repositoryId: repository,
    integrationId: integration,
    spaceId: space,
    mappingAuthorUserId: author,
  };
}

/** Validates operator metadata and emits only fixed diagnostics on failure. */
export async function runGitWebhookBindingCommand(
  args: readonly string[],
  execute: (input: ManageGitWebhookBindingInput) => Promise<boolean>,
): Promise<number> {
  let input: ManageGitWebhookBindingInput | null;
  try {
    input = parseBindingCommand(args);
  } catch {
    input = null;
  }
  if (input === null) {
    console.error('Invalid Git binding command. See the operator runbook.');
    return 2;
  }
  try {
    if (await execute(input)) {
      console.log('Git binding command applied.');
      return 0;
    }
    console.error('Git binding conflict. Check the tenant, provider, metadata and revision.');
  } catch {
    console.error('Git binding command failed. Check Integration database access and migrations.');
  }
  return 1;
}
