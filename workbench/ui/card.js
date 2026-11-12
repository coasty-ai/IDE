// The card: a small datasheet for one agent or helper, shown beside its chip on hover or keyboard focus.
// Calm shows the essentials (now, helpers, plan, time, cost); "more" shows the whole datasheet.
import { duration, tokens, money, percent, clip, shortModel } from '/shared/format.mjs';
import { pastTense } from '/shared/narrate.mjs';
import { LOOK, NEEDS_YOU } from '/shared/states.mjs';
import { SPARK_BUCKET_MS, SPARK_BUCKETS } from '/shared/events.mjs';
import { S, machineName, harnessLabel, helpersOf, helpersAtWork, unmergedWork, workSettled } from './model.js';
import { markOf, markOfAgent } from './look.js';
import { newTokens, stepsInWindow, windowMinutes, spentWords, calmDuration } from './numbers.js';
import { esc } from './util.js';
import { visibleControls } from './words.js';
import { agoText } from './boardmodel.js';

// Agent-controlled text: escaped, with hidden and direction-changing characters shown as marks (one rule, words.js).
const vis = x => esc(visibleControls(String(x ?? '')));

/**
 * Where a root's work is: "Merged into main · 2 min ago" (nothing new since), "Not merged yet", or "Its work was thrown
 * away · 5 min ago". Empty for helpers and agents without git, and while nothing is known.
 */
export function workWords(a, now) {
  const w = a && a.work;
  if (!w || a.parentId) return '';
  if (w.thrownAway) return `Its work was thrown away · ${agoText(now - (w.thrownAway.at || now))}`;
  if (w.merged && workSettled(a)) return `Merged into ${visibleControls(w.merged.into || 'your branch')} · ${agoText(now - (w.merged.at || now))}`;
  return unmergedWork(a) ? 'Not merged yet' : '';
}

const mark = (shape, tone) => `<svg class="g c-${tone}" viewBox="0 0 12 12" aria-hidden="true"><use href="#g-${shape}"/></svg>`;

function sparkSvg(values) {
  const w = 84, h = 14, n = values.length || 1, max = Math.max(1, ...values), bw = w / n;
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${values.map((v, i) => {
    const bh = v ? Math.max(2, Math.round((v / max) * h)) : 1;
    return `<rect x="${(i * bw + 0.5).toFixed(1)}" y="${h - bh}" width="${Math.max(1, bw - 1.5).toFixed(1)}" height="${bh}" rx="1" fill="currentColor" opacity="${v ? 0.9 : 0.25}"/>`;
  }).join('')}</svg>`;
}

function nowLine(a, now) {
  // restored from history: no process, nothing "now"; where it ended is what the person wants to know
  if (a.earlier) return `<span class="now">From an earlier run</span> <em>· ${esc(agoText(now - (a.endedAt || a.stateSince)))}</em>`;
  if (a.ask && NEEDS_YOU.has(a.state)) {
    let s = a.ask.sentence || '';
    if (s.startsWith(a.name + ' ')) s = s.slice(a.name.length + 1).replace(/^./, c => c.toUpperCase());
    return `<span class="now">${vis(clip(s, 90))}</span> <em>· ${esc(calmDuration(now - (a.ask.createdAt || a.stateSince), duration, 'just now'))}</em>`;
  }
  if (a.state === 'working' || a.state === 'starting') {
    const what = a.thinking && (!a.now || a.now === 'Thinking') ? 'Thinking' : (a.now || 'Working');
    // whole minutes only: the card does not tick every second
    const quietFor = now - (a.lastEventAt || a.stateSince);
    return `<span class="now">${vis(clip(what, 70))}</span>${quietFor >= 60000 ? ` <em>· quiet for ${esc(duration(quietFor))}</em>` : ''}`;
  }
  if (a.state === 'waiting_helpers') {
    // what it waits for, in the engine's words ("Waiting for a background command"), never a count of helper views
    return `<span class="now">${vis(clip(/^waiting/i.test(a.now || '') ? a.now : 'Waiting for its background work', 70))}</span>`;
  }
  if (a.state === 'failed') return `<span class="now">${vis(clip(a.error || a.stateReason || 'It stopped with an error.', 110))}</span>`;
  return `<span class="now">${vis(a.says ? clip(a.says, 110) : markOf(a.state, LOOK).label)}</span>`;
}

/** A one-sentence summary, for screen readers (the chip's aria-describedby points here). */
function summary(a, now) {
  const parts = [];
  if (a.earlier) parts.push(`From an earlier run, ${agoText(now - (a.endedAt || a.stateSince))}`);
  if (a.ask && NEEDS_YOU.has(a.state)) parts.push(a.ask.sentence);
  else if (a.state === 'working' || a.state === 'starting') parts.push(a.now || 'Working');
  else parts.push(markOf(a.state, LOOK).label);
  if (!a.parentId) {
    const kids = helpersOf(a);
    if (kids.length) parts.push(`${kids.length} helper${kids.length === 1 ? '' : 's'}, ${helpersAtWork(a)} at work`);
  }
  parts.push(calmDuration((a.endedAt || now) - a.startedAt, duration, 'under 1 min'));
  if (!a.parentId) parts.push(spentWords(a.usage, money, a.harness) + (a.usage?.costUsd != null && a.budgetUsd != null ? ` of ${money(a.budgetUsd)}` : ''));
  parts.push(workWords(a, now).replace(' · ', ', '));
  return parts.filter(Boolean).join('. ') + '.';
}

/**
 * The card's markup for one agent or helper.
 * @param {object} a        the AgentView
 * @param {{ detail: 'calm'|'more', now: number, one: boolean, pinned?: boolean }} o   one: a single column (small windows)
 */
export function cardHtml(a, o) {
  const now = o.now || Date.now();
  const more = o.detail === 'more';
  const look = markOfAgent(a, LOOK);
  const helper = !!a.parentId;
  const parent = helper ? S.agents.get(a.parentId) : null;
  const sub = [helper ? '' : harnessLabel(a.harness), shortModel(a.model), helper ? `helper of ${parent?.name || 'an agent'}` : machineName(a.machineId)].filter(Boolean).join(' · ');
  const kids = helper ? [] : helpersOf(a);
  // helpers by need (asking, working, latest ended): a few on hover, more once pinned, then a count of the rest
  const cap = o.pinned ? 10 : more ? 6 : 4;
  const listed = kids.length > cap ? kids.slice(0, cap - 1) : kids;
  const kidsHtml = listed.map(k => { const m = markOf(k.state, LOOK); return `<div class="kid">${mark(m.shape, m.tone)}<span>${vis(k.name)}${more ? ` <em>· ${vis(k.state === 'working' || k.state === 'starting' ? clip(k.now || 'working', 40) : m.label)}</em>` : ''}</span></div>`; }).join('')
    + (kids.length > listed.length ? `<div class="kid"><em>and ${kids.length - listed.length} more${o.pinned ? '' : ' (click to see more)'}</em></div>` : '');
  const u = a.usage || {};
  const elapsed = (a.endedAt || now) - a.startedAt;
  let cost = spentWords(u, money, a.harness);
  if (!helper && u.costUsd != null && a.budgetUsd != null) cost += ` of ${money(a.budgetUsd).replace(/\.00$/, '')}`;
  if (helper && a.harness === 'claude') cost = 'in its agent';
  const plan = a.plan && a.plan.total ? (() => {
    const nb = Math.min(a.plan.total, 8), on = Math.round(a.plan.done / a.plan.total * nb);
    return `<span class="bar" aria-hidden="true">${Array.from({ length: nb }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</span>${a.plan.done} of ${a.plan.total} steps`;
  })() : '';
  // "more": where its work is, on the Now line's second row
  const wk = more ? workWords(a, now) : '';
  const lines = [`<div class="ln"><span>Now</span><span>${nowLine(a, now)}${wk ? `<span class="wk">${esc(wk)}</span>` : ''}</span></div>`];
  if (more) {
    const last = (a.recent || []).slice(-1).map(s => `<span class="${s.ok === false ? 'x' : ''}">${s.ok === false ? '✗' : '✓'} ${vis(clip(pastTense(s.sentence), 60))}</span>`).join('');
    if (last) lines.push(`<div class="ln"><span>Last</span><span>${last}</span></div>`);
  }
  if (kidsHtml) lines.push(`<div class="ln"><span>Helpers</span><span>${kidsHtml}</span></div>`);
  if (plan) lines.push(`<div class="ln"><span>Its plan</span><span>${plan}</span></div>`);
  if (more) {
    const inWindow = stepsInWindow(a.spark);
    const mins = windowMinutes(SPARK_BUCKET_MS, SPARK_BUCKETS);
    const bars = inWindow ? `<span title="Steps in each half minute, last ${mins} minutes">${sparkSvg(a.spark || [])}</span>` : '';
    lines.push(`<div class="ln"><span>Activity</span><span>${bars}${inWindow ? `${inWindow} step${inWindow === 1 ? '' : 's'} in ${mins} min` : `none in the last ${mins} min`}<em> · ${a.toolCalls} in all</em></span></div>`);
  }
  const cells = [`<div><em>Time</em><strong>${esc(calmDuration(elapsed, duration, 'under 1 min'))}</strong></div>`, `<div><em>Cost</em><strong>${esc(cost)}</strong></div>`];
  if (more) {
    const fresh = newTokens(u), reread = u.cacheReadTokens || 0;
    const tip = `${tokens(fresh)} new: ${tokens(u.outputTokens || 0)} written by the agent, ${tokens((u.inputTokens || 0) + (u.cacheWriteTokens || 0))} read for the first time or added to its memory. Plus ${tokens(reread)} re-read from memory, which is cheaper and already in Cost.`;
    const ctx = u.contextPct;
    const ap = a.approvals || { auto: 0, byYou: 0, denied: 0 };
    const approvals = ap.auto || ap.byYou ? `${ap.auto} auto${ap.byYou ? ` · ${ap.byYou} you` : ''}` : '–';
    const f = a.files, files = f && f.changed ? `${f.changed} (+${f.adds} −${f.dels})` : '–';
    cells.push(`<div title="${esc(tip)}"><em>Tokens</em><strong>${esc(tokens(fresh))} new</strong></div>`,
      `<div><em>Context used</em><strong>${esc(percent(ctx))}</strong>${ctx != null ? `<div class="meter"><i style="width:${Math.round(Math.min(1, ctx) * 100)}%"></i></div>` : ''}</div>`,
      `<div title="Approved automatically, and by you"><em>Approvals</em><strong>${esc(approvals)}</strong></div>`,
      `<div><em>Files changed</em><strong>${esc(files)}</strong></div>`);
  }
  const foot = [];
  if (more) {
    if (a.approvals?.denied) foot.push(`${a.approvals.denied} denied`);
    if (a.checks?.state === 'passed') foot.push('checks passed');
    if (a.checks?.state === 'failed') foot.push('a check failed');
    if (a.checks?.state === 'running') foot.push('checks running');
    if (a.rules?.broken?.length) foot.push(`${a.rules.broken.length} rule broken: ${clip(a.rules.broken[0].say, 50)}`);
  }
  return `<p class="sr" id="cardSum">${vis(a.name)}: ${vis(summary(a, now))}</p>
    <div class="hd"><b>${vis(a.name)}</b><span class="stt">${mark(look.shape, look.tone)}${esc(look.label)}</span></div>
    ${more || helper ? `<div class="sub">${vis(sub)}</div>` : ''}<hr>
    <div class="cols"><div>${lines.join('')}</div>${o.one ? '' : '<div class="vr"></div>'}
    <div class="grid">${cells.join('')}</div></div>${foot.length ? `<div class="foot">${esc(foot.join(' · '))}</div>` : ''}`;
}
