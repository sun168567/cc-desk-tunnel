import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProxyServer } from './server.ts';
import { rmSync } from 'node:fs';
import { clearServiceVariables, environmentConfig } from './config.ts';
import { removeFrpLeftovers } from './legacy.ts';

const { options, native, port } = environmentConfig(
  process.env,
  fileURLToPath(new URL('../../../.local/sessions', import.meta.url)),
);
const programDir = process.env.PROXY_PROGRAM_DIR;
if (native) removeFrpLeftovers();
clearServiceVariables(process.env);
if (native) rmSync(join(options.dataDir, 'connections'), { recursive: true, force: true });
const server = createProxyServer(options);
console.log(`Proxy ${native ? 'native' : 'simulation'} service: ${await server.listen(port)}`);
// The entry script counts starts of an upgraded program and gives up on it after three that did not get here.
if (programDir) rmSync(join(programDir, 'attempts'), { force: true });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.close();
}
process.on('SIGINT', () => {
  void stop();
});
process.on('SIGTERM', () => {
  void stop();
});
