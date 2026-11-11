// Numbers the card shows, worked out the same way everywhere. Pure: no DOM, no imports (node:test loads it).

/** Tokens the agent added: new input, what it wrote, and what it added to its memory (cache writes). Re-reads excluded. */
export function newTokens(u) {
  if (!u) return 0;
  return (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheWriteTokens || 0);
}

/** Every token the model processed, re-reads from memory included. */
export function allTokens(u) {
  if (!u) return 0;
  return newTokens(u) + (u.cacheReadTokens || 0);
}

/** Steps in the activity bars' window (the sum of the spark buckets), so the count matches the bars beside it. */
export function stepsInWindow(spark) {
  if (!Array.isArray(spark)) return 0;
  let n = 0;
  for (const v of spark) if (Number.isFinite(v) && v > 0) n += v;
  return n;
}

/** The window the bars cover, in minutes. */
export const windowMinutes = (bucketMs, buckets) => Math.round((bucketMs * buckets) / 60000);

/** Cost in words: a null cost has not been reported yet. `money` is format.mjs's money(). */
export function costWords(usd, money) {
  return usd == null || !Number.isFinite(usd) ? 'not reported yet' : money(usd);
}

/** An amount spent: "$0.42", "about $0.42" when part of it is Workbench's estimate, "under $0.01" below a cent (never "<$0.01"). */
export function spentAmountWords(usd, estimated, money) {
  const n = Number(usd);
  if (n > 0 && n < 0.01) return 'under $0.01';
  return (estimated ? 'about ' : '') + money(n);
}

/**
 * What an agent has spent, in words: "$0.42"; "about $0.42" while part of it is Workbench's estimate of cost not reported
 * yet (`unreportedUsd`, Claude Code reports cost only when a turn ends); "under $0.01"; and when nothing is known, "not
 * reported" for Codex (it never reports cost) and "not reported yet" otherwise. Never "$0" for spend that was not
 * reported. The same wording as spentText() in /shared/format.mjs, kept here so the page also runs against an engine
 * whose format.mjs has no spentText.
 */
export function spentWords(usage, money, harness = null) {
  const u = usage || {};
  const est = Number(u.unreportedUsd) > 0 ? Number(u.unreportedUsd) : 0;
  const reported = typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) ? u.costUsd : null;
  if (reported == null && !est) return harness === 'codex' ? 'not reported' : 'not reported yet';
  return spentAmountWords((reported || 0) + est, est > 0, money);
}

/** Spend today over root agents started since midnight: reported cost plus Workbench's estimate; `estimated` says "about". */
export function spendTodayOf(agents, midnight) {
  let usd = 0, estimated = false;
  for (const a of agents) {
    if (!a || a.parentId || (a.startedAt || 0) < midnight) continue;
    const c = a.usage?.costUsd;
    if (typeof c === 'number' && Number.isFinite(c)) usd += c;
    const e = Number(a.usage?.unreportedUsd);
    if (e > 0) { usd += e; estimated = true; }
  }
  return { usd: Math.round(usd * 1e6) / 1e6, estimated };
}

/** A duration in whole minutes and up ("4 min"), and `fresh` under a minute, so nothing on screen ticks every second. */
export function calmDuration(ms, duration, fresh = 'just now') {
  if (!(ms >= 0)) return fresh;
  return ms < 60000 ? fresh : (duration(ms) || fresh);
}
