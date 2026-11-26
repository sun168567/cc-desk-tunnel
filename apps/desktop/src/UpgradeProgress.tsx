import { useT } from './i18n.ts';
import type { ClientUpgrade } from './client-upgrade.ts';
import { megabytes } from './client-upgrade.ts';

// The upgrade under way, where the buttons that start one were: the step, how much has come, and a way to stop.
export default function UpgradeProgress({ upgrade }: { upgrade: ClientUpgrade }) {
  const t = useT();
  const { step } = upgrade;
  if (!step) return null;
  const counted =
    step.size && (step.phase === 'downloading' || step.phase === 'retrying') ? step.size : null;
  return (
    <div className="upgrade-progress" role="status">
      <div className="upgrade-progress-line">
        <span>{upgrade.text}</span>
        {counted && (
          <small>
            {megabytes(step.received ?? 0)} / {megabytes(counted)}
          </small>
        )}
      </div>
      {counted ? <progress max={counted} value={step.received ?? 0} /> : <progress />}
      {upgrade.cancellable && (
        <button className="button" type="button" onClick={upgrade.cancel}>
          {t('common:cancel')}
        </button>
      )}
    </div>
  );
}
