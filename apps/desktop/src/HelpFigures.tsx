import {
  ArrowRight,
  Bot,
  Brain,
  FileText,
  FolderCode,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  FolderOpen,
  Laptop,
  Monitor,
  Plus,
  Server,
  Smartphone,
  SquareTerminal,
  X,
} from 'lucide-react';
import { useT } from './i18n.ts';
import type { Figure as Name } from './help-content.ts';
import { modes } from './PermissionMenu.tsx';
import { modeDetail, modeName } from './modes.ts';
import TaskChecklist from './TaskChecklist.tsx';

// Pictures for the help, drawn with the window's own colours and shapes so that they look like what the user will
// meet: the computers around the service, an approval card, the mode menu, a terminal. Names are the user's own
// where the window knows them.
export default function Figure({
  name,
  here,
  others,
  browser = false,
}: {
  name: Name;
  here: string;
  others: string[];
  browser?: boolean;
}) {
  const t = useT();
  const other = others[0] ?? t('help:figures.anotherComputer');
  switch (name) {
    case 'map':
      return <DeviceMap here={browser ? null : here} others={others} />;
    case 'approval':
      return (
        <Approval
          tool="Bash"
          command="npm install --save-dev vitest"
          device={here}
          note={t('help:figures.runsOn', { device: here })}
        />
      );
    case 'remote-approval':
      return (
        <Approval
          tool="Bash"
          command={`ssh device-${slug(other)}-pwsh  # Remove-Item .\\build -Recurse`}
          device={other}
          note={t('help:figures.runsOn', { device: other })}
        />
      );
    case 'modes':
      return (
        <div className="fig fig-modes" aria-hidden="true">
          <p className="fig-menu-heading">{t('session:mode.question')}</p>
          {modes.map(({ value, icon: Icon }, index) => (
            <div className={`fig-mode${index === 0 ? ' current' : ''}`} key={value}>
              <Icon />
              <span>
                <strong>
                  {modeName(t, value)}
                  {index === 0 && <em>{t('help:figures.default')}</em>}
                </strong>
                <small>{modeDetail(t, value)}</small>
              </span>
              {index === 0 && <Check className="fig-mode-check" />}
            </div>
          ))}
        </div>
      );
    case 'terminal':
      return (
        <div className="fig fig-terminal" aria-hidden="true">
          <div className="fig-terminal-bar">
            <i />
            <i />
            <i />
            <span>{t('help:figures.terminal.title')}</span>
          </div>
          <pre>
            <span className="t-dim">PS D:\work\web-app&gt; </span>
            <span className="t-cmd">ccdt</span>
            {'\n'}
            <span className="t-dim">{t('help:figures.terminal.session')}</span>
            {'\n\n'}
            <span className="t-accent">✻</span> Claude Code
            {'\n'}
            <span className="t-dim">────────────────────────────────</span>
            {'\n'}
            <span className="t-you">{t('help:figures.terminal.you')}</span>
            {'\n'}
            <span className="t-accent">●</span> {t('help:figures.terminal.claude')}
          </pre>
        </div>
      );
    case 'agents':
      return (
        <div className="fig fig-agents" aria-hidden="true">
          <p className="fig-flow-label">{t('help:figures.agents.inbound')}</p>
          <div className="fig-flow">
            <div className="fig-box">
              <Code2 />
              <strong>{t('help:figures.agents.callers')}</strong>
              <small>{t('help:figures.agents.callersExamples')}</small>
            </div>
            <div className="fig-arrow">
              <code>ccdt -p</code>
              <code>ccdt acp</code>
              <ArrowRight />
            </div>
            <div className="fig-box accent">
              <Server />
              <strong>{t('help:figures.agents.server')}</strong>
              <small>{t('help:figures.agents.serverNote')}</small>
            </div>
          </div>
          <p className="fig-flow-label">{t('help:figures.agents.outbound')}</p>
          <div className="fig-flow">
            <div className="fig-box accent">
              <Server />
              <strong>Claude</strong>
              <small>{t('help:figures.agents.inSession')}</small>
            </div>
            <div className="fig-arrow">
              <code>codex exec</code>
              <ArrowRight />
            </div>
            <div className="fig-box">
              <Bot />
              <strong>{t('help:figures.agents.local')}</strong>
              <small>{t('help:figures.agents.localNote')}</small>
            </div>
          </div>
        </div>
      );
    case 'cache':
      return (
        <div className="fig fig-cache" aria-hidden="true">
          <div className="fig-cache-track">
            <span className="warm" />
            <span className="cold" />
            <i className="fig-cache-mark start" style={{ left: '0%' }} />
            <i className="fig-cache-mark compact" style={{ left: '60%' }} />
            <i className="fig-cache-mark expire" style={{ left: '72%' }} />
          </div>
          <div className="fig-cache-labels">
            <span style={{ left: '0%' }}>{t('help:figures.cache.last')}</span>
            <span className="compact" style={{ left: '60%' }}>
              {t('help:figures.cache.compact')}
            </span>
            <span className="expire" style={{ left: '72%' }}>
              {t('help:figures.cache.expire')}
            </span>
          </div>
          <p className="fig-cache-note">{t('help:figures.cache.note')}</p>
        </div>
      );
    case 'quota':
      return (
        <div className="fig fig-quota" aria-hidden="true">
          <p className="fig-quota-title">{t('help:figures.quota.title')}</p>
          <div className="fig-quota-row">
            <span>
              <Monitor /> {t('help:figures.quota.desktop')}
            </span>
            <div className="fig-quota-bar">
              <i style={{ width: '84%' }} />
            </div>
            <b>{t('help:figures.quota.double')}</b>
          </div>
          <div className="fig-quota-row">
            <span>
              <SquareTerminal /> ccdt
            </span>
            <div className="fig-quota-bar">
              <i className="lean" style={{ width: '42%' }} />
            </div>
            <b>1×</b>
          </div>
          <p className="fig-quota-note">{t('help:figures.quota.note')}</p>
        </div>
      );
    case 'devices':
      return (
        <div className="fig fig-sidebar" aria-hidden="true">
          <div className="fig-side-row heading">
            <Laptop />
            <strong>{t('help:figures.devices.heading')}</strong>
            <ChevronDown className="end" />
          </div>
          <div className="fig-side-row device">
            <ChevronDown />
            <span>{other}</span>
            <em className="online">{t('nav:online')}</em>
          </div>
          <div className="fig-side-row project hover">
            <FolderOpen />
            <span>{t('help:figures.devices.folder')}</span>
            <Plus className="end fig-pulse" />
          </div>
          <div className="fig-side-row session">{t('help:figures.devices.session')}</div>
          {others.slice(1, 3).map((name) => (
            <div className="fig-side-row device" key={name}>
              <ChevronRight />
              <span>{name}</span>
              <em className="online">{t('nav:online')}</em>
            </div>
          ))}
          {others.length > 3 && (
            <div className="fig-side-row device">
              <span className="fig-more">
                {t('help:figures.devices.more', { count: others.length - 3 })}
              </span>
            </div>
          )}
          <p className="fig-side-tip">{t('help:figures.devices.tip')}</p>
        </div>
      );
    case 'sync':
      return (
        <div className="fig fig-sync" aria-hidden="true">
          <div className="fig-sync-side">
            <p>
              <Laptop /> {t('help:figures.sync.computer')}
            </p>
            <SyncedFiles />
          </div>
          <div className="fig-sync-arrow">
            <ArrowRight />
            <span>{t('help:figures.sync.copy')}</span>
          </div>
          <div className="fig-sync-side server">
            <p>
              <Server /> {t('help:figures.sync.server')}
            </p>
            <SyncedFiles />
            <small>{t('help:figures.sync.reads')}</small>
          </div>
        </div>
      );
    case 'export':
      return (
        <div className="fig fig-export" aria-hidden="true">
          <p className="fig-dialog-title">{t('session:exportDialog.title')}</p>
          <p className="fig-label">{t('session:exportDialog.content')}</p>
          {(['answers', 'said', 'all'] as const).map((key, index) => (
            <div className={`fig-mode${index === 0 ? ' current' : ''}`} key={key}>
              <span>
                <strong>{t(`session:exportDialog.${key}.label`)}</strong>
                <small>{t(`session:exportDialog.${key}.detail`)}</small>
              </span>
              {index === 0 && <Check className="fig-mode-check" />}
            </div>
          ))}
          <p className="fig-label">{t('session:exportDialog.range')}</p>
          <div className="fig-range">
            <span>{t('session:exportDialog.every')}</span>
            <span className="current">
              {t('session:exportDialog.recent')} 5 {t('session:exportDialog.turnsUnit')}
            </span>
          </div>
        </div>
      );
    case 'folders':
      return (
        <div className="fig fig-folders" aria-hidden="true">
          <div className="fig-crumb">
            <span>/data/state/native/3f2a…</span>
            <i className="fig-pulse">
              <FolderCode />
            </i>
            <i className="fig-pulse">
              <Brain />
            </i>
          </div>
          <div className="fig-folders-legend">
            <span>
              <FolderCode /> {t('help:figures.folders.work')}
            </span>
            <span>
              <Brain /> {t('help:figures.folders.records')}
            </span>
          </div>
        </div>
      );
    case 'tasks':
      return (
        <div className="fig fig-tasks" aria-hidden="true" inert>
          <TaskChecklist
            working
            tasks={[
              { id: '1', content: t('help:figures.tasks.read'), status: 'completed' },
              {
                id: '2',
                content: t('help:figures.tasks.change'),
                activeForm: t('help:figures.tasks.changing'),
                status: 'in_progress',
              },
              { id: '3', content: t('help:figures.tasks.check'), status: 'pending' },
            ]}
          />
          <div className="fig-message-box">{t('session:composer.placeholder')}</div>
        </div>
      );
  }
}

// What the sync carries, as the project and the server both hold it.
function SyncedFiles() {
  return (
    <ul className="fig-files">
      {['CLAUDE.md', '.claude/skills/', '.claude/rules/'].map((name) => (
        <li key={name}>
          {name.endsWith('/') ? <FolderOpen /> : <FileText />}
          <code>{name}</code>
        </li>
      ))}
    </ul>
  );
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'office-pc';

function Approval({
  tool,
  command,
  device,
  note,
}: {
  tool: string;
  command: string;
  device: string;
  note: string;
}) {
  const t = useT();
  return (
    <div className="fig fig-approval" aria-hidden="true">
      <div className="fig-approval-title">
        <SquareTerminal />
        {t('session:toolState.approval')} <code>{tool}</code>
        <span className="fig-device">
          <Laptop />
          {device}
        </span>
      </div>
      <div className="fig-approval-card">
        <div className="fig-approval-copy">
          <Copy />
          {t('session:tool.copyInput')}
        </div>
        <code className="fig-approval-command">{command}</code>
        <div className="fig-approval-foot">
          <small>{note}</small>
          <span className="fig-pill">
            <X />
            {t('session:approval.deny')}
          </span>
          <span className="fig-pill solid">
            <Check />
            {t('session:approval.allow')}
          </span>
        </div>
      </div>
    </div>
  );
}

function DeviceMap({ here, others }: { here: string | null; others: string[] }) {
  const t = useT();
  const shown = others.slice(0, here ? 2 : 3);
  const more = others.length - shown.length;
  return (
    <div className="fig fig-map" aria-hidden="true">
      <div className="fig-map-server">
        <Server />
        <strong>{t('help:figures.map.server')}</strong>
        <small>{t('help:figures.map.serverNote')}</small>
      </div>
      <div className="fig-map-wire">
        <span>{t('help:figures.map.channel')}</span>
      </div>
      <div className="fig-map-devices">
        {here && (
          <div className="fig-map-device here">
            <Monitor />
            <span>
              <strong>{here}</strong>
              <small>{t('help:figures.map.hereNote')}</small>
            </span>
          </div>
        )}
        {shown.map((name) => (
          <div className="fig-map-device" key={name}>
            <Laptop />
            <span>
              <strong>{name}</strong>
              <small>{t('nav:online')}</small>
            </span>
          </div>
        ))}
        {more > 0 && (
          <div className="fig-map-device more">
            <Laptop />
            <span>
              <strong>{t('help:figures.map.more', { count: more })}</strong>
            </span>
          </div>
        )}
        {shown.length === 0 && (
          <div className="fig-map-device ghost">
            <Laptop />
            <span>
              <strong>{t('help:figures.anotherComputer')}</strong>
              <small>{t('help:figures.map.otherNote')}</small>
            </span>
          </div>
        )}
        <div className={`fig-map-device${here ? '' : ' here'}`}>
          <Smartphone />
          <span>
            <strong>
              {here ? t('help:figures.map.phone') : t('help:figures.map.thisBrowser')}
            </strong>
            <small>{t('help:figures.map.phoneNote')}</small>
          </span>
        </div>
      </div>
    </div>
  );
}
