import { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, Eye, EyeOff } from 'lucide-react';
import type { RemoteStatus } from './desktop.d.ts';
import { remoteSettingsSession } from './remote-settings.ts';
import type { RemoteChange } from './remote-settings.ts';
import { IconButton, Modal, Switch } from './ui.tsx';

const loadSettings = remoteSettingsSession({
  read: () => window.desktop!.remoteStatus!(),
  configure: (configuration) => window.desktop!.configureRemote!(configuration),
  reset: () => window.desktop!.resetRemotePairing!(),
});
const sessionTime = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export default function RemoteControl() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [port, setPort] = useState('17890');
  const [enabled, setEnabled] = useState(false);
  const [lan, setLan] = useState(false);
  const [saving, setSaving] = useState(0);
  const [resetting, setResetting] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [pairingVisible, setPairingVisible] = useState(false);
  const queue = useRef<Awaited<ReturnType<typeof loadSettings>>['queue'] | null>(null);
  const versions = useRef({ port: 0, enabled: 0, lan: 0 });
  const requested = useRef({ enabled: false, lan: false });
  const portInput = useRef('17890');
  const committedPort = useRef(0);

  useEffect(() => {
    if (!window.desktop?.configureRemote) return;
    let active = true;
    const unsubscribe = window.desktop.onRemoteSessionsChanged?.((sessions) => {
      if (active) setStatus((current) => (current ? { ...current, sessions } : current));
    });
    void loadSettings()
      .then(({ queue: shared, status: value, error: failure }) => {
        if (!active) return;
        queue.current = shared;
        setError(failure);
        setStatus(value);
        setPort(String(value.port));
        portInput.current = String(value.port);
        setEnabled(value.enabled);
        setLan(value.lan);
        requested.current = { enabled: value.enabled, lan: value.lan };
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(
          reason instanceof Error ? reason.message : '远程控制设置读取失败，请重新打开设置。',
        );
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);
  if (!window.desktop?.configureRemote) return null;

  const settle = (value: RemoteStatus, revision: typeof versions.current) => {
    setStatus(value);
    // A slow earlier response must not undo a later click or overwrite text still being edited.
    if (versions.current.port === revision.port) {
      setPort(String(value.port));
      portInput.current = String(value.port);
    }
    if (versions.current.enabled === revision.enabled) {
      setEnabled(value.enabled);
      requested.current.enabled = value.enabled;
    }
    if (versions.current.lan === revision.lan) {
      setLan(value.lan);
      requested.current.lan = value.lan;
    }
  };
  const save = (change: RemoteChange) => {
    if (!queue.current || resetting) return;
    if (change.enabled !== undefined) {
      if (!change.enabled) setPairingVisible(false);
      versions.current.enabled++;
      requested.current.enabled = change.enabled;
      setEnabled(change.enabled);
    }
    if (change.lan !== undefined) {
      versions.current.lan++;
      requested.current.lan = change.lan;
      setLan(change.lan);
    }
    const revision = { ...versions.current };
    setSaving((count) => count + 1);
    setError('');
    void queue.current
      .save(change)
      .then(({ status: next, error: failure }) => {
        settle(next, revision);
        setError(failure);
      })
      .finally(() => setSaving((count) => count - 1));
  };
  const commitPort = () => {
    if (committedPort.current === versions.current.port) return;
    committedPort.current = versions.current.port;
    save({ port: Number(portInput.current) });
  };
  const resetPairing = async () => {
    if (!queue.current || resetting) return;
    setResetting(true);
    setError('');
    const revision = { ...versions.current };
    try {
      const result = await queue.current.reset();
      settle(result.status, revision);
      setError(result.error);
      if (!result.error) {
        setPairingVisible(false);
        setConfirmReset(false);
      }
    } finally {
      setResetting(false);
    }
  };
  const openWorkbench = async () => {
    if (!queue.current) return;
    commitPort();
    const result = await queue.current.refresh();
    if (result.error) {
      setError(result.error);
      return;
    }
    try {
      await window.desktop!.openRemote!();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '打开链接失败，请重试。');
    }
  };
  const revokeBrowser = async (id: string) => {
    if (revoking || !window.desktop?.revokeRemoteSession) return;
    setRevoking(id);
    setError('');
    try {
      const next = await window.desktop.revokeRemoteSession(id);
      setStatus((current) => (current ? { ...current, sessions: next.sessions } : next));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '浏览器授权撤销失败，请重试。');
    } finally {
      setRevoking(null);
    }
  };
  const disabled = !status || resetting;
  return (
    <>
      <h2 className="page-heading">远程控制</h2>
      <div
        className="card remote-control"
        aria-busy={saving > 0 || resetting || revoking !== null}
        onPointerDown={(event) => {
          // A blur can change the card height before pointerup and move an action away from the
          // pointer. Commit both intentions on click instead; keyboard blur still saves normally.
          const button = (event.target as Element).closest('button');
          if (
            event.button === 0 &&
            document.activeElement?.id === 'remote-port' &&
            (button?.getAttribute('role') === 'switch' ||
              button?.getAttribute('aria-label') === '打开链接')
          )
            event.preventDefault();
        }}
      >
        <div className="setting-row">
          <span>
            <strong>启用 Web 工作台</strong>
            <small>每次启动桌面程序后默认关闭；网页关闭不会中断任务。连接设置会保留。</small>
          </span>
          <Switch
            label="启用 Web 工作台"
            checked={enabled}
            disabled={disabled}
            onChange={() => {
              commitPort();
              save({ enabled: !requested.current.enabled });
            }}
          />
        </div>
        <div className="setting-row">
          <span>
            <strong>允许局域网访问</strong>
            <small>关闭时仅本机可连接；开启后浏览器仍需配对码。</small>
          </span>
          <Switch
            label="允许局域网访问"
            checked={lan}
            disabled={disabled}
            onChange={() => {
              commitPort();
              save({ lan: !requested.current.lan });
            }}
          />
        </div>
        <div className="setting-row">
          <label htmlFor="remote-port">
            监听端口
            <small id="remote-port-help">移开焦点后自动保存。端口改变后，请使用新地址访问。</small>
          </label>
          <input
            id="remote-port"
            aria-label="监听端口"
            aria-describedby="remote-port-help"
            className="setting-number"
            type="number"
            min="1024"
            max="65535"
            value={port}
            disabled={disabled}
            onChange={(event) => {
              versions.current.port++;
              portInput.current = event.target.value;
              setPort(event.target.value);
              setError('');
            }}
            onBlur={commitPort}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
        </div>
        {status?.enabled && (
          <>
            <div className="setting-row">
              <span>
                <strong>本机访问地址</strong>
                <small>
                  {status.lan
                    ? '其他设备请把 127.0.0.1 换成桌面客户端所在电脑的局域网 IP。'
                    : '在本机浏览器中访问。'}
                </small>
              </span>
              <span className="remote-address">
                <span className="remote-address-text">{status.url}</span>
                <IconButton
                  title="打开链接"
                  disabled={resetting}
                  onClick={() => void openWorkbench()}
                >
                  <ExternalLink />
                </IconButton>
              </span>
            </div>
            <div className="setting-row remote-pairing-row">
              <span>
                <strong>配对码</strong>
              </span>
              <span className="setting-actions remote-pairing">
                <span className="remote-pairing-value">
                  <code className="remote-pairing-code" aria-label="Web 配对码">
                    {pairingVisible ? status.token : '•'.repeat(status.token?.length ?? 0)}
                  </code>
                  <IconButton
                    title={pairingVisible ? '隐藏配对码' : '显示配对码'}
                    disabled={resetting}
                    onClick={() => setPairingVisible((visible) => !visible)}
                  >
                    {pairingVisible ? <EyeOff /> : <Eye />}
                  </IconButton>
                </span>
                <IconButton
                  title="复制配对码"
                  disabled={resetting}
                  onClick={() =>
                    void window
                      .desktop!.copyText(status.token!)
                      .catch((reason: Error) => setError(reason.message))
                  }
                >
                  <Copy />
                </IconButton>
                <button
                  className="button"
                  disabled={resetting || !window.desktop?.resetRemotePairing}
                  onClick={() => {
                    setError('');
                    setConfirmReset(true);
                  }}
                >
                  重置配对码
                </button>
              </span>
            </div>
          </>
        )}
        {status && (
          <>
            <div className="setting-row">
              <span>
                <strong>已配对浏览器</strong>
                <small>登录有效期为 30 天，到期后重新配对。</small>
              </span>
              {status.sessions.length === 0 && <span className="setting-value">暂无</span>}
            </div>
            {status.sessions.map((session) => (
              <div className="setting-row remote-session-row" key={session.id}>
                <span>
                  <strong>{session.label}</strong>
                  <small>
                    {sessionTime.format(session.createdAt)} 登录 ·{' '}
                    {sessionTime.format(session.expiresAt)} 到期
                  </small>
                </span>
                <button
                  className="button secondary"
                  aria-label={`撤销 ${session.label} 于 ${sessionTime.format(session.createdAt)} 登录的授权`}
                  disabled={resetting || revoking !== null}
                  onClick={() => void revokeBrowser(session.id)}
                >
                  {revoking === session.id ? '正在撤销…' : '撤销'}
                </button>
              </div>
            ))}
          </>
        )}
        {error && !confirmReset && (
          <p role="alert" className="remote-error">
            {error}
          </p>
        )}
      </div>
      {confirmReset && (
        <Modal
          title="重置配对码"
          onClose={() => {
            if (!resetting) {
              setConfirmReset(false);
              setError('');
            }
          }}
        >
          <p className="delete-question">重置后，所有已配对浏览器将立即失效。</p>
          <p className="muted">请用新的配对码重新连接。桌面客户端与正在运行的任务不受影响。</p>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="button secondary"
              disabled={resetting}
              onClick={() => setConfirmReset(false)}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={resetting}
              onClick={() => void resetPairing()}
            >
              {resetting ? '正在重置…' : '重置配对码'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
