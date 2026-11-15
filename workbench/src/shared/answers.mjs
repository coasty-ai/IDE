// The words that answer a finished agent's lid, "Looks good" and "Not now", also when the person types or says them.
// Shared by the engine, which takes them as the answer to finished work, and the page, which presses that lid's own
// button for them rather than send them to the engine as a command (ui/prefs.js lidAnswer). No Node imports: the page
// loads this file as it is.

/** "Looks good", and the words that mean the same for finished work: the agent stays as it is. */
export const LOOKS_GOOD_RE = /^(looks good|look good|lgtm|great|thanks|thank you|good|fine|ok|okay|all good)[.!]*$/i;

/** The lid's "Not now" on work that can be merged: the agent stays as it is, and the reply does not sound like approval. */
export const NOT_NOW_RE = /^not now[.!]*$/i;
