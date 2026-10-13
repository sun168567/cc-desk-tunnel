import { useEffect, useState } from 'react';
import type { TaskProgress } from './client.ts';

// The service's clock as this window knows it, and when something last came from a session's run.
export type Clock = { now: () => number; activityAt: (sessionId: string) => number };

// Draws its component again as time passes, and only while there is something to count: nothing above it
// is drawn again for the passing of a second.
function useTick(active: boolean, every = 1000) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick((count) => count + 1), every);
    return () => clearInterval(timer);
  }, [active, every]);
}
export function span(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole} 秒`;
  if (whole < 3600) return `${Math.floor(whole / 60)} 分 ${whole % 60} 秒`;
  return `${Math.floor(whole / 3600)} 小时 ${Math.floor((whole % 3600) / 60)} 分`;
}

// Whether a run is alive. A tool that takes long tells its time in its own row above, and counts as word of
// the run; a run with no tool at work from which nothing has come for a minute says so, in words that do not
// call it stuck. The dot breathes while there is word of the run and rests when there is none.
// (The idea of telling a live run from a silent one: #47, kilisamemarisaaa.)
export function RunStatus({
  tool,
  since,
  clock,
  connected,
  suffix,
}: {
  // A tool is at work now.
  tool: boolean;
  since: number;
  clock: Clock;
  connected: boolean;
  suffix: string;
}) {
  useTick(!tool, 5000);
  const quiet = (clock.now() - since) / 1000;
  const silent = !tool && quiet >= 60;
  return (
    <div className="run-indicator" role="status">
      <span className={`running-dot${connected && !silent ? ' breathing' : ''}`} />
      {silent ? `仍在运行 · 已 ${Math.floor(quiet / 60)} 分钟没有新输出` : '运行中'}
      {suffix}
    </div>
  );
}

// Under a background task: how long it has been waited for, and what it last said of itself when it says
// anything. A shell command says nothing; a subagent tells its tools. None of it is kept once the task ends.
// (The idea of showing that a background task is alive: #45, kilisamemarisaaa.)
export function TaskLine({
  since,
  progress,
  clock,
  connected,
}: {
  since: number;
  progress: TaskProgress | undefined;
  clock: Clock;
  connected: boolean;
}) {
  useTick(connected);
  const said =
    progress?.summary ??
    (progress?.tool
      ? `${progress.toolUses ? `第 ${progress.toolUses} 次工具调用 · ` : ''}${progress.tool}`
      : '');
  return (
    <small>
      已等待 {span((clock.now() - since) / 1000)}
      {said && ` · ${said}`}
    </small>
  );
}
