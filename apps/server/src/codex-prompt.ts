import type { DeviceTerms } from '@cc-desk-tunnel/agent-ipc';

// The same arrangement Claude is given: the project stays on the device, and the shell reaches it
// through the session's SSH config. Codex keeps its own tools; this only tells it where to use them.
export function codexInstructions(
  projectPath: string,
  sshConfigPath: string,
  sessionId: string,
  terms: DeviceTerms,
) {
  return [
    "The user's projects are on their own computer, the device, NOT on this Linux host, which only runs Codex and has no copy of them.",
    `Device: ${terms.name}. Project directory: ${JSON.stringify(projectPath)}.`,
    `Do all project reads, edits, searches and commands on the device with your shell over SSH, with the configuration ${JSON.stringify(sshConfigPath)}. Do not edit project files on this host, and do not print, read into conversation or copy the key the configuration names.`,
    `Send a script on standard input, as a quoted shell here-document: ssh -F ${JSON.stringify(sshConfigPath)} device-script <<'PS' ... PS. ${terms.script}`,
    `device-script is the host device with one fixed command, which the configuration shows as RemoteCommand, and takes none of its own. ${terms.command}`,
    'If the device is unreachable, say so; never fall back to this host. After an interruption report results as unknown; do not repeat side effects on your own.',
    `Scheduled and recurring prompts are sent by the desktop client, not by cron on this host: edit the UTF-8 JSON file whose path is in the device's CC_DESK_TUNNEL_SCHEDULES environment variable (its "说明" field documents the format; changes apply within seconds). This session's ID for a task that continues it: ${sessionId}.`,
  ].join('\n');
}

// What Codex is shown. The user's own words stay last. Empty additions leave the text unchanged,
// which is how a turn with no device and no earlier history is sent.
export function codexModelText(parts: {
  instructions?: string;
  history?: string;
  notice?: string;
  effort?: string | null;
  text: string;
}) {
  const blocks = [
    parts.instructions?.trim(),
    parts.effort ? `Reasoning effort for this turn: ${parts.effort}.` : '',
    parts.history?.trim()
      ? `Earlier conversation, kept so this new thread continues the same work:\n\n${parts.history.trim()}`
      : '',
    parts.notice?.trim(),
    parts.text,
  ].filter((part) => part);
  return blocks.join('\n\n');
}
