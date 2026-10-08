import { Download, SquareTerminal, Unplug } from 'lucide-react';
import { GithubMark, openProject, project } from './project.tsx';

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
  install,
  submit,
}: {
  form: ConnectionForm;
  change: (values: Partial<ConnectionForm>) => void;
  connecting: boolean;
  error: string | null;
  // The version of the installer a service of another version offers this client.
  upgrade: string | null;
  install: () => void;
  submit: () => void;
}) {
  return (
    <main className="login-page">
      <div className="window-drag" />
      <div className="login-content">
        <div className="brand">
          <SquareTerminal />
          <span>CC Desk Tunnel</span>
        </div>
        <div className="login-title">
          <h1>连接代理服务</h1>
          <span className="badge simulation">
            {form.mode === 'remote' ? '原生 SSH' : '离线模拟'}
          </span>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="connection-form"
        >
          {window.desktop && (
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
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          {upgrade && (
            <button
              className="button login-submit"
              type="button"
              disabled={connecting}
              onClick={install}
            >
              <Download />
              升级客户端到 {upgrade}
            </button>
          )}
          <button className="button primary login-submit" disabled={connecting}>
            <Unplug />
            {connecting ? '连接中…' : '连接'}
          </button>
        </form>
        {project.url && (
          <button className="project-link" type="button" onClick={openProject}>
            <GithubMark />
            {project.name}
          </button>
        )}
      </div>
    </main>
  );
}
