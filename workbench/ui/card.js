// The hover card: live progress and the important numbers for one agent or helper.
import { lookOf } from '/shared/states.mjs';
import { duration, tokens, money, percent, clip, shortModel } from '/shared/format.mjs';
import { pastTense } from '/shared/narrate.mjs';
import { S, childrenOf, machineName, harnessLabel } from './model.js';
import { shortStatus } from './orbit.js';
import { esc } from './util.js';

function sparkSvg(values, tone) {
  const w = 96, h = 16, n = values.length || 1, max = Math.max(1, ...values);
  const bw = w / n;
  const bars = values.map((v, i) => {
    const bh = v ? Math.max(2, Math.round((v / max) * h)) : 1;
    return `<rect x="${(i * bw + 0.5).toFixed(1)}" y="${h - bh}" width="${Math.max(1, bw - 1.5).toFixed(1)}" height="${bh}" rx="1" fill="currentColor" opacity="${v ? 0.85 : 0.18}"/>`;
  }).join('');
  return `<svg class="spark t-${tone}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${bars}</svg>`;
}

function planBar(plan) {
  const n = Math.min(plan.total, 10);
  const on = Math.round((plan.done / Math.max(1, plan.total)) * n);
  return `<span class="bar" aria-hidden="true">${Array.from({ length: n }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</span>`;
}

const shapeOf = a => { const l = lookOf(a.state); return `<svg class="sh t-${l.tone}" aria-hidden="true"><use href="#s-${l.shape}"/></svg>`; };

function nowLine(a, now) {
  if (a.ask && (a.state === 'needs_ok' || a.state === 'question' || a.state === 'maybe_stuck')) {
    // The header already names the agent, so drop a leading name from the sentence.
    let sentence = a.ask.sentence || '';
    if (sentence.startsWith(a.name + ' ')) sentence = sentence.slice(a.name.length + 1).replace(/^./, c => c.toUpperCase());
    return `<span class="now">${esc(clip(sentence, 56))}</span> <i>· ${esc(duration(now - (a.ask.createdAt || a.stateSince)))}</i>`;
  }
  if (a.state === 'working' || a.state === 'starting') {
    const what = a.thinking && (!a.now || a.now === 'Thinking') ? 'Thinking' : (a.now || 'Working');
    const quiet = now - (a.lastEventAt || a.stateSince);
    // Only mention silence when it is long enough to matter.
    return `<span class="now">${esc(clip(what, 40))}</span>${quiet > 20000 ? ` <i>· quiet for ${esc(duration(quiet))}</i>` : ''}`;
  }
  if (a.state === 'waiting_helpers') {
    const k = childrenOf(a.id).filter(c => c.state === 'working' || c.state === 'starting').length;
    return `<span class="now">Waiting for ${k || 'its'} helper${k === 1 ? '' : 's'}</span>`;
  }
  return `<span class="now">${esc(a.says ? clip(a.says, 70) : lookOf(a.state).label)}</span>`;
}

/** Card HTML for one agent. `pinned` shows the unpin control. */
export function cardHtml(a, now, pinned) {
  const look = lookOf(a.state);
  const helper = !!a.parentId;
  const sub = [
    harnessLabel(a.harness),
    shortModel(a.model),
    helper ? (a.helperType ? `${a.helperType} helper of ${S.agents.get(a.parentId)?.name || 'an agent'}` : 'helper') : machineName(a.machineId),
  ].filter(Boolean).join(' · ');

  const lastStep = (a.recent || []).slice(-1).map(s =>
    `<span class="${s.ok === false ? 'x' : ''}">${s.ok === false ? '✗' : '✓'} ${esc(clip(pastTense(s.sentence), 44))}</span>`).join('');

  // The tree, in words: each helper with what it is doing.
  const kids = helper ? [] : childrenOf(a.id);
  const activeKids = kids.filter(k => !['finished', 'failed', 'stopped'].includes(k.state));
  const listed = [...activeKids, ...kids.filter(k => !activeKids.includes(k)).reverse()].slice(0, 4);
  const kidsHtml = listed.map(k => `<span>${shapeOf(k)}${esc(clip(k.name, 22))} <em>· ${esc(shortStatus(k))}</em></span>`).join('')
    + (kids.length > listed.length ? `<span><em>and ${kids.length - listed.length} more</em></span>` : '');

  const u = a.usage || {};
  const totalTokens = (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
  const tokenTitle = `New input ${tokens(u.inputTokens)} · output ${tokens(u.outputTokens)} · re-read from cache ${tokens(u.cacheReadTokens)} · written to cache ${tokens(u.cacheWriteTokens)}`;
  const ctx = u.contextPct;
  const elapsed = (a.endedAt || now) - a.startedAt;
  const f = a.files;
  const files = f && f.changed ? `${f.changed} (+${f.adds} −${f.dels})` : '–';
  let cost = money(u.costUsd);
  if (!helper && u.costUsd != null && a.budgetUsd != null) cost += ` of ${money(a.budgetUsd).replace(/\.00$/, '')}`;
  if (helper) cost = a.harness === 'claude' ? 'in parent' : cost;
  const ap = a.approvals || { auto: 0, byYou: 0, denied: 0 };
  const approvals = ap.auto || ap.byYou || ap.denied ? `${ap.auto} auto · ${ap.byYou} you` : '–';

  const foot = [];
  if (ap.denied) foot.push(`${ap.denied} denied`);
  if (a.checks && a.checks.state === 'passed') foot.push('checks passed');
  if (a.checks && a.checks.state === 'failed') foot.push('a check failed');
  if (a.checks && a.checks.state === 'running') foot.push('checks running');
  if (a.rules && a.rules.broken && a.rules.broken.length) foot.push(`${a.rules.broken.length} rule broken`);

  return `
  <div class="hd"><b>${esc(a.name)}</b><span class="stt t-${look.tone}"><svg class="sh" aria-hidden="true"><use href="#s-${look.shape}"/></svg>${esc(look.label)}</span>${pinned ? '<button class="pin" data-unpin title="Unpin (Esc)">×</button>' : ''}</div>
  <div class="sub">${esc(sub)}</div>
  <hr>
  <div class="ln"><span>Now</span><span>${nowLine(a, now)}</span></div>
  ${lastStep ? `<div class="ln"><span>Last</span><span class="steps">${lastStep}</span></div>` : ''}
  ${kidsHtml ? `<div class="ln"><span>Helpers</span><span class="kids">${kidsHtml}</span></div>` : ''}
  ${a.plan && a.plan.total ? `<div class="ln"><span>Its plan</span><span>${planBar(a.plan)}${a.plan.done} of ${a.plan.total} steps</span></div>` : ''}
  <div class="ln"><span>Activity</span><span>${sparkSvg(a.spark || [], look.tone)}${a.toolCalls} step${a.toolCalls === 1 ? '' : 's'}${a.turns > 1 ? ` · ${a.turns} turns` : ''}</span></div>
  <hr>
  <div class="grid">
    <div><em>Time</em><strong>${esc(duration(elapsed) || '0 s')}</strong></div>
    <div><em>Cost</em><strong>${esc(cost)}</strong></div>
    <div title="${esc(tokenTitle)}"><em>Tokens</em><strong>${esc(tokens(totalTokens))}</strong></div>
    <div><em>Context used</em><strong>${esc(percent(ctx))}</strong>${ctx != null ? `<div class="meter"><i class="${ctx > 0.8 ? 'hot' : ''}" style="width:${Math.round(Math.min(1, ctx) * 100)}%"></i></div>` : ''}</div>
    <div title="Approved automatically, and by you"><em>Approvals</em><strong>${esc(approvals)}</strong></div>
    <div><em>Files changed</em><strong>${esc(files)}</strong></div>
  </div>
  ${foot.length ? `<div class="foot">${esc(foot.join(' · '))}</div>` : ''}`;
}

/** Place the card beside a node, on the side away from the centre, inside the window. */
export function placeCardAt(card, p) {
  const w = card.offsetWidth || 352, h = card.offsetHeight || 300, gap = p.kind === 'moon' ? 22 : 34;
  let left = p.x >= p.cx ? p.x + gap : p.x - gap - w;
  if (left + w > innerWidth - 12) left = p.x - gap - w;
  if (left < 12) left = p.x + gap;
  const top = Math.max(56, Math.min(p.y - h / 2, innerHeight - h - 12));
  card.style.transformOrigin = left > p.x ? 'left center' : 'right center';
  card.style.left = left.toFixed(0) + 'px';
  card.style.top = top.toFixed(0) + 'px';
}
