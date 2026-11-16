// How each state looks on the board: a mark, a tone and a few words. Pure: no DOM and nothing from /shared/ (LOOK comes
// from /shared/states.mjs and is passed in; queue.js is pure too). Two marks are the page's own: a speech bubble for a
// question and a half dot for "waiting on its helpers", so every state has its own mark and never relies on colour.
import { workSettled } from './queue.js';

const SHAPE = { question: 'ask', waiting_helpers: 'wait', checks_failed: 'cfail' };
const AT_REST = new Set(['done_checked', 'done_claimed', 'checks_failed', 'failed', 'stopped']);
const TONE = { failed: 'fail' };

/** { label, shape, tone } for a state. */
export function markOf(state, LOOK) {
  const l = LOOK[state] || LOOK.working;
  return { label: l.label, shape: SHAPE[state] || l.shape, tone: TONE[state] || l.tone };
}

/** markOf for one agent: a question about background work it left running is not "might be stuck". */
export function markOfAgent(a, LOOK) {
  if (a && a.state === 'maybe_stuck' && a.ask && a.ask.about === 'background') return { label: 'left a command running', shape: 'wait', tone: 'need' };
  return markOf(a ? a.state : 'working', LOOK);
}

/** A few words for under a name ("more" detail): what it is doing, or its state; for a root at rest, where its work went. */
export function statusWords(a, LOOK) {
  if (AT_REST.has(a.state) && workSettled(a)) return a.work.thrownAway ? 'thrown away' : 'merged';
  switch (a.state) {
    case 'working': case 'starting': {
      if (a.thinking && (!a.now || a.now === 'Thinking')) return 'thinking';
      const n = (a.now && a.now !== 'Starting' ? a.now : a.state).replace(/^Asking a helper to /, 'asking a helper');
      const words = n.replace(/[“”"]/g, '').split(' ').slice(0, 3).join(' ').replace(/[.,:;]+$/, '');
      return words.charAt(0).toLowerCase() + words.slice(1);
    }
    case 'waiting_helpers': return 'waiting';
    case 'maybe_stuck': return markOfAgent(a, LOOK).label;
    case 'done_claimed': return a.checks && a.checks.state === 'running' ? 'checked again' : 'says it’s done';
    case 'checks_failed': return 'a check failed';
    case 'finished': return 'finished its part';
    default: return markOf(a.state, LOOK).label;
  }
}
