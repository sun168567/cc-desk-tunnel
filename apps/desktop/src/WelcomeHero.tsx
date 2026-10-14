import { useEffect, useState } from 'react';
import { AtSign, Folder, Image, Plus, Terminal } from 'lucide-react';
import { Claude } from '@lobehub/icons';

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

  return (
    <div className="welcome-hero">
      <div className="brand login-brand welcome-brand-lockup" aria-hidden="true">
        <Claude.Combine size={30} type={'color'} />
        <span className="login-brand-divider" />
        <span className="login-brand-sub">CC Desk Tunnel</span>
      </div>

      <h2 className="welcome-title">
        {onNewSession ? (
          <>
            {username && <span className="welcome-user-mention">@{username}</span>}
            开始新的编码与协作会话吧！
          </>
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
