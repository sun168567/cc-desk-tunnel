const { mkdir, readdir, lstat, writeFile } = require('node:fs/promises');
const { join, basename } = require('node:path');
const { randomUUID } = require('node:crypto');
const maximum = 20 * 1024 * 1024;
let writing = Promise.resolve();

// Attachments remain on the execution host because saved conversations reference their paths; never silently delete them.
// A bounded store rejects new uploads rather than filling the profile disk indefinitely.
function saveWebUpload(root, name, encoded, quota = 200 * 1024 * 1024) {
  const operation = writing.then(async () => {
    if (
      typeof name !== 'string' ||
      !name ||
      name.length > 255 ||
      typeof encoded !== 'string' ||
      encoded.length > Math.ceil(maximum / 3) * 4 ||
      encoded.length % 4 !== 0
    )
      throw new Error('附件格式错误，单个附件最多 20 MB。');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > maximum) throw new Error('单个附件最多 20 MB。');
    // Node's decoder accepts malformed input. A linear round-trip also checks padding bits,
    // without a repeated regex group exhausting the stack on otherwise valid large uploads.
    if (bytes.toString('base64') !== encoded) throw new Error('附件格式错误，单个附件最多 20 MB。');
    await mkdir(root, { recursive: true });
    let used = 0;
    for (const directory of await readdir(root, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      for (const file of await readdir(join(root, directory.name), { withFileTypes: true })) {
        if (file.isFile()) used += (await lstat(join(root, directory.name, file.name))).size;
      }
    }
    if (used + bytes.length > quota)
      throw new Error(
        '桌面客户端的 Web 附件已达 200 MB，请在该客户端清理不再使用的 uploads 文件后重试。',
      );
    let filename =
      basename(name)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/[. ]+$/, '') || 'attachment';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) filename = `_${filename}`;
    const directory = join(root, randomUUID());
    await mkdir(directory);
    const target = join(directory, filename);
    await writeFile(target, bytes, { flag: 'wx' });
    return target;
  });
  writing = operation.catch(() => {});
  return operation;
}
module.exports = { saveWebUpload };
