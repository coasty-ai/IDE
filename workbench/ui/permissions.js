// The top band's Full permissions button. Pure: no DOM, no imports (node:test loads it). app.js draws the button beside
// Agents & keys and sends its presses to the engine (POST /api/permissions). The button shows the mode: work starts at
// once, with no card to say it. The engine checks everything again when it acts.

/** 'full' or 'ask': anything else is ask. */
export const permissionMode = v => (v === 'full' ? 'full' : 'ask');

/**
 * The button for a mode: its words (`label`, and `short` where the band has no room for them), whether it is pressed
 * (aria-pressed) and lit, its title, and the mode it was drawn for (`state`: a press checks it before it sends anything).
 * Its name for screen readers is always "Full permissions"; aria-pressed says whether they are on.
 */
export function permButtonView(mode) {
  const on = permissionMode(mode) === 'full';
  return {
    state: on ? 'full' : 'ask',
    on,
    pressed: on ? 'true' : 'false',
    label: 'Full permissions',
    short: 'Full',
    name: 'Full permissions',
    title: on
      ? "Full permissions are on: agents ask only before steps that name Claude Code's own settings. Press to turn them off."
      : "Agents ask before risky steps. Press so that they ask only before steps that name Claude Code's own settings.",
  };
}
