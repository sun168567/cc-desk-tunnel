const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const connections = require('./connections.cjs');

// The service distributes this x64 installer. A direct GitHub download of the same release also
// checks the hash announced by the service.
function windowsInstaller({ profile, otherConnections }) {
  return {
    releaseOptions(version, { bridge }) {
      return version === undefined
        ? null
        : {
            name: `CC-Desk-Tunnel-Setup-${version}-x64.exe`,
            announced: bridge?.release(),
          };
    },
    instances: () =>
      otherConnections()
        .filter(({ id }) => connections.running(profile, id))
        .map(({ id }) => id),
    requestQuit: (id) => connections.tell(profile, id, 'quit'),
    prepare({ file }) {
      return {
        async install() {
          // Give the window time to show the handoff before the silent installer restarts the app.
          await delay(800);
          const child = spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' });
          await once(child, 'spawn');
          child.unref();
        },
      };
    },
  };
}
module.exports = { windowsInstaller };
