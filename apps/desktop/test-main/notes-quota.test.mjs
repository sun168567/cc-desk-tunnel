import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { absoluteLinks, alertLabels, releaseSection } from '../src/notes.ts';
import { quotaFigures } from '../src/quota.ts';
import { t } from '../src/i18n.ts';

test('a version’s notes are its section of the changelog, without the heading', () => {
  const text =
    '# 变更记录\n\n说明\n\n## 0.3.2\n\n一句话。\n\n### 新增功能\n\n- 甲\n\n## 0.3.1\n\n旧的\n';
  assert.equal(releaseSection(text, '0.3.2'), '一句话。\n\n### 新增功能\n\n- 甲');
  assert.equal(releaseSection(text.replaceAll('\n', '\r\n'), '0.3.1'), '旧的');
  assert.equal(releaseSection(text, '0.3'), null);
  assert.equal(releaseSection(text, '9.9.9'), null);
  // The file the program carries has a section for the version it is.
  const version = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ).version;
  assert.match(
    releaseSection(
      readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8'),
      version,
    ),
    /###/,
  );
});

test('links into the repository point at the version’s files on GitHub', () => {
  const repository = 'https://github.com/o/r';
  assert.equal(
    absoluteLinks(
      '见 [macOS 说明](docs/macos.md) 与 [部署](./deploy/README.md#升级)。',
      repository,
      '0.3.1',
    ),
    `见 [macOS 说明](${repository}/blob/v0.3.1/docs/macos.md) 与 [部署](${repository}/blob/v0.3.1/deploy/README.md#升级)。`,
  );
  const kept =
    '[议题](https://github.com/o/r/issues) [上面](#新增功能) [信](mailto:a@b.c) 价格（$5）';
  assert.equal(absoluteLinks(kept, repository, '0.3.1'), kept);
});

test('the quota beside the message box is the five hours and the week, the model’s own when that is fuller', () => {
  const window = (name, utilization) => ({ name, utilization, resetsAt: null });
  assert.deepEqual(quotaFigures(t, null), []);
  assert.deepEqual(quotaFigures(t, { available: false, windows: [window('five_hour', 10)] }), []);
  const limits = {
    available: true,
    windows: [
      window('five_hour', 7.4),
      window('seven_day', 41),
      window('seven_day:Fable', 78.5),
      window('seven_day_oauth_apps', 99),
      window('seven_day:Sonnet', null),
    ],
  };
  // The account's whole week, whatever model's own week is fuller.
  assert.deepEqual(quotaFigures(t, limits), [
    { label: '5 小时', used: 7, resetsAt: null },
    { label: '每周', used: 41, resetsAt: null },
  ]);
  assert.deepEqual(quotaFigures(t, limits, 'sonnet claude-sonnet-5-5')[1], {
    label: '每周',
    used: 41,
    resetsAt: null,
  });
  // The model in use has a week of its own, fuller: that one, named after it.
  assert.deepEqual(quotaFigures(t, limits, 'fable claude-fable-5-2')[1], {
    label: 'Fable 每周',
    used: 79,
    resetsAt: null,
  });
  assert.deepEqual(
    quotaFigures(
      t,
      { available: true, windows: [window('seven_day', 50), window('seven_day_opus', 20)] },
      'opus',
    )[0],
    { label: '每周', used: 50, resetsAt: null },
  );
  // Without the whole week, the fullest stands in, named after its model.
  assert.deepEqual(quotaFigures(t, { available: true, windows: [window('seven_day_opus', 20)] }), [
    { label: 'Opus 每周', used: 20, resetsAt: null },
  ]);
  assert.deepEqual(quotaFigures(t, { available: true, windows: [window('seven_day', 0)] }), [
    { label: '每周', used: 0, resetsAt: null },
  ]);
});
