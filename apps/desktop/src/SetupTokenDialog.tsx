import type { SetupTokenResult } from '@cc-desk-tunnel/protocol';
import { CopyButton } from './copy.tsx';
import { Modal } from './ui.tsx';

export function SetupTokenDialog({
  result,
  close,
}: {
  result: SetupTokenResult;
  close: () => void;
}) {
  return (
    <Modal title="Setup token 已生成" onClose={close}>
      <div className="dialog-form">
        <p>{result.saved ? '已保存到服务端并用于登录。' : '令牌已生成，但尚未保存到服务端。'}</p>
        {result.error && (
          <p className="error-text" role="alert">
            {result.error}
          </p>
        )}
        <p className="muted">此处只显示一次，请按需复制保存；关闭后客户端不保留此令牌。</p>
        <textarea
          className="setup-token-value"
          aria-label="生成的 setup token"
          value={result.token}
          readOnly
          rows={4}
          spellCheck={false}
        />
        <div className="dialog-actions">
          <CopyButton text={result.token} label="复制 token" />
          <button type="button" className="button primary" onClick={close}>
            关闭
          </button>
        </div>
      </div>
    </Modal>
  );
}
