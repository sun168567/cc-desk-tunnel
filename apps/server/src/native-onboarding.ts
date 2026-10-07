import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The CLI marks its first-run wizard done only when the user confirms the wizard's last screen. An account signed in
// without reaching that screen would be asked to pick a theme and sign in again on every terminal start.
export function completeOnboarding(configDirectory = process.env.CLAUDE_CONFIG_DIR) {
  const statePath = join(configDirectory ?? homedir(), '.claude.json');
  try {
    const credentials = JSON.parse(
      readFileSync(
        join(configDirectory ?? join(homedir(), '.claude'), '.credentials.json'),
        'utf8',
      ),
    );
    if (!credentials?.claudeAiOauth?.accessToken) return false;
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (state.hasCompletedOnboarding === true) return false;
    writeFileSync(
      `${statePath}.onboarding`,
      JSON.stringify({ ...state, hasCompletedOnboarding: true }, null, 2),
      { mode: 0o600 },
    );
    renameSync(`${statePath}.onboarding`, statePath);
    return true;
  } catch {
    return false;
  }
}
