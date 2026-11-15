// The top band's Full permissions button, and what the lid adds while full permissions are on. Pure: no DOM, no imports
// (node:test loads it). app.js draws the button beside Agents & keys and sends its presses to the engine
// (POST /api/permissions); focus.js adds the launch card's sentence. The engine checks everything again when it acts.

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
      ? 'Full permissions are on: agents run every step without asking. Press to turn them off.'
      : 'Agents ask before risky steps. Press to let them run every step without asking.',
  };
}

/** What a launch card adds while full permissions are on, for the one agent it starts or for several. */
export function launchNote(mode, agents = 1) {
  if (permissionMode(mode) !== 'full') return '';
  return `Full permissions are on, so ${Number(agents) > 1 ? 'they' : 'it'} will not ask before any step.`;
}
