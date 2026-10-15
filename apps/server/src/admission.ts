import { DomainError } from './errors.ts';

// Claude and OpenAI share one process budget. Each may use half, and a waiter
// from one side cannot take the half that still belongs to the other.
export type Lane = 'claude' | 'openai';

type Waiter = {
  live: boolean;
  granted: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
};

export type AdmissionTicket = {
  ready: Promise<void>;
  cancel: () => void;
};

export function share(capacity: number, lane: Lane) {
  if (lane === 'claude') return Math.ceil(capacity / 2);
  return Math.floor(capacity / 2);
}

export function createAdmission(capacity: number) {
  const running: Record<Lane, number> = { claude: 0, openai: 0 };
  const queues: Record<Lane, Waiter[]> = { claude: [], openai: [] };
  // When both are waiting for the same free place, they take turns. Otherwise the
  // side that asks twice in a row would keep the places the other had been waiting for.
  let next: Lane = 'claude';
  let scheduled = false;

  function total() {
    return running.claude + running.openai;
  }
  function other(lane: Lane): Lane {
    return lane === 'claude' ? 'openai' : 'claude';
  }
  function live(lane: Lane) {
    return queues[lane].filter((waiter) => waiter.live).length;
  }
  function pump() {
    while (total() < capacity) {
      const eligible = (['claude', 'openai'] as Lane[]).filter(
        (lane) => live(lane) > 0 && running[lane] < share(capacity, lane),
      );
      if (!eligible.length) return;
      const lane =
        eligible.length === 1 ? eligible[0]! : eligible.includes(next) ? next : eligible[0]!;
      const index = queues[lane].findIndex((waiter) => waiter.live);
      const waiter = queues[lane][index];
      if (!waiter) return;
      queues[lane].splice(index, 1);
      waiter.live = false;
      waiter.granted = true;
      running[lane] += 1;
      next = other(lane);
      waiter.resolve();
    }
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      pump();
    });
  }

  return {
    running(lane: Lane) {
      return running[lane];
    },
    admit(lane: Lane): AdmissionTicket {
      const cap = share(capacity, lane);
      const name = lane === 'openai' ? 'OpenAI' : 'Claude';
      if (cap === 0)
        throw new DomainError(
          'capacity',
          '服务端的并发只够 Claude 同时运行。请增大 PROXY_MAX_RUNS 后再使用 OpenAI。',
        );
      if (live(lane) >= cap)
        throw new DomainError(
          'capacity',
          `${name} 同时最多进行 ${cap} 个运行或终端，还有 ${cap} 个在等待。请等其他任务结束后再试。`,
        );
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const ready = new Promise<void>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      const waiter: Waiter = { live: true, granted: false, resolve, reject };
      queues[lane].push(waiter);
      schedule();
      return {
        ready,
        cancel() {
          if (waiter.granted || !waiter.live) return;
          waiter.live = false;
          const index = queues[lane].indexOf(waiter);
          if (index >= 0) queues[lane].splice(index, 1);
          reject(new DomainError('capacity', '连接已断开，这一轮没有开始。'));
        },
      };
    },
    release(lane: Lane) {
      if (running[lane] > 0) running[lane] -= 1;
      schedule();
    },
  };
}
