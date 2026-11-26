import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  infoPlistStrings,
  usageDescriptions,
  usageResources,
} from '../../../scripts/macos-usage.mjs';

test('the macOS permission prompts are English in Info.plist and Chinese in the Chinese folders', (t) => {
  const english = usageDescriptions('en');
  const chinese = usageDescriptions('zh-CN');
  assert.deepEqual(Object.keys(english), Object.keys(chinese));
  assert.equal(Object.keys(english).length, 5);
  for (const text of Object.values(english)) assert.doesNotMatch(text, /[一-鿿]|desktop:/);
  assert.equal(
    chinese.NSDocumentsFolderUsageDescription,
    '访问你选择的文稿项目，让 Claude 经执行通道读取和修改其中的文件。',
  );
  const directory = mkdtempSync(join(tmpdir(), 'macos-usage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const resources = usageResources(directory);
  assert.deepEqual(
    resources.map((resource) => resource.to),
    ['zh_CN.lproj/InfoPlist.strings', 'zh_TW.lproj/InfoPlist.strings'],
  );
  assert.equal(readFileSync(resources[0].from, 'utf8'), infoPlistStrings(chinese));
  assert.match(
    readFileSync(resources[0].from, 'utf8'),
    /^"NSDesktopFolderUsageDescription" = "访问你选择的桌面项目，[^"\n]*";$/m,
  );
});

test('InfoPlist.strings quotes what it says', () => {
  assert.equal(infoPlistStrings({ A: 'say "hi"\\\nnow' }), '"A" = "say \\"hi\\"\\\\\\nnow";\n');
});
