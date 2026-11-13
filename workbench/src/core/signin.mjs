// Signing in to a coding agent in the browser. The vendor's own login program (`claude auth login --claudeai`,
// `claude auth login --console`, `codex login`) runs in the background: an argument array, the environment an agent of
// that kind gets, standard input closed (/dev/null), and no terminal (a session of its own, with no controlling
// terminal). It opens the person's browser on Anthropic's or OpenAI's own sign-in page, receives the result on its own
// localhost callback, and keeps it itself: Workbench never sees a credential, and never types or relays a code.
//
// While the program runs, the agent is asked whether it is signed in (`check`, every 2 seconds). The sign-in is done
// when the program exits 0 (and the agent does not say it is signed out), or when the check says signed in. It did not
// finish when the program exits otherwise, cannot start, asks for something to be typed (Claude Code's
// "Paste code here >" when its localhost callback cannot be reached), or 10 minutes pass: the program is then stopped,
// and the person signs in in Terminal instead (src/core/connect.mjs). See ARCHITECTURE.md, "Sign-in in the browser".
import { spawn as spawnChild } from 'node:child_process';
import { EventEmitter } from 'node:events';

/** How long a sign-in may wait for the person before it counts as not finished. */
export const SIGNIN_TIMEOUT_MS = 10 * 60_000;
/** How often the agent is asked whether it is signed in while its login program runs. */
export const SIGNIN_CHECK_MS = 2000;
/** How long a login program that is stopped has after SIGTERM, before SIGKILL. */
const STOP_GRACE_MS = 2000;
/** Once the check says signed in, the program may finish by itself for this many checks' time; then it is stopped. */
const FINISH_CHECKS = 15;
/** How much of a login program's output is kept, to read: its last 16 KB. */
const OUTPUT_KEEP = 16 * 1024;

/**
 * What a login program prints when it waits for something to be typed. Workbench's sign-in has no terminal and never
 * types or relays a code, so such a sign-in cannot finish here. Claude Code's ordinary wait ends in "Paste code here if
 * prompted > ": that one is not in this list, since Claude Code prints it every time, while it waits for the browser.
 */
export const WAITS_FOR_INPUT = Object.freeze([
  /\bpaste code here\s*>/i, // Claude Code, when its localhost callback cannot be reached
  /\bpaste the code shown\b/i, // the line Claude Code prints before that prompt
  /\bpress (?:enter|return|any key)\b/i,
  /\((?:y\/n|yes\/no)\)|\[(?:y\/n|yes\/no)\]/i,
  /\benter (?:the |your |this )?(?:one-time )?code\b/i,
]);

/** Terminal escape sequences (colours, cursor moves, links), which are not words. */
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Whether a login program's output so far asks for something to be typed. */
export function waitsForInput(output) {
  const text = String(output ?? '').replace(ESCAPES, '');
  return WAITS_FOR_INPUT.some((re) => re.test(text));
}

/** The last line a program printed, for the log: one line, with addresses' queries (an OAuth state) left out. */
function lastWords(output) {
  const lines = String(output ?? '').replace(ESCAPES, '').split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  return last.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/gi, '$1?…').slice(0, 300);
}

/** "10 minutes", "1 minute", "45 seconds". */
function duration(ms) {
  const [n, unit] = ms >= 60_000 ? [Math.round(ms / 60_000), 'minute'] : [Math.max(1, Math.round(ms / 1000)), 'second'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** Login programs still running: stopped when Workbench exits, so none is left waiting for a browser. */
const live = new Set();
let watching = false;

function keepTrack(child) {
  live.add(child);
  if (watching) return;
  watching = true;
  process.on('exit', () => {
    for (const c of live) {
      try { c.kill('SIGKILL'); } catch { /* gone */ }
    }
  });
}

/** What the rest of Workbench may know about one sign-in. */
function publicState(run) {
  return { id: run.id, phase: run.phase, mode: run.mode, since: run.since, endedAt: run.endedAt, why: run.why };
}

/**
 * The sign-ins in the browser, at most one per agent. Emits 'change' (id, state) when one starts and when it ends.
 *
 * A state is `{ id, phase, mode, since, endedAt, why }`: phase 'waiting' while the program runs (also while a sign-in
 * that worked is being confirmed), then 'done', 'failed' or 'cancelled'; `why` is null, or for 'failed' one of 'exit'
 * (the program exited with an error, or exited 0 while the agent still says it is signed out), 'input' (it asked for
 * something to be typed), 'timeout' and 'start' (it could not be started), and 'cancel' for 'cancelled'. `mode` is what
 * the caller gave (Connect: 'browser' or 'console'). Each sign-in ends once: a program that exits after it was stopped,
 * or a check that answers late, changes nothing.
 *
 * The login program only waits for the browser, so stopping it loses nothing: SIGTERM, then SIGKILL after 2 seconds.
 * Only the program itself is stopped, never its process group: on Linux the browser it opened may be in that group.
 */
export class SignIns extends EventEmitter {
  /**
   * @param {object} [o]
   * @param {Function} [o.spawn]        child_process.spawn, or a stand-in
   * @param {number} [o.timeoutMs]      10 minutes
   * @param {number} [o.checkEveryMs]   2 seconds
   * @param {number} [o.stopGraceMs]    2 seconds between SIGTERM and SIGKILL
   * @param {Function} [o.now]          Date.now
   * @param {Function} [o.log]          (level, line)
   */
  constructor({ spawn = spawnChild, timeoutMs = SIGNIN_TIMEOUT_MS, checkEveryMs = SIGNIN_CHECK_MS, stopGraceMs = STOP_GRACE_MS, now = Date.now, log = null } = {}) {
    super();
    this._spawn = spawn;
    this.timeoutMs = timeoutMs;
    this.checkEveryMs = checkEveryMs;
    this.stopGraceMs = stopGraceMs;
    this._now = now;
    this._log = typeof log === 'function' ? log : () => {};
    this._runs = new Map();
  }

  /** The sign-in for this id as it is now (the last one, when none is waiting), or null. */
  state(id) {
    const run = this._runs.get(id);
    return run ? publicState(run) : null;
  }

  /**
   * Start the login program for `id`, unless a sign-in for it is waiting already: that one is answered instead.
   * @param {string} id
   * @param {object} o
   * @param {string} o.file              the program (an absolute path)
   * @param {string[]} [o.args]
   * @param {object} o.env               its whole environment
   * @param {string} o.cwd
   * @param {string} [o.mode]            kept in the state
   * @param {string} [o.label]           the agent's name, for the log
   * @param {Function} [o.check]         () => Promise<'yes'|'no'|'unknown'>: is the agent signed in now?
   * @param {boolean} [o.signedInBefore] the agent was signed in already (another account): only an exit 0 counts
   * @param {Function} [o.whenSignedIn]  () => Promise: runs once the sign-in worked, before it counts as done
   * @returns {{ started: boolean, state: object }}
   */
  start(id, { file, args = [], env, cwd, mode = null, label = id, check = null, signedInBefore = false, whenSignedIn = null } = {}) {
    const current = this._runs.get(id);
    if (current && current.phase === 'waiting') return { started: false, state: publicState(current) };
    const run = {
      id, label, mode, since: this._now(), endedAt: null, phase: 'waiting', why: null,
      child: null, exited: false, settling: false, output: '', timers: new Set(),
      check: typeof check === 'function' ? check : null, signedInBefore: signedInBefore === true,
      whenSignedIn: typeof whenSignedIn === 'function' ? whenSignedIn : null,
    };
    this._runs.set(id, run);
    let child;
    try {
      child = this._spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true });
    } catch (error) {
      run.exited = true;
      this._end(run, 'failed', 'start', { error });
      return { started: true, state: publicState(run) };
    }
    run.child = child;
    keepTrack(child);
    // Nothing here keeps Workbench running: when it exits, the 'exit' hook above stops the program.
    child.unref?.();
    const read = (chunk) => {
      run.output = (run.output + chunk).slice(-OUTPUT_KEEP);
      if (run.phase === 'waiting' && !run.settling && waitsForInput(run.output)) this._stop(run, 'failed', 'input');
    };
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      stream.setEncoding?.('utf8');
      stream.on('data', read);
      stream.on('error', () => {});
      stream.unref?.();
    }
    child.on('error', (error) => {
      if (child.pid) return; // it runs: a signal that could not be sent; its exit still comes
      run.exited = true;
      live.delete(child);
      this._end(run, 'failed', 'start', { error });
    });
    // 'exit', not 'close': a browser the program opened may hold its output open long after it ended.
    child.on('exit', (code, signal) => {
      run.exited = true;
      live.delete(child);
      if (run.phase !== 'waiting' || run.settling) return;
      if (code === 0) this._succeed(run, { ask: true }).catch(() => {});
      else this._end(run, 'failed', 'exit', { code, signal });
    });
    this._timer(run, () => this._stop(run, 'failed', 'timeout'), this.timeoutMs);
    this._checkLater(run);
    this.emit('change', id, publicState(run));
    return { started: true, state: publicState(run) };
  }

  /** Stop the sign-in waiting for `id`. Returns whether one was waiting. */
  cancel(id) {
    const run = this._runs.get(id);
    if (!run || run.phase !== 'waiting') return false;
    return this._stop(run, 'cancelled', 'cancel');
  }

  /** Stop every sign-in that waits. */
  stopAll() {
    for (const id of [...this._runs.keys()]) this.cancel(id);
  }

  _timer(run, fn, ms) {
    const t = setTimeout(() => {
      run.timers.delete(t);
      Promise.resolve().then(fn).catch((e) => this._log('warn', `the sign-in in the browser for ${run.label} hit an error: ${e && e.message}`));
    }, ms);
    t.unref?.();
    run.timers.add(t);
    return t;
  }

  /** The next check, 2 seconds after the last one ended. Never when the agent was signed in before. */
  _checkLater(run) {
    if (!run.check || run.signedInBefore || run.phase !== 'waiting' || run.settling) return;
    this._timer(run, async () => {
      if (run.phase !== 'waiting' || run.settling) return;
      const said = await this._ask(run);
      if (run.phase !== 'waiting' || run.settling) return;
      if (said === 'yes') {
        await this._succeed(run, { ask: false });
        return;
      }
      this._checkLater(run);
    }, this.checkEveryMs);
  }

  async _ask(run) {
    try {
      const said = await run.check();
      return said === 'yes' || said === 'no' ? said : 'unknown';
    } catch (e) {
      this._log('warn', `${run.label} could not be asked whether it is signed in: ${e && e.message}`);
      return 'unknown';
    }
  }

  /**
   * The sign-in worked: the program exited 0 (`ask`: unless the agent then says it is signed out), or the check said
   * signed in. It stays 'waiting' until `whenSignedIn` (Connect's probe) has ended, so the panel never shows the agent
   * signed out in between; then it is done. A program still running is left to finish, and stopped after a while.
   */
  async _succeed(run, { ask }) {
    if (run.phase !== 'waiting' || run.settling) return;
    run.settling = true;
    if (ask && run.check && !run.signedInBefore) {
      const said = await this._ask(run);
      if (run.phase !== 'waiting') return;
      if (said === 'no') {
        this._end(run, 'failed', 'exit', { code: 0 });
        return;
      }
    }
    if (run.whenSignedIn) {
      try {
        await run.whenSignedIn();
      } catch (e) {
        this._log('warn', `after ${run.label} signed in, it could not be checked again: ${e && e.message}`);
      }
    }
    if (!this._end(run, 'done', null)) return;
    if (!run.exited) {
      const t = setTimeout(() => this._kill(run), this.checkEveryMs * FINISH_CHECKS);
      t.unref?.();
    }
  }

  /** End a sign-in that waits, and stop its program: a cancel, a prompt for input, the time limit. */
  _stop(run, phase, why) {
    if (run.phase !== 'waiting' || (run.settling && why !== 'cancel')) return false;
    this._end(run, phase, why);
    this._kill(run);
    return true;
  }

  _kill(run) {
    const child = run.child;
    if (!child || run.exited) return;
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    const t = setTimeout(() => {
      if (run.exited) return;
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }, this.stopGraceMs);
    t.unref?.();
  }

  /** The one way a sign-in ends: its phase, the log line, the 'change' event. False when it had ended already. */
  _end(run, phase, why, { code = null, signal = null, error = null } = {}) {
    if (run.phase !== 'waiting') return false;
    run.phase = phase;
    run.why = why;
    run.endedAt = this._now();
    for (const t of run.timers) clearTimeout(t);
    run.timers.clear();
    const what = `the sign-in in the browser for ${run.label}`;
    if (phase === 'done') this._log('info', `${run.label} signed in, in the browser.`);
    else if (phase === 'cancelled') this._log('info', `${what} was stopped.`);
    else {
      const reason = {
        exit: code === 0 ? 'its program ended, but the agent still says it is not signed in'
          : code != null ? `its program exited with code ${code}` : `its program was ended${signal ? ` by ${signal}` : ''}`,
        input: 'its program asked for something to be typed',
        timeout: `nobody finished it within ${duration(this.timeoutMs)}`,
        start: `its program could not be started${error && error.code ? ` (${error.code})` : ''}`,
      }[why] || 'it failed';
      const last = why === 'exit' || why === 'input' ? lastWords(run.output) : '';
      this._log('warn', `${what} did not finish: ${reason}.${last ? ` Its last words: ${last}` : ''}`);
    }
    this.emit('change', run.id, publicState(run));
    return true;
  }
}
