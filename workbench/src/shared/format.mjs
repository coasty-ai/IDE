// Small formatting helpers shared by the engine and the UI. No Node imports.

/** "3 s", "4 min", "1 h 12 min" */
export function duration(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** "980", "12.4k", "1.2M" */
export function tokens(n) {
  if (n == null || !isFinite(n)) return '–';
  if (n < 1000) return String(Math.round(n));
  if (n < 100000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1e6) return Math.round(n / 1000) + 'k';
  return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
}

/** "$0.04", "$1.20", "$12"; null means the agent does not report cost. */
export function money(usd) {
  if (usd == null || !isFinite(usd)) return 'not reported';
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  if (usd < 10) return '$' + usd.toFixed(2);
  return '$' + Math.round(usd);
}

/**
 * A spend figure in words: "$0.42"; "about $0.42" when part of it is Workbench's estimate; "under $0.01" for less than a
 * cent, estimated or not (never "<$0.01" or "about <$0.01").
 */
export function spentAmount(usd, estimated = false) {
  const n = Number(usd);
  if (n > 0 && n < 0.01) return 'under $0.01';
  return (estimated ? 'about ' : '') + money(n);
}

/**
 * What an agent has spent, from its usage and its harness: "$0.42"; "about $0.42" while part of it is Workbench's
 * estimate (Claude Code reports cost only when a turn ends); "under $0.01". When nothing is known: "not reported" for
 * Codex, which never reports cost, and "not reported yet" otherwise (a Claude agent before its first turn ends; also
 * when no harness is given). Never "$0" for spend that was not reported.
 */
export function spentText(usage, harness = null) {
  const u = usage || {};
  const est = Number(u.unreportedUsd) > 0 ? Number(u.unreportedUsd) : 0;
  const reported = typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) ? u.costUsd : null;
  if (reported == null && !est) return harness === 'codex' ? 'not reported' : 'not reported yet';
  return spentAmount((reported || 0) + est, est > 0);
}

/** "12%" */
export function percent(fraction) {
  if (fraction == null || !isFinite(fraction)) return '–';
  return Math.round(Math.max(0, Math.min(1, fraction)) * 100) + '%';
}

/** "just now", "2 min ago" */
export function ago(ts, now = Date.now()) {
  if (!ts) return '';
  const ms = now - ts;
  if (ms < 5000) return 'just now';
  return duration(ms) + ' ago';
}

/** Shorten long text to `n` characters at a word boundary, with an ellipsis. */
export function clip(text, n) {
  if (!text) return '';
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.5 ? cut.slice(0, sp) : cut).replace(/[,.;:\s]+$/, '') + '…';
}

/** "claude-haiku-4-5-20251001" -> "haiku 4.5"; unknown names pass through shortened. */
export function shortModel(model) {
  if (!model) return '';
  const m = String(model).toLowerCase();
  const fam = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'].find(f => m.includes(f));
  if (fam) {
    const v = m.match(new RegExp(fam + '[-_ ]?(\\d+)(?:[-_.](\\d+))?'));
    return v ? `${fam} ${v[1]}${v[2] && v[2].length <= 2 ? '.' + v[2] : ''}` : fam;
  }
  return clip(m.replace(/^openai\//, ''), 18);
}
