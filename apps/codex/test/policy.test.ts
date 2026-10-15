import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexTurnPolicy, policyRejected } from '../src/policy.ts';

test('session approval modes become Codex turn fields', () => {
  assert.deepEqual(codexTurnPolicy('auto').sandboxPolicy, {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
  assert.equal(codexTurnPolicy('default').approvalPolicy, 'on-request');
  assert.equal(codexTurnPolicy('acceptEdits').approvalPolicy, 'on-request');
  const plan = codexTurnPolicy('plan').sandboxPolicy;
  assert.equal(plan.type, 'readOnly');
  if (plan.type === 'readOnly') assert.equal(plan.networkAccess, true);
  assert.deepEqual(codexTurnPolicy('bypassPermissions'), {
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
  });
  assert.equal(policyRejected('unknown field approvalPolicy'), true);
  assert.equal(policyRejected('thread not found'), false);
});
