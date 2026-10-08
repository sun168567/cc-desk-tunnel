const path = require('node:path');
const { readFile, stat } = require('node:fs/promises');

// The branch a directory's working tree is on, read from the repository's own files so that it does not depend
// on git being installed: the name, a short commit for a detached HEAD, or null outside a repository.
async function gitBranch(directory) {
  let current = path.resolve(String(directory));
  for (;;) {
    try {
      let git = path.join(current, '.git');
      // A linked working tree or a submodule has a file here that names the real directory.
      if ((await stat(git)).isFile()) {
        const link = /^gitdir: (.+)$/m.exec(await readFile(git, 'utf8'));
        if (!link) return null;
        git = path.resolve(current, link[1].trim());
      }
      const head = (await readFile(path.join(git, 'HEAD'), 'utf8')).trim();
      const branch = /^ref: refs\/heads\/(.+)$/.exec(head);
      return branch ? branch[1] : head.slice(0, 7);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

module.exports = { gitBranch };
