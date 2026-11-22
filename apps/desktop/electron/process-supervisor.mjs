import { spawn } from 'node:child_process';

// Every command has its own process group. The supervisor remains alive while a group is
// being stopped, so descendants cannot survive a channel or the owning application.
export class ProcessSupervisor {
  #groups = new Set();
  #closed = false;
  #closePromise;

  constructor({ graceMs = 1000 } = {}) {
    this.graceMs = graceMs;
  }

  spawn(file, args, options = {}) {
    if (this.#closed) throw new Error('Executor closed');
    const child = spawn(file, args, { ...options, detached: true });
    const group = { child, stopPromise: undefined };
    this.#groups.add(group);
    const stop = () => {
      if (group.stopPromise) return group.stopPromise;
      group.stopPromise = new Promise((resolve) => {
        const finish = () => {
          this.#groups.delete(group);
          resolve();
        };
        if (!child.pid || !this.#signal(child.pid, 'SIGTERM')) return finish();
        // A bounded TERM grace period is shared by normal completion, channel closure,
        // connection loss and shutdown. KILL applies to the group, including descendants.
        const timer = setTimeout(() => {
          this.#signal(child.pid, 'SIGKILL');
          // Reap the direct child before the supervisor itself exits. Otherwise a
          // successful group kill can leave a zombie attributed to a dead owner.
          if (child.exitCode !== null || child.signalCode !== null) finish();
          else child.once('exit', finish);
        }, this.graceMs);
        child.once('close', () => {
          if (!this.#signal(child.pid, 0)) {
            clearTimeout(timer);
            finish();
          }
        });
      });
      return group.stopPromise;
    };
    // An exited shell may leave background children behind, including children keeping
    // its output descriptors open. Reclaim the group at exit, before waiting for close.
    child.once('exit', stop);
    child.once('error', stop);
    child.stopGroup = stop;
    return child;
  }

  #signal(pid, signal) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      // Signal 0 only probes existence. EPERM also establishes that the group
      // exists; keep the owned group through its bounded termination/reap path.
      if (signal === 0 && error.code === 'EPERM') return true;
      // ESRCH: the group is gone. EPERM for TERM or KILL: what is left of it runs as another user, such as a
      // command started with sudo, which this process may not stop. Either way there is nothing more to do here;
      // throwing would end this process, and every connection's commands with it.
      return false;
    }
  }

  close() {
    this.#closed = true;
    this.#closePromise ??= Promise.all([...this.#groups].map(({ child }) => child.stopGroup()));
    return this.#closePromise;
  }
}
