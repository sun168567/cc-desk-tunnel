import { Download, Settings, SquareTerminal, Unplug } from 'lucide-react';
import { useState } from 'react';
import { FORCED_UPGRADE_SINCE } from '@cc-desk-tunnel/protocol';
import { thisDevice } from './device.ts';
import { GithubMark, openProject, project } from './project.tsx';
import { useConnectionName } from './shared.ts';

export type ConnectionForm = {
  url: string;
  token: string;
  fingerprint: string;
  mode: 'local' | 'remote';
  // Desktop only: keep the token (encrypted for this Windows account) and connect on the next launch.
  remember: boolean;
  autoLogin: boolean;
};

export default function LoginPage({
  form,
  change,
  connecting,
  error,
  upgrade,
  direct,
  downloaded,
  install,
  older,
  newer,
  showNotes,
  submit,
  openSettings,
}: {
  form: ConnectionForm;
  change: (values: Partial<ConnectionForm>) => void;
  connecting: boolean;
  error: string | null;
  // The version of the installer a service of another version offers this client.
  upgrade: string | null;
  // The service's version, when this client is the older one: its installer can be fetched from the release
  // page instead, and `downloaded` is how far that is, from 0 to 1.
  direct: string | null;
  downloaded: number | null;
  // Fetches and runs the installer the service holds, or the given version's from the release page.
  install: (version?: string) => void;
  // The service's version, when it refused this client as the newer one: it can be asked to upgrade itself.
  older: string | null;
  // The version the service is at or offers, when it is newer than this client: its notes can be read.
  newer: string | null;
  // Shows what a version changed.
  showNotes: (version: string) => void;
  submit: () => void;
  // This computer's own settings, which need no connection.
  openSettings: () => void;
}) {
  const connectionName = useConnectionName();
  const [serviceUpgrade, setServiceUpgrade] = useState<{
    phase: 'running' | 'done' | 'failed';
    text: string;
    // Refused for sessions at work, by a service that can be forced past them.
    forcible?: boolean;
  } | null>(null);
  function upgradeService(service: string, force = false) {
    if (
      !window.confirm(
        force
          ? `服务端 ${service} 上有会话正在运行。强行升级会重启服务端：正在进行的回答、命令和等你确认的审批会被中断，可能需要重新开始。继续？`
          : `服务端 ${service} 将升级到最新的正式版并重启，需要几分钟。继续？`,
      )
    )
      return;
    setServiceUpgrade({ phase: 'running', text: '正在升级服务端' });
    const stop = window.desktop!.onServiceUpgrade(
      (update) =>
        update.detail &&
        setServiceUpgrade({ phase: 'running', text: `正在升级服务端：${update.detail}` }),
    );
    void thisDevice()
      .then((device) =>
        window.desktop!.upgradeService({
          url: form.url,
          fingerprint: form.fingerprint,
          token: form.token.trim(),
          deviceName: device.name,
          service,
          ...(force ? { force } : {}),
        }),
      )
      .then(({ version, error, code }) =>
        setServiceUpgrade(
          version
            ? { phase: 'done', text: `服务端已升级到 ${version}，正在重启；稍候再连接。` }
            : {
                phase: 'failed',
                text: error ?? '服务端升级失败。',
                forcible:
                  code === 'busy' &&
                  service.localeCompare(FORCED_UPGRADE_SINCE, undefined, { numeric: true }) >= 0,
              },
        ),
      )
      .finally(stop);
  }
  const shownError =
    serviceUpgrade && serviceUpgrade.phase !== 'running' ? serviceUpgrade.text : error;
  return (
    <main className="login-page">
      <div className="window-drag" />
      <div className="login-content">
        <div className="brand">
          <SquareTerminal />
          <span>CC Desk Tunnel</span>
          {connectionName && <span className="brand-connection">{connectionName}</span>}
        </div>
        <div className="login-title">
          <h1>连接代理服务</h1>
          {form.mode === 'local' && <span className="badge simulation">离线模拟</span>}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setServiceUpgrade(null);
            submit();
          }}
          className="connection-form"
        >
          {window.desktop?.dev && (
            <div className="connection-modes" role="group" aria-label="连接方式">
              <button
                type="button"
                aria-pressed={form.mode === 'local'}
                onClick={() => change({ mode: 'local' })}
              >
                本地模拟
              </button>
              <button
                type="button"
                aria-pressed={form.mode === 'remote'}
                onClick={() => change({ mode: 'remote' })}
              >
                远程代理
              </button>
            </div>
          )}
          <label>
            服务地址
            <input
              autoFocus
              type="url"
              value={form.url}
              onChange={(event) => change({ url: event.target.value })}
              required
              spellCheck={false}
            />
          </label>
          {form.mode === 'remote' && (
            <label>
              服务证书指纹（可选）
              <input
                aria-label="服务证书指纹"
                value={form.fingerprint}
                onChange={(event) => change({ fingerprint: event.target.value })}
                placeholder="留空使用 CA 验证"
                spellCheck={false}
              />
            </label>
          )}
          <label>
            服务凭据
            <input
              type="password"
              value={form.token}
              onChange={(event) => change({ token: event.target.value })}
              required
              autoComplete="off"
            />
          </label>
          {window.desktop && (
            <div className="login-options">
              <label>
                <input
                  type="checkbox"
                  checked={form.remember}
                  onChange={(event) =>
                    change({
                      remember: event.target.checked,
                      autoLogin: event.target.checked && form.autoLogin,
                    })
                  }
                />
                记住凭据
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.autoLogin}
                  onChange={(event) =>
                    change({
                      autoLogin: event.target.checked,
                      remember: event.target.checked || form.remember,
                    })
                  }
                />
                自动登录
              </label>
            </div>
          )}
          {shownError && (
            <p className="error-text" role="alert">
              {shownError}
            </p>
          )}
          {upgrade && (
            <button
              className="button login-submit"
              type="button"
              disabled={connecting}
              onClick={() => install()}
            >
              <Download />
              升级客户端到 {upgrade}
            </button>
          )}
          {older && serviceUpgrade?.phase !== 'done' && (
            <button
              className="button login-submit"
              type="button"
              disabled={connecting || serviceUpgrade?.phase === 'running'}
              onClick={() => upgradeService(older)}
            >
              <Download />
              {serviceUpgrade?.phase === 'running' ? serviceUpgrade.text : '升级服务端'}
            </button>
          )}
          {older && serviceUpgrade?.forcible && (
            <button
              className="button login-submit"
              type="button"
              disabled={connecting}
              onClick={() => upgradeService(older, true)}
            >
              <Download />
              强行升级服务端
            </button>
          )}
          {newer && (
            <button className="button login-submit" type="button" onClick={() => showNotes(newer)}>
              查看 {newer} 的更新内容
            </button>
          )}
          {direct && (
            <button
              className="button login-submit"
              type="button"
              disabled={connecting}
              onClick={() => install(direct)}
            >
              <Download />
              {downloaded !== null
                ? `正在从 GitHub 下载 ${Math.floor(downloaded * 100)}%`
                : upgrade
                  ? `改从 GitHub 发布页下载 ${direct}`
                  : `从 GitHub 发布页下载并升级到 ${direct}`}
            </button>
          )}
          <button className="button primary login-submit" disabled={connecting}>
            <Unplug />
            {connecting ? '连接中…' : '连接'}
          </button>
        </form>
        <div className="login-links">
          <button className="project-link" type="button" onClick={openSettings}>
            <Settings />
            本机设置
          </button>
          {project.url && (
            <button className="project-link" type="button" onClick={openProject}>
              <GithubMark />
              {project.name}
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
