// The sounds people make while they think: "um", "uh", "hmm". Shared by the parser, which reads past them to find a
// command ("um, stop everything"), and the page, which sends nothing when talking heard only these (it says "Nothing
// heard." for a moment). Typed, they are said all the same: the parser gives them to an agent like any other words. No
// Node imports: the page loads this file as it is.

/** The filler words, as the parser lexes them: lower case, with no punctuation. */
export const FILLER = new Set(['um', 'umm', 'ummm', 'uh', 'uhh', 'uhhh', 'uhm', 'er', 'erm', 'err', 'hmm', 'hm', 'hmmm', 'mm', 'mmm', 'ah', 'ahh', 'eh']);

/**
 * Whether words heard are nothing but filler, spaces and punctuation, or nothing at all ("um", "uh uh", "hmm...", ""):
 * they send nothing. Any other word or sign (an emoji too) is something said.
 */
export function onlyFiller(text) {
  const rest = String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\p{L}\p{M}\p{N}']+/gu, w => (FILLER.has(w) ? ' ' : w));
  return !/[^\s\p{P}]/u.test(rest);
}
