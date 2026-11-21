import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyNestArchitecture } from '@cadenway/nest-testing/architecture';

const generatedTaskClient =
  'src/modules/git-webhooks/infrastructure/adapters/task-service/generated/task-service.ts';

test('authored code follows the Cadenway architecture', () => {
  // Orval writes multiple declarations to this file. CI checks it against the published spec.
  const findings = verifyNestArchitecture({
    rootDir: fileURLToPath(new URL('../..', import.meta.url)),
    tsconfig: 'tsconfig.json',
    profile: 'service',
    convention: 'strict',
  }).filter(({ file, rule }) => file !== generatedTaskClient || rule !== 'strict-contract-file');
  assert.equal(
    findings.length,
    0,
    findings
      .map(({ file, line, rule, message }) => `${file}:${line} [${rule}] ${message}`)
      .join('\n'),
  );
});
