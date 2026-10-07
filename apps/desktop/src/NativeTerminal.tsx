import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { X, SquareTerminal } from 'lucide-react';
import type { ProxyClient } from './client.ts';
import { IconButton } from './ui.tsx';
import '@xterm/xterm/css/xterm.css';

export default function NativeTerminal({
  client,
  sessionId,
  onClose,
}: {
  client: ProxyClient;
  sessionId: string;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('连接中');
  const [error, setError] = useState<string | null>(null);
  const stop = useRef<() => void>(() => {});
  useEffect(() => {
    const terminal = new Terminal({
      fontFamily: "'Cascadia Mono', Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 2000,
      allowProposedApi: false,
      theme: { background: '#18191c', foreground: '#e2e5e9', cursor: '#a8d8be' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current!);
    fit.fit();
    let id: string | null = null,
      disposed = false,
      closeRequested = false,
      opening = true,
      closing = false;
    let pendingBytes = 0;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    function acknowledge() {
      clearTimeout(ackTimer);
      ackTimer = undefined;
      if (!id || !pendingBytes || disposed) return;
      client.terminalControl({
        type: 'terminal.ack',
        sessionId,
        terminalId: id,
        bytes: pendingBytes,
      });
      pendingBytes = 0;
    }
    async function close() {
      closeRequested = true;
      if (!id) {
        if (!opening && !disposed) onClose();
        return;
      }
      if (closing) return;
      closing = true;
      const terminalId = id;
      try {
        await client.request({ type: 'terminal.close', sessionId, terminalId });
        if (id === terminalId) id = null;
        if (!disposed) onClose();
      } catch (error) {
        if (!disposed) setError(error instanceof Error ? error.message : '关闭失败');
      } finally {
        closing = false;
      }
    }
    stop.current = () => {
      void close();
    };
    const unsubscribe = client.onTerminal((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.type === 'terminal.opened') {
        opening = false;
        id = message.terminalId;
        if (disposed || closeRequested) {
          void close();
          return;
        }
        setStatus('Linux · Claude Code');
        resizeFrame = requestAnimationFrame(resize);
        terminal.focus();
      } else if (message.type === 'terminal.data' && message.terminalId === id && !disposed) {
        terminal.write(message.data, () => {
          if (disposed || message.terminalId !== id) return;
          pendingBytes += message.bytes;
          if (pendingBytes >= 16 * 1024) acknowledge();
          else ackTimer ??= setTimeout(acknowledge, 20);
        });
      } else if (message.type === 'terminal.closed' && message.terminalId === id) {
        id = null;
        clearTimeout(ackTimer);
        pendingBytes = 0;
        if (!disposed) setStatus(`已结束 · ${message.exitCode ?? '未知'}`);
      }
    });
    const input = terminal.onData((data) => {
      if (!id) return;
      for (let offset = 0; offset < data.length;) {
        let end = Math.min(offset + 4096, data.length);
        const last = data.charCodeAt(end - 1);
        if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
        client.terminalControl({
          type: 'terminal.input',
          sessionId,
          terminalId: id,
          data: data.slice(offset, end),
        });
        offset = end;
      }
    });
    let size = '',
      resizeFrame = 0;
    const resize = () => {
      fit.fit();
      const cols = Math.max(20, Math.min(400, terminal.cols)),
        rows = Math.max(5, Math.min(160, terminal.rows));
      const current = `${cols}:${rows}`;
      if (!id || size === current) return;
      size = current;
      client.terminalControl({ type: 'terminal.resize', sessionId, terminalId: id, cols, rows });
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resize);
    });
    observer.observe(host.current!);
    // A deferred start avoids launching a throwaway CLI during React's development effect check.
    const openTask = Promise.resolve()
      .then(() => {
        if (disposed) return;
        return client.request({
          type: 'terminal.open',
          sessionId,
          cols: Math.max(20, Math.min(400, terminal.cols)),
          rows: Math.max(5, Math.min(160, terminal.rows)),
        });
      })
      .catch((error: Error) => {
        opening = false;
        if (!disposed) {
          setError(error.message);
          setStatus('未连接');
          if (closeRequested) onClose();
        }
      });
    return () => {
      disposed = true;
      clearTimeout(ackTimer);
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      input.dispose();
      void close();
      // A late opened frame still needs an owner to send its close request.
      void openTask.finally(unsubscribe);
      terminal.dispose();
    };
  }, [client, sessionId, onClose]);
  return (
    <section className="native-terminal" aria-label="原生 Claude Code 终端">
      <header>
        <span>
          <SquareTerminal />
          {status}
        </span>
        <IconButton title="关闭原生终端" onClick={() => stop.current()}>
          <X />
        </IconButton>
      </header>
      {error && <p role="alert">{error}</p>}
      <div className="terminal-host" ref={host} />
    </section>
  );
}
