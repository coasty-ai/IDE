// The page's connection to Workbench, as one of a few plain states, and errors in plain words.
// Pure: no DOM, no imports (node:test loads it).
//
//   no-key        no key in this tab: open the link printed in the terminal
//   connecting    a key, but no snapshot yet
//   live          the stream is open and data has arrived
//   reconnecting  the stream dropped and the browser is retrying (Workbench stopped, or the network blinked)
//   down          reconnecting for longer than DOWN_MS: say so in the core
//   stale         Workbench refused this page's key (401): it has restarted and made a new key

export const DOWN_MS = 10_000;

/**
 * @param {{ hasKey: boolean, loaded: boolean, stream: 'connecting'|'open'|'closed'|null, refused?: boolean, downMs?: number }} s
 *   stream: the EventSource's state; refused: a request or the probe after a closed stream got 401;
 *   downMs: how long the stream has been failing.
 */
export function linkState({ hasKey, loaded, stream, refused = false, downMs = 0 }) {
  if (!hasKey) return 'no-key';
  if (refused) return 'stale';
  if (stream === 'open') return loaded ? 'live' : 'connecting';
  if (!loaded && stream !== 'closed' && downMs < DOWN_MS) return 'connecting';
  return downMs >= DOWN_MS ? 'down' : 'reconnecting';
}

/** True in the states where nothing can be sent, so the page hides the input and ignores typing and space. */
export const cannotSend = state => state === 'no-key' || state === 'stale';

/**
 * A request's failure in plain words. Never says "token" or "fetch".
 * @param {number|null} status  the HTTP status, or null when no answer came at all
 * @param {string} [said]       what Workbench itself said, if anything
 */
export function plainError(status, said) {
  if (status === 401) return 'This page’s key no longer works. Open the link Workbench printed in the terminal.';
  if (status == null || status === 0) return 'Workbench isn’t answering. Is it still running?';
  const s = typeof said === 'string' ? said.trim() : '';
  if (s && !/token|fetch/i.test(s)) return s;
  return status >= 500 ? 'Something went wrong in Workbench. Try again.' : `Workbench said no (${status}).`;
}
