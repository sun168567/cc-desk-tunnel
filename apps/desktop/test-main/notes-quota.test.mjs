import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { absoluteLinks, releaseSection } from '../src/notes.ts';
import { quotaFigures } from '../src/quota.ts';

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

test('the quota beside the message box is the five hours and the fullest week', () => {
  const window = (name, utilization) => ({ name, utilization, resetsAt: null });
  assert.deepEqual(quotaFigures(null), []);
  assert.deepEqual(quotaFigures({ available: false, windows: [window('five_hour', 10)] }), []);
  assert.deepEqual(
    quotaFigures({
      available: true,
      windows: [
        window('five_hour', 7.4),
        window('seven_day', 41),
        window('seven_day:opus', 78.5),
        window('seven_day_oauth_apps', 99),
        window('seven_day:sonnet', null),
      ],
    }),
    [
      { label: '5 小时', used: 7, resetsAt: null },
      { label: '每周', used: 79, resetsAt: null },
    ],
  );
  assert.deepEqual(quotaFigures({ available: true, windows: [window('seven_day', 0)] }), [
    { label: '每周', used: 0, resetsAt: null },
  ]);
});
