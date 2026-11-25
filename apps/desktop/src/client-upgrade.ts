import { useEffect, useRef, useState } from 'react';

// A step of the client's upgrade, as the main process tells it (see `update:install` in electron/main.cjs): asking
// for the installer, its bytes coming in, a connection given up and tried again, the file being checked, the other
// connections' windows closing, and the installer started.
export type UpgradeStep = {
  source: 'service' | 'github';
  phase: 'connecting' | 'downloading' | 'retrying' | 'verifying' | 'closing' | 'installing';
  received?: number;
  size?: number;
  // When retrying: the connections in a row that brought nothing, of how many are tried, and why the last ended.
  attempt?: number;
  attempts?: number;
  reason?: string;
};

export const messageOf = (failure: unknown) =>
  String((failure as Error)?.message ?? failure).replace(/^.*?'[\w:]+': (Error: )?/, '');

export const megabytes = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
const share = (step: UpgradeStep) =>
  step.size ? `${Math.floor(((step.received ?? 0) / step.size) * 100)}%` : '';

// One line for where the upgrade is. `quiet` is how many seconds it has gone without news, said once it is long
// enough to look like a hang: the line then tells that it is still waiting, and for how long.
export function upgradeText(step: UpgradeStep, quiet = 0) {
  // A Latin name stands apart from the Chinese around it.
  const gap = step.source === 'service' ? '' : ' ';
  const from = step.source === 'service' ? '服务端' : 'GitHub';
  switch (step.phase) {
    case 'connecting':
      return `正在连接${gap}${from}${quiet >= 5 ? `，已等 ${quiet} 秒` : '…'}`;
    case 'downloading':
      return `正在从${gap}${from}${gap}下载 ${share(step)}${quiet >= 5 ? `，${quiet} 秒没有新数据` : ''}`;
    case 'retrying':
      return step.attempt
        ? `网络中断，正在重新连接（第 ${step.attempt}/${step.attempts} 次）`
        : '连接中断，正在续传…';
    case 'verifying':
      return '正在校验安装包…';
    case 'closing':
      return '正在关闭其他连接的窗口…';
    case 'installing':
      return '正在安装，完成后客户端会自动打开';
  }
}

export type ClientUpgrade = ReturnType<typeof useClientUpgrade>;

// The client's upgrade as a window follows it: `start` fetches the service's installer, or the given version's from
// the release page, and runs it; `cancel` stops the download. A failure goes to `failed`; a cancelled one ends quietly.
export function useClientUpgrade(failed: (message: string) => void) {
  const [step, setStep] = useState<UpgradeStep | null>(null);
  const [quiet, setQuiet] = useState(0);
  const heard = useRef(0);
  const stopped = useRef(false);
  useEffect(
    () =>
      window.desktop?.onUpdateProgress((next) => {
        heard.current = Date.now();
        setQuiet(0);
        // A step with no bytes of its own keeps how far the download got.
        setStep((last) => ({ received: last?.received, size: last?.size, ...next }));
      }),
    [],
  );
  const running = step !== null;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(
      () => setQuiet(Math.floor((Date.now() - heard.current) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [running]);
  function start(version?: string) {
    if (running || !window.desktop) return;
    stopped.current = false;
    heard.current = Date.now();
    setQuiet(0);
    setStep({ source: version ? 'github' : 'service', phase: 'connecting' });
    window.desktop.installUpdate(version).then(
      // Otherwise the client quits for the installer, and the last step stays until it has.
      (result) => {
        if (result?.cancelled) setStep(null);
      },
      (failure: unknown) => {
        setStep(null);
        if (!stopped.current) failed(messageOf(failure));
      },
    );
  }
  function cancel() {
    stopped.current = true;
    void window.desktop?.cancelUpdate();
  }
  return {
    step,
    start,
    cancel,
    text: step ? upgradeText(step, quiet) : null,
    cancellable: !!step && ['connecting', 'downloading', 'retrying'].includes(step.phase),
  };
}
