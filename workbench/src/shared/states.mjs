// Agent states, shared by the engine and the browser UI.
// Plain ES module with no Node imports, so the UI can load it directly.

/** Every state an agent or helper can be in. */
export const STATE = Object.freeze({
  STARTING: 'starting',          // process launched, nothing heard yet
  WORKING: 'working',            // tool calls or model output are flowing
  WAITING_HELPERS: 'waiting_helpers', // root turn ended, but its helpers or background commands still run
  NEEDS_OK: 'needs_ok',          // a risky action is held until the person allows or denies it
  QUESTION: 'question',          // the agent ended its turn with a question for the person
  MAYBE_STUCK: 'maybe_stuck',    // same tool call or error repeated, or silent for too long
  DONE_CHECKED: 'done_checked',  // finished, and the workbench ran the declared checks: all passed
  DONE_CLAIMED: 'done_claimed',  // finished by its own account; nothing was set up to check it
  CHECKS_FAILED: 'checks_failed',// finished, and a declared check failed
  FINISHED: 'finished',          // a helper (sub-agent) completed its part
  FAILED: 'failed',              // the process exited with an error
  STOPPED: 'stopped',            // a person stopped it
});

/** States in which the person is the one being waited on. */
export const NEEDS_YOU = new Set([STATE.NEEDS_OK, STATE.QUESTION, STATE.MAYBE_STUCK, STATE.CHECKS_FAILED]);

/** States that count as finished for a root agent (ready for review). */
export const DONE = new Set([STATE.DONE_CHECKED, STATE.DONE_CLAIMED, STATE.CHECKS_FAILED]);

/** States where the agent is still active. */
export const ACTIVE = new Set([STATE.STARTING, STATE.WORKING, STATE.WAITING_HELPERS, STATE.NEEDS_OK, STATE.QUESTION, STATE.MAYBE_STUCK]);

/** States after which nothing more will happen without a new instruction. */
export const ENDED = new Set([STATE.DONE_CHECKED, STATE.DONE_CLAIMED, STATE.CHECKS_FAILED, STATE.FINISHED, STATE.FAILED, STATE.STOPPED]);

/**
 * How each state is shown. `shape` names an SVG symbol in the UI; `tone` names a colour.
 * Shapes are distinct so the state reads without colour.
 */
export const LOOK = Object.freeze({
  starting:        { label: 'starting',              shape: 'work',  tone: 'work', live: true },
  working:         { label: 'working',               shape: 'work',  tone: 'work', live: true },
  waiting_helpers: { label: 'waiting on background work', shape: 'work', tone: 'work', live: true },
  needs_ok:        { label: 'needs your OK',          shape: 'need',  tone: 'need' },
  question:        { label: 'has a question',         shape: 'need',  tone: 'need' },
  maybe_stuck:     { label: 'might be stuck',         shape: 'stuck', tone: 'stuck' },
  done_checked:    { label: 'done and checked',       shape: 'ok',    tone: 'ok' },
  done_claimed:    { label: 'says it is done',        shape: 'word',  tone: 'word' },
  checks_failed:   { label: 'done, but a check failed', shape: 'fail', tone: 'stuck' },
  finished:        { label: 'finished its part',      shape: 'word',  tone: 'word' },
  failed:          { label: 'failed',                 shape: 'fail',  tone: 'stuck' },
  stopped:         { label: 'stopped',                shape: 'off',   tone: 'word' },
});

/** Sort order for the tree and the focus queue: what needs the person comes first. */
export const PRIORITY = Object.freeze({
  needs_ok: 0, question: 1, maybe_stuck: 2, checks_failed: 3,
  done_checked: 4, done_claimed: 5,
  working: 6, waiting_helpers: 6, starting: 7,
  finished: 8, failed: 9, stopped: 10,
});

export function lookOf(state) {
  return LOOK[state] || LOOK.working;
}
