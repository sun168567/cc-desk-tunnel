import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AtSign, Folder, Image, Plus, Terminal } from 'lucide-react';
import { Claude } from '@lobehub/icons';

const TITLE_MAX = 22;
const TITLE_MIN = 14;

// Shrink the greeting to the heading's width so a long name stays on one line. Below a readable
// size, the name and the sentence each stay intact and the sentence moves to the next line.
function useFittedTitle(enabled: boolean, text: string) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const heading = headingRef.current;
    const line = lineRef.current;
    if (!enabled || !heading || !line) return;

    let neededAtMax = 0;
    const measureNatural = () => {
      const previous = line.style.fontSize;
      const wrapped = line.classList.contains('is-wrapped');
      line.style.fontSize = `${TITLE_MAX}px`;
      line.classList.remove('is-wrapped');
      neededAtMax = line.scrollWidth;
      line.style.fontSize = previous;
      line.classList.toggle('is-wrapped', wrapped);
    };
    const apply = () => {
      const available = heading.clientWidth;
      if (available <= 0 || neededAtMax <= 0) return;
      let next = '';
      let wrap = false;
      if (neededAtMax > available + 1) {
        const size = ((available - 2) / neededAtMax) * TITLE_MAX;
        if (size >= TITLE_MIN) next = `${Math.round(size * 10) / 10}px`;
        else {
          next = `${TITLE_MIN}px`;
          wrap = true;
        }
      }
      if (line.style.fontSize !== next) line.style.fontSize = next;
      line.classList.toggle('is-wrapped', wrap);
    };

    measureNatural();
    apply();
    const observer = new ResizeObserver(() => apply());
    observer.observe(heading);
    const onFonts = () => {
      measureNatural();
      apply();
    };
    void document.fonts?.ready.then(onFonts);
    return () => observer.disconnect();
  }, [enabled, text]);

  return { headingRef, lineRef };
}

export default function WelcomeHero({
  sessionTitle,
  projectPath,
  connected,
  accountName,
  onNewSession,
}: {
  sessionTitle?: string;
  projectPath?: string;
  connected?: boolean;
  accountName?: string;
  onNewSession?: () => void;
}) {
  const [osUser, setOsUser] = useState('');
  useEffect(() => {
    void window.desktop?.username?.().then((name) => {
      if (name) setOsUser(name);
      else void window.desktop?.device?.().then((dev) => setOsUser(dev.name));
    });
  }, []);

  const isDefaultTitle = !sessionTitle || sessionTitle === '新会话';
  const rawUser = accountName ? accountName.split('@')[0].trim() : '';
  const username =
    (rawUser && !['未登录', '账号', '离线模拟'].includes(rawUser) ? rawUser : '') || osUser;
  const greeting = '开始新的编码与协作会话吧！';
  const { headingRef, lineRef } = useFittedTitle(!!onNewSession, `${username}\n${greeting}`);

  return (
    <div className="welcome-hero">
      <div className="brand login-brand welcome-brand-lockup" aria-hidden="true">
        <Claude.Combine size={30} type={'color'} />
        <span className="login-brand-divider" />
        <span className="login-brand-sub">CC Desk Tunnel</span>
      </div>

      <h2 className="welcome-title" ref={onNewSession ? headingRef : undefined}>
        {onNewSession ? (
          <span className="welcome-title-line" ref={lineRef}>
            {username && <span className="welcome-user-mention">@{username}</span>}
            <span className="welcome-title-rest">{greeting}</span>
          </span>
        ) : isDefaultTitle ? (
          '今天想推进什么工作？'
        ) : (
          sessionTitle
        )}
      </h2>

      <p className="welcome-subtitle">
        {onNewSession
          ? '从左侧选择已有会话继续，或新建一个会话连接工作区与终端。'
          : '在下方直接描述任务，支持引用工作区文件、粘贴截图与执行终端命令。'}
      </p>

      {projectPath && (
        <div className="empty-project" title={projectPath}>
          <Folder />
          <span>{projectPath}</span>
        </div>
      )}

      {onNewSession ? (
        <div className="welcome-actions">
          <button
            type="button"
            className="button primary welcome-cta"
            disabled={!connected}
            onClick={onNewSession}
          >
            <Plus />
            新建会话
          </button>
        </div>
      ) : (
        <div className="welcome-hints" aria-hidden="true">
          <span className="welcome-hint-pill">
            <AtSign />
            输入 @ 引用文件
          </span>
          <span className="welcome-hint-pill">
            <Image />
            粘贴或拖拽图片与附件
          </span>
          <span className="welcome-hint-pill">
            <Terminal />
            读写代码与执行命令
          </span>
        </div>
      )}
    </div>
  );
}
