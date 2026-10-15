import type { PermissionMode } from '@cc-desk-tunnel/protocol';

// Codex's own turn fields. Claude's mode names are not sent through.
export type CodexApprovalPolicy = 'on-request' | 'never';
export type CodexSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: true }
  | {
      type: 'workspaceWrite';
      writableRoots: [];
      networkAccess: true;
      excludeTmpdirEnvVar: false;
      excludeSlashTmp: false;
    };

// Network stays open in every sandboxed mode: the project is on the user's computer, and Codex
// reaches it by SSH to the service's loopback port. A sandbox that blocked the network would
// make that path fail closed. Plan mode is read-only on this host; bypass turns the sandbox off.
export function codexTurnPolicy(mode: PermissionMode): {
  approvalPolicy: CodexApprovalPolicy;
  sandboxPolicy: CodexSandboxPolicy;
} {
  if (mode === 'bypassPermissions')
    return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
  if (mode === 'plan')
    return {
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
    };
  return {
    approvalPolicy: 'on-request',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  };
}

// An older app-server rejects the two fields instead of ignoring them.
export function policyRejected(text: string) {
  return /unknown field|invalid params|invalid type|unrecognized|not supported|unsupported/i.test(
    text,
  );
}
