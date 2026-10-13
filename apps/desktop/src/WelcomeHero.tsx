import { AtSign, Folder, Image, Plus, Terminal } from 'lucide-react';

export default function WelcomeHero({
  sessionTitle,
  projectPath,
  connected,
  onNewSession,
}: {
  sessionTitle?: string;
  projectPath?: string;
  connected?: boolean;
  onNewSession?: () => void;
}) {
  const isDefaultTitle = !sessionTitle || sessionTitle === '新会话';

  return (
    <div className="welcome-hero">
      <div className="welcome-brand">
        <span className="welcome-brand-prompt" aria-hidden="true">
          &gt;_
        </span>
        <span className="welcome-brand-name">CC Desk Tunnel</span>
      </div>

      <h2 className="welcome-title">
        {onNewSession
          ? '开始新的编码与协作会话'
          : isDefaultTitle
            ? '今天想推进什么工作？'
            : sessionTitle}
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
