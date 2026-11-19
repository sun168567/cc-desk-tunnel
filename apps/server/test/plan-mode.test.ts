import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvedPlan, keepPlanning } from '../src/claude.ts';

test('a plan approved takes the mode chosen and the plan as changed; one sent back says what to change', () => {
  const shown: Record<string, unknown>[] = [];
  const mapper = {
    tool: (_name: string, input: Record<string, unknown>) => (shown.push(input), null!),
  };
  const input = { plan: '# 计划', planFilePath: '/home/plans/a.md' };
  assert.deepEqual(approvedPlan(mapper, 'ExitPlanMode', input, 't1', { mode: 'acceptEdits' }), {
    behavior: 'allow',
    updatedInput: input,
    updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
  });
  assert.deepEqual(shown, []);
  const changed = approvedPlan(mapper, 'ExitPlanMode', input, 't1', { edited: '# 改过' });
  assert.deepEqual(changed, {
    behavior: 'allow',
    updatedInput: { plan: '# 改过', planFilePath: '/home/plans/a.md' },
  });
  // The plan carried out is the one shown.
  assert.deepEqual(shown, [{ plan: '# 改过', planFilePath: '/home/plans/a.md' }]);
  assert.equal(
    keepPlanning(' 先别动第二步 '),
    'The user has not approved the plan and wants you to keep planning. Their feedback:\n先别动第二步',
  );
  assert.equal(
    keepPlanning(''),
    'The user has not approved the plan and wants you to keep planning.',
  );
});
