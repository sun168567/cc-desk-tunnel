import { ExternalLink } from 'lucide-react';
import { useT } from './i18n.ts';
import { CopyButton } from './copy.tsx';
import { project } from './project.tsx';
import { Modal } from './ui.tsx';

const script = `https://github.com/sun168567/cc-desk-tunnel/releases/latest/download/install-ccdt`;

// The one line that installs ccdt of `version`, the service's, on this system; see docs/cli.md.
export function installCommand(platform: string, version: string) {
  return platform === 'win32'
    ? `$env:CCDT_VERSION = '${version}'; irm ${script}.ps1 | iex`
    : `curl -fsSL ${script}.sh | CCDT_VERSION=${version} sh`;
}

// Opening a session in ccdt found it not installed, or `installed` of another release than the service's.
export function CcdtDialog({
  installed,
  version,
  close,
}: {
  installed?: string;
  version: string;
  close: () => void;
}) {
  const t = useT();
  const platform = window.desktop?.platform ?? '';
  const command = installCommand(platform, version);
  return (
    <Modal title={installed ? t('session:ccdt.update') : t('session:ccdt.install')} onClose={close}>
      <div className="dialog-form ccdt-dialog">
        <p>
          {installed
            ? t('session:ccdt.outdated', { installed, version })
            : t('session:ccdt.needed')}
        </p>
        <p className="muted">
          {t(platform === 'win32' ? 'session:ccdt.runPowerShell' : 'session:ccdt.runTerminal')}
        </p>
        <div className="code-block">
          <pre>
            <code>{command}</code>
          </pre>
          <span className="code-actions">
            <CopyButton text={command} label={t('session:ccdt.copy')} />
          </span>
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => void window.desktop?.openExternal(`${project.url}#终端客户端-ccdt`)}
          >
            <ExternalLink />
            {t('session:ccdt.guide')}
          </button>
          <button type="button" className="button primary" onClick={close}>
            {t('common:gotIt')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
