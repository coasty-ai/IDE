// The core's lid: one thing at a time, in one sentence, with at most two answers.
// lidView() only builds markup; app.js decides when to swap or patch it. Every button carries what it was drawn for
// (data-agent, data-ask, data-confirm), so a click acts on exactly what the person read.
import { clip, money, duration } from '/shared/format.mjs';
import { LOOK } from '/shared/states.mjs';
import { S, machineName, harnessLabel } from './model.js';
import { markOfAgent } from './look.js';
import { spentWords } from './numbers.js';
import { visibleControls, clipMiddle, whoAsks, headlineClass } from './words.js';
import { esc } from './util.js';
import { agoText } from './boardmodel.js';

const mark = (shape, tone) => `<svg class="g k-${tone}" viewBox="0 0 12 12" aria-hidden="true"><use href="#g-${shape}"/></svg>`;
// "waiting 4 min": whole minutes only, so the lid does not tick every second while something waits ("asked just now" first)
const sinceText = (ms, prefix, fresh) => { const age = Date.now() - (Number(ms) || 0); return age < 60000 ? fresh : prefix + (duration(age) || 'a moment'); };
const since = (ms, prefix = '', fresh = 'just now') => `<span data-since="${Number(ms) || 0}" data-prefix="${esc(prefix)}" data-fresh="${esc(fresh)}">${esc(sinceText(ms, prefix, fresh))}</span>`;
const attrs = o => Object.entries(o).filter(([, v]) => v != null && v !== false).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');

/** A big answer button. `d` becomes data-* attributes (act, agent, ask, answer, confirm, …). */
function bigButton(label, d, pri = false) {
  return `<button type="button" class="big${pri ? ' pri' : ''}"${attrs({ ...d, key: `${d.act}:${label}` })}>${esc(label)}</button>`;
}
function quiet(label, d, extra = '') {
  return `<button type="button" class="quiet"${attrs({ ...d, key: `${d.act}:${label}` })}${extra}>${esc(label)}</button>`;
}

/** The count line: a mark, a few words, and "next" when two or more things wait. */
function countLine(shape, tone, words, f) {
  const step = f && f.total > 1 ? `<button type="button" class="step" data-act="next" data-key="next" aria-label="Show the next one (or press the right arrow)">next</button>` : '';
  return `<div class="count"><span class="who">${mark(shape, tone)}<span>${esc(words)}</span></span>${step}</div>`;
}

/** The whole of a long text, in a box of its own that scrolls (the only place the lid lets text scroll). */
const readAllBox = inner => `<div class="readall" data-scroll="1" tabindex="0" aria-label="All of it">${inner}</div>`;

function filesList(a) {
  const f = a.files;
  if (!f || !f.changed) return '<div class="more-text">No files changed.</div>';
  const items = (f.list || []).slice(0, 6).map(x => `<li>${esc(x.path)} <span>+${x.adds} −${x.dels}</span>${x.ignored ? ' <em>(hidden by a .gitignore it changed)</em>' : ''}</li>`).join('');
  const rest = f.changed > 6 ? `<li>and ${f.changed - 6} more</li>` : '';
  return `<div class="more-text"><ul>${items}${rest}</ul></div>`;
}

/** "Claude · Cloud 1 · <extra>" in "more"; just the extra (and whose helper it is) when calm. */
function metaLine(a, extraHtml, more) {
  const parent = a.parentId ? S.agents.get(a.parentId) : null;
  const whose = parent ? esc(`helper of ${parent.name}`) : '';
  const parts = more ? [esc(harnessLabel(a.harness)), whose || esc(machineName(a.machineId)), extraHtml] : [whose, extraHtml];
  return parts.filter(Boolean).join(' · ');
}

/**
 * How the lid makes room, step by step, when its content does not fit the core (the window is small, or the text long):
 *   1-3  the headline steps down a size each time;
 *   2    the meta line keeps only its essentials;      3  the meta line goes (whose helper it is stays);
 *   4    a text over 200 characters is cut, with "Read all of it";
 *   5    secondary links go, the answer buttons tighten and the command sits closer; a permission still shows about 160
 *        characters of its command and the whole of its reason (security over calm);
 *   6    the last resort: long texts 140, the command 72, the reason 60 (all of both under "See all of it").
 */
export function fitSteps(fit) {
  return {
    hDown: Math.min(3, fit), meta: fit >= 3 ? 0 : fit >= 2 ? 1 : 2, longCut: fit >= 6 ? 140 : fit >= 4 ? 190 : Infinity,
    cmd: fit >= 6 ? 72 : 160, why: fit >= 6 ? 60 : Infinity, extras: fit < 5, tight: fit >= 5, close: fit >= 5,
  };
}

/**
 * Build the lid for one focus (see currentFocus in model.js).
 * @param {object} f        the focus
 * @param {object} o        { detail: 'calm'|'more', fit: 0..6 (see fitSteps), open: { exact, changed, all }, link, late }
 * @returns {{ key: string, html: string, say: string, count: string, idle: boolean, bind: object }}
 */
export function lidView(f, o = {}) {
  const more = o.detail === 'more';
  const fs = fitSteps(o.fit || 0);
  const open = o.open || {};
  const h1 = text => `<h1 tabindex="-1" class="${headlineClass(text, fs.hDown)}">${esc(text)}</h1>`;
  // the answer buttons drawn in this call, so the row can be laid out for their words (see buttonRow in words.js)
  const labels = [];
  const big = (label, d, pri) => { labels.push(label); return bigButton(label, d, pri); };
  const page = (count, sentence, rest) => {
    const row = rest.acts && o.row ? o.row(labels) : '';
    const cls = `acts${fs.tight || row === 'tight' ? ' tight' : ''}${row === 'stack' ? ' stack' : ''}`;
    return `<div class="msg">${count}${sentence}${rest.msg || ''}</div>${rest.acts ? `<div class="${cls}">${rest.acts}</div>` : ''}${rest.after || ''}`;
  };
  const metaP = html => (html ? `<p class="meta">${html}</p>` : '');
  // a long text: cut past the fit's limit, with "Read all of it" opening the whole of it in its own scroll box
  const long = (text, done) => {
    if (text.length <= fs.longCut) return { html: h1(text), toggle: '' };
    const toggle = quiet(open.all ? 'Show less' : 'Read all of it', { act: 'readall' }, ` aria-expanded="${!!open.all}"`);
    return { html: open.all ? readAllBox(h1(text)) : h1(clip(text, fs.longCut)), toggle, done };
  };

  if (o.link === 'no-key' || o.link === 'stale' || o.link === 'down') {
    const t = o.link === 'no-key'
      ? ['Not connected', 'Open the link printed in the terminal.', 'It ends with ?t= and a key, so only you can use this page.']
      : o.link === 'stale'
        ? ['Not connected', 'This page’s key no longer works.', 'Workbench makes a new key each time it starts. Open the link it printed in the terminal.']
        : ['Not connected', 'Workbench isn’t answering.', 'If you restarted it, open the new link from the terminal.'];
    return { key: 'link:' + o.link, idle: true, count: t[0], say: `${t[1]} ${t[2]}`, bind: {},
      html: page(countLine('off', 'word', t[0]), h1(t[1]), { msg: fs.meta ? metaP(esc(t[2])) : '' }) };
  }
  if (o.link === 'connecting') {
    return { key: 'link:connecting', idle: true, count: '', say: '', bind: {}, html: o.late ? page('', metaP('Connecting…'), {}) : '' };
  }

  if (f.confirm) {
    const c = f.confirm;
    const t = long(c.sentence);
    return {
      key: 'confirm:' + c.id, idle: false, count: 'You said', say: `You said: ${c.sentence} ${c.detail || ''}`.trim(), bind: { confirmId: c.id },
      html: page(countLine('ask', 'work', 'You said'), t.html,
        { msg: c.detail && fs.meta ? metaP(esc(c.detail)) : '',
          acts: big('Do it', { act: 'confirm', confirm: c.id, go: '1' }, true) + big('Cancel', { act: 'confirm', confirm: c.id, go: '0' }),
          after: t.toggle }),
    };
  }

  if (f.empty) {
    const working = [...S.agents.values()].filter(a => !a.parentId && ['working', 'starting', 'waiting_helpers'].includes(a.state)).length;
    const aside = f.aside || [];
    const sub = working ? `${working} agent${working === 1 ? ' is' : 's are'} working quietly.`
      : S.agents.size ? 'Say or type what you want.' : 'Say or type what you want an agent to do, for example “start an agent to fix the flaky checkout test”.';
    const asideBtn = aside.length ? quiet(`Look at ${clip(aside[0].name, 28)} now`, { act: 'pick', agent: aside[0].id }) : '';
    const count = aside.length ? `${aside.length} set aside` : 'All clear';
    return {
      key: 'empty', idle: true, count, say: `${count}. Nothing needs you.`, bind: {},
      html: page(countLine('ok', 'ok', count), h1('Nothing needs you.'), { msg: fs.meta ? metaP(esc(sub)) : '', after: asideBtn }),
    };
  }

  const a = f.agent;
  const ask = a.ask;
  const m = markOfAgent(a, LOOK);
  const parent = a.parentId ? S.agents.get(a.parentId) : null;
  const inQueue = f.total != null && !f.review;
  const countWords = inQueue ? `${f.index + 1} of ${f.total} need${f.total === 1 ? 's' : ''} you`
    : f.review ? (f.total > 1 ? `${f.index + 1} of ${f.total} to look at` : 'Ready for you to look at')
    : m.label;
  const waited = ask?.createdAt || a.stateSince;
  const id = { agent: a.id };
  const withAsk = ask ? { agent: a.id, ask: ask.id } : id;
  const st = { agent: a.id, state: a.state };
  const step = (inQueue || f.review) && f.total > 1 ? `<button type="button" class="step" data-act="next" data-key="next" aria-label="Show the next one (or press the right arrow)">next</button>` : '';
  let count = `<div class="count"><span class="who">${mark(m.shape, m.tone)}<span>${esc(countWords)}</span></span>${step}</div>`;
  let sentence = null, msg = '', acts = '', after = '';
  // the meta line: everything in "more", the essentials when calm, nothing once the lid is short of room
  const meta = (extraHtml, essentials = extraHtml) => metaP(fs.meta === 2 && more ? metaLine(a, extraHtml, true) : fs.meta ? metaLine(a, essentials, false) : '');

  switch (a.earlier && !a.parentId ? 'earlier' : a.state) {
    case 'earlier': {
      // Restored from history: it has no process. It can be picked up where it left off (a new spending limit for this
      // run), or forgotten; either way what it did stays in its folder.
      count = `<div class="count"><span class="who">${mark(m.shape, m.tone)}<span>From an earlier run</span></span></div>`;
      const ended = { done_checked: 'was done and checked', done_claimed: 'said it was done', checks_failed: 'was done, but a check failed', failed: 'stopped with an error', stopped: 'was stopped' }[a.state] || 'ran earlier';
      sentence = `${a.name} ${ended}.`;
      const budget = S.meta.defaultBudgetUsd;
      const note = a.canContinue
        ? (budget ? `It would get a new spending limit of ${money(budget)} for this run.` : 'It would pick up where it left off.')
        : (a.continueReason || 'It cannot continue.');
      msg += metaP(esc(`${agoText(Date.now() - (a.endedAt || a.stateSince))}${fs.meta && a.says ? ` · ${clip(a.says, more ? 110 : 70)}` : ''}`));
      if (fs.meta) msg += metaP(esc(note));
      acts = (a.canContinue ? big('Continue', { act: 'fix', ...st, text: 'Please continue where you left off.' }, true) : '')
        + big('Forget', { act: 'forget', ...st }, !a.canContinue);
      break;
    }
    case 'needs_ok': {
      sentence = `${(ask?.sentence || `${a.name} needs your OK`).replace(/[.\s]+$/, '')}.`;
      // Security over calm: the exact command or path, always, with the check's own reason.
      const full = ask?.detail ? visibleControls(ask.detail) : '';
      const cm = clipMiddle(full, fs.cmd);
      const whyFull = ask?.why || '';
      const whyShown = whyFull.length > fs.why ? clip(whyFull, fs.why) : whyFull;
      const cut = cm.clipped || whyShown !== whyFull;
      if (full) {
        const toggle = cut ? `<button type="button" class="quiet" data-act="exact" data-key="exact" aria-expanded="${!!open.exact}">${open.exact ? 'Show less' : 'See all of it'}</button>` : '';
        const code = open.exact && cut
          ? `<code class="all" tabindex="0" data-scroll="1" aria-label="The exact command, in full">${esc(full)}${whyFull ? `\n\n${esc(whyFull)}` : ''}</code>`
          : `<code>${esc(cm.text)}</code>`;
        msg += `<div class="exact${fs.close ? ' close' : ''}">${code}${toggle}</div>`;
      }
      if (whyFull && !(open.exact && cut)) msg += `<p class="why${fs.close ? ' close' : ''}">${esc(whyShown)}</p>`;
      msg += fs.meta ? meta(since(waited, 'waiting ', 'asked just now')) : parent ? metaP(esc(`helper of ${parent.name}`)) : '';
      const opts = ask?.options?.length ? ask.options.slice(0, 2) : ['Allow', 'Deny'];
      // Allow and Deny carry equal weight: the person reads before answering.
      acts = opts.map(o2 => big(o2, { act: 'answer', ...withAsk, answer: o2 })).join('');
      break;
    }
    case 'question': {
      const who = whoAsks(parent ? `${parent.name}’s helper` : a.name, inQueue ? f.index : 0, inQueue ? f.total : 1, o.whoMax ? o.whoMax(inQueue ? f.total : 1) : 28);
      count = `<div class="count"><span class="who">${mark(m.shape, m.tone)}<span>${esc(who)}</span></span>${step}</div>`;
      const t = long(ask?.sentence || a.says || `${a.name} has a question.`);
      sentence = t;
      msg += meta(since(waited, 'waiting ', 'asked just now'));
      const opts = (ask?.options || []).slice(0, 2);
      acts = opts.length ? opts.map((o2, i) => big(o2, { act: 'answer', ...withAsk, answer: o2 }, i === 0)).join('')
        : big('Answer', { act: 'reply', ...withAsk, mode: 'answer' }, true);
      if (opts.length && more && fs.extras) after = quiet('Answer in your own words', { act: 'reply', ...withAsk, mode: 'answer' });
      // a live question comes with what the agent changed so far
      if (more && fs.extras && a.files?.changed) after += quiet(open.changed ? 'Hide the changes' : 'What changed?', { act: 'changed' }, ` aria-expanded="${!!open.changed}"`) + (open.changed ? filesList(a) : '');
      break;
    }
    case 'maybe_stuck': {
      if (ask?.about === 'background') {
        // not stuck: it finished, but something it started still runs ("It is done" / "Keep waiting")
        sentence = `${(ask.sentence || `${a.name} has finished, but something it started is still running`).replace(/[.\s]+$/, '')}.`;
        const work = String(ask.detail || '').split('\n').map(x => x.trim()).filter(Boolean).join(' · ');
        if (work) msg += metaP(esc(clip(work, fs.meta ? 110 : 70)));
        const opts = ask.options?.length ? ask.options.slice(0, 2) : ['It is done', 'Keep waiting'];
        acts = opts.map((o2, i) => big(o2, { act: 'answer', ...withAsk, answer: o2 }, i === 0)).join('');
        break;
      }
      sentence = `${a.name} might be stuck.`;
      const why = ask?.sentence ? ask.sentence.replace(new RegExp('^' + a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' has'), 'It has') : 'It has not made progress for a while.';
      msg += metaP(esc(clip(why, fs.meta ? 110 : 70)));
      if (more && ask?.detail && fs.meta === 2) msg += `<p class="why">${esc(clip(ask.detail, 160))}</p>`;
      const opts = ask?.options?.length ? ask.options.slice(0, 2) : ['Stop it', 'Let it keep trying'];
      acts = opts.map((o2, i) => big(o2, { act: 'answer', ...withAsk, answer: o2 }, i === 0)).join('');
      if (more && fs.extras) after = quiet('Give it a hint', { act: 'reply', ...withAsk, mode: 'answer' });
      break;
    }
    case 'checks_failed': {
      const failed = (a.checks?.results || []).filter(r => !r.ok).map(r => r.name);
      sentence = `${a.name} is done, but a check failed.`;
      const what = failed.length ? esc(`failed: ${clip(failed.join(', '), 60)}`) : '';
      msg += fs.meta ? meta(what) : metaP(what);
      acts = big('Ask it to fix that', { act: 'fix', ...st, text: `A check failed (${failed.join(', ') || 'see the output'}). Please fix it.` }, true)
        + big('Look later', { act: 'later', ...st });
      if (more && fs.extras) after = quiet(open.changed ? 'Hide the changes' : 'What changed?', { act: 'changed' }, ` aria-expanded="${!!open.changed}"`) + (open.changed ? filesList(a) : '');
      break;
    }
    case 'done_checked': case 'done_claimed': {
      sentence = a.state === 'done_checked' ? `${a.name} is done and checked.` : `${a.name} says it is done.`;
      const broken = a.rules?.broken || [];
      if (broken.length) msg += `<p class="know">One thing to know: it broke a rule you set (${esc(clip(broken[0].say, 60))}).</p>`;
      if (a.says && fs.meta) msg += metaP(esc(clip(a.says, more && fs.meta === 2 ? 200 : 110)));
      else if (more && fs.meta === 2) msg += meta(a.state === 'done_checked' ? 'its checks passed' : 'nothing checked it');
      acts = big('Looks good', { act: 'looksgood', ...st, answer: 'Looks good' }, true) + big('Ask for a change', { act: 'reply', ...st, mode: 'say' });
      if (more && fs.extras) after = quiet(open.changed ? 'Hide the changes' : 'What changed?', { act: 'changed' }, ` aria-expanded="${!!open.changed}"`) + (open.changed ? filesList(a) : '');
      break;
    }
    case 'failed': {
      sentence = `${a.name} stopped with an error.`;
      msg += metaP(esc(clip(a.error || a.stateReason || 'The agent exited unexpectedly.', fs.meta ? 120 : 70)));
      acts = a.parentId ? big('Back', { act: 'parent', ...id }, true)
        : big('Try again', { act: 'fix', ...st, text: 'Please try again.' }, true) + big('Dismiss', { act: 'reviewed', ...st });
      break;
    }
    case 'stopped': {
      sentence = `${a.name} was stopped.`;
      if (more && fs.meta === 2) msg += meta('');
      acts = a.parentId ? big('Back', { act: 'parent', ...id }, true)
        : big('Continue', { act: 'fix', ...st, text: 'Please continue where you left off.' }, true) + big('Dismiss', { act: 'reviewed', ...st });
      break;
    }
    case 'finished': {
      sentence = `${a.name} finished its part.`;
      if (a.says && fs.meta) msg += metaP(esc(clip(a.says, more && fs.meta === 2 ? 200 : 110)));
      acts = big(`Back to ${clip(parent?.name || 'its agent', 24)}`, { act: 'parent', ...id }, true);
      break;
    }
    case 'waiting_helpers': {
      // what it waits for, in the engine's words ("Waiting for a background command"), never a count of helper views:
      // it may be waiting on a command it left running
      const w = /^waiting for /i.test(a.now || '') ? a.now.replace(/^waiting for /i, '').replace(/[.\s]+$/, '') : '';
      sentence = `${a.name} is waiting for ${w || 'its background work'}.`;
      msg += meta(since(a.stateSince, 'for '));
      acts = big('Tell it something', { act: 'reply', ...st, mode: 'say' }, true) + big('Stop it', { act: 'stop', ...st });
      break;
    }
    default: { // working, starting
      sentence = `${a.name} is working.`;
      const now = a.thinking && (!a.now || a.now === 'Thinking') ? 'Thinking' : (a.now || 'Starting');
      msg += fs.meta === 2 && more ? metaP(`${esc(clip(now, 70))} · ${metaLine(a, '', true)}`) : metaP(esc(clip(now, 70)));
      acts = big('Tell it something', { act: 'reply', ...st, mode: 'say' }, true) + big('Stop it', { act: 'stop', ...st });
      if (more && fs.extras && !a.parentId && a.usage) { const sw = spentWords(a.usage, money, a.harness); after = metaP(esc(/^not reported/.test(sw) ? `cost ${sw}` : `${sw} so far${a.budgetUsd != null ? ` of ${money(a.budgetUsd)}` : ''}`)); }
    }
  }
  // Something the person picked that does not need them: the way back to what does.
  if (f.picked && !inQueue && !f.review) after += quiet(f.queued ? 'Back to what needs me' : 'Close', { act: 'unpick' });
  const head = typeof sentence === 'string' ? { html: h1(sentence), toggle: '' } : sentence;
  const text = typeof sentence === 'string' ? sentence : (ask?.sentence || a.says || '');
  const say = `${inQueue || f.review ? countWords + '. ' : ''}${text}${ask?.detail && a.state === 'needs_ok' ? ' It will run: ' + clip(ask.detail, 160) + '.' : ''}`;
  return {
    key: `${a.id}|${a.state}|${ask ? ask.id : ''}`, idle: false, count: countWords, say,
    bind: { agentId: a.id, askId: ask ? ask.id : null },
    html: page(count, head.html, { msg, acts, after: head.toggle + after }),
  };
}

/** Refresh the "waiting 4 min" style counters inside an element, in place. Their words change at most once a minute. */
export function tickSince(root) {
  for (const s of root.querySelectorAll('[data-since]')) {
    const t = sinceText(s.dataset.since, s.dataset.prefix || '', s.dataset.fresh || 'just now');
    if (s.textContent !== t) s.textContent = t;
  }
}

