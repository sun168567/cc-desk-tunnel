import { ExternalLink } from 'lucide-react';
import { CopyButton } from './copy.tsx';
import { project } from './project.tsx';
import { Modal } from './ui.tsx';

const script = `https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install-ccdt`;

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
  const platform = window.desktop?.platform ?? '';
  const command = installCommand(platform, version);
  return (
    <Modal title={installed ? '更新 ccdt' : '安装 ccdt'} onClose={close}>
      <div className="dialog-form ccdt-dialog">
        <p>
          {installed
            ? `这台电脑上的 ccdt 是 ${installed}，要与服务端同为 ${version} 才能连接。`
            : '在 ccdt 中打开需要先安装终端客户端 ccdt：在自己的终端里使用原版 Claude Code，与这里共用会话。'}
        </p>
        <p className="muted">
          在{platform === 'win32' ? ' PowerShell ' : '终端'}里运行下面这行，装好后再选一次“在 ccdt
          中打开”：
        </p>
        <div className="code-block">
          <pre>
            <code>{command}</code>
          </pre>
          <span className="code-actions">
            <CopyButton text={command} label="复制命令" />
          </span>
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => void window.desktop?.openExternal(`${project.url}#终端客户端-ccdt`)}
          >
            <ExternalLink />
            安装说明
          </button>
          <button type="button" className="button primary" onClick={close}>
            知道了
          </button>
        </div>
      </div>
    </Modal>
  );
}
