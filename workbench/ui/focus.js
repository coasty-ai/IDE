// The core's lid: one thing at a time, in one sentence, with at most two answers.
// lidView() only builds markup; app.js decides when to swap or patch it. Every button carries what it was drawn for
// (data-agent, data-ask, data-confirm, data-state, and for an agent's work data-work and data-into), so a click acts on
// exactly what the person read.
import { clip, money, duration } from '/shared/format.mjs';
import { LOOK, ACTIVE } from '/shared/states.mjs';
import { S, machineName, harnessLabel, mergeApplies, gitReason, canReview, workKey, workSettled, unmergedWork } from './model.js';
import { markOfAgent } from './look.js';
import { spentWords } from './numbers.js';
import { visibleControls, clipMiddle, cutMiddle, whoAsks, headlineClass } from './words.js';
import { esc } from './util.js';
import { agoText } from './boardmodel.js';
import { lidConnectWords } from './connectview.js';

const mark = (shape, tone) => `<svg class="g k-${tone}" viewBox="0 0 12 12" aria-hidden="true"><use href="#g-${shape}"/></svg>`;
// "waiting 4 min": whole minutes only, so the lid does not tick every second while something waits ("asked just now" first)
const sinceText = (ms, prefix, fresh, suffix = '') => { const age = Date.now() - (Number(ms) || 0); return age < 60000 ? fresh : prefix + (duration(age) || 'a moment') + suffix; };
const since = (ms, prefix = '', fresh = 'just now', suffix = '') => `<span data-since="${Number(ms) || 0}" data-prefix="${esc(prefix)}" data-fresh="${esc(fresh)}"${suffix ? ` data-suffix="${esc(suffix)}"` : ''}>${esc(sinceText(ms, prefix, fresh, suffix))}</span>`;
const attrs = o => Object.entries(o).filter(([, v]) => v != null && v !== false).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');

// What an agent controls reaches the lid with every character that hides text or turns it shown by the one rule
// (visibleControls in words.js): its name, paths, branches, what it says and asks, the words of its answers, its checks'
// names and its helpers' names. Prose has its ordinary spacing evened out first, so a line break in a question reads as
// a space, not as ⏎ (a command keeps its ⏎). A button still sends the agent's own words (data-answer, data-text).
const prose = s => visibleControls(String(s ?? '').split(/[\t\n\v\f\r ]+/).filter(Boolean).join(' '));
/** clip() for text already shown that way: a cut never leaves half of a character's code ("⟦U+20…"). */
function clipShown(text, n) {
  const c = clip(text, n), open = c.lastIndexOf('⟦');
  return open >= 0 && open > c.lastIndexOf('⟧') ? c.slice(0, open).replace(/[,.;:\s]+$/, '') + '…' : c;
}

/** A big answer button. `d` becomes data-* attributes (act, agent, ask, answer, confirm, …); `extra` is more markup (a title). */
function bigButton(label, d, pri = false, extra = '') {
  return `<button type="button" class="big${pri ? ' pri' : ''}"${attrs({ ...d, key: `${d.act}:${label}` })}${extra}>${esc(label)}</button>`;
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
  const items = (f.list || []).slice(0, 6).map(x => `<li>${esc(visibleControls(x.path))} <span>+${x.adds} −${x.dels}</span>${x.ignored ? ' <em>(hidden by a .gitignore it changed)</em>' : ''}</li>`).join('');
  const rest = f.changed > 6 ? `<li>and ${f.changed - 6} more</li>` : '';
  return `<div class="more-text"><ul>${items}${rest}</ul></div>`;
}

/** Paths a merge named (both changed, or in the way): the first `n`, each cut in the middle, control and bidi characters shown. */
function pathsText(paths, n, max) {
  const shown = paths.slice(0, n).map(p => visibleControls(cutMiddle(p, max)));
  return shown.join(', ') + (paths.length > n ? ` and ${paths.length - n} more` : '');
}

/** A branch name on a button: cut in the middle past 16 characters; the button's title then holds all of it. */
const branchLabel = b => visibleControls(cutMiddle(b, 16));
const branchTitle = (words, b) => (Array.from(String(b)).length > 16 ? ` title="${esc(words + visibleControls(b))}"` : '');

/** The count line of an engine card follows what it is about. */
const CARD_COUNT = { merge: 'Before it merges', discard: 'Before it is thrown away', forget: 'Before it is forgotten' };
/** Why an agent at its spending limit stopped, in the engine's words (its reason for Claude Code's error_max_budget_usd). */
const LIMIT_REASON = 'It reached its spending limit.';

/**
 * Where a root's work went, when that is what the lid is about: thrown away, a merge that did not go through, merged
 * with nothing new. An agent from an earlier run keeps its own lid (Continue, Forget): the git screen shows its work.
 */
function workLid(a) {
  const w = a.work;
  if (!w || a.parentId || a.earlier || ACTIVE.has(a.state)) return null;
  if (w.thrownAway) return 'thrown';
  if (w.problem) return 'problem';
  if (w.merged && workSettled(a)) return 'merged';
  return null;
}
const WORK_COUNT = { thrown: 'thrown away', problem: 'not merged', merged: 'merged' };

/**
 * The lid's key: what it shows (the confirm card, nothing, or an agent in a state with an ask) and, for an agent's work,
 * where that went (merged, a problem, thrown away). A new key swaps the page and arms the click guard; the same key is
 * patched in place. app.js uses this too, so the two never disagree.
 */
export function focusKey(f) {
  if (f.confirm) return 'confirm:' + f.confirm.id;
  if (f.empty) return f.connect ? 'connect' : 'empty';
  const a = f.agent, wk = workKey(a);
  return `${a.id}|${a.state}|${a.ask ? a.ask.id : ''}${wk ? '|' + wk : ''}`;
}

/** "Claude · Cloud 1 · <extra>" in "more"; just the extra (and whose helper it is) when calm. */
function metaLine(a, extraHtml, more) {
  const parent = a.parentId ? S.agents.get(a.parentId) : null;
  const whose = parent ? esc(`helper of ${visibleControls(parent.name)}`) : '';
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
 * An agent's work keeps its words at every step: "Review the changes" and the other links about its work, the paths a
 * merge named (3 of them, 2 at the last step), why git cannot merge it (its first sentence at the last step), and what a
 * merge or throw-away card says (under "See all of it" at the last step).
 */
export function fitSteps(fit) {
  return {
    hDown: Math.min(3, fit), meta: fit >= 3 ? 0 : fit >= 2 ? 1 : 2, longCut: fit >= 6 ? 140 : fit >= 4 ? 190 : Infinity,
    cmd: fit >= 6 ? 72 : 160, why: fit >= 6 ? 60 : Infinity, extras: fit < 5, tight: fit >= 5, close: fit >= 5,
    paths: fit >= 6 ? 2 : 3, pathMax: fit >= 6 ? 32 : 48, last: fit >= 6,
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
  const big = (label, d, pri, extra) => { labels.push(label); return bigButton(label, d, pri, extra); };
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
    return { html: open.all ? readAllBox(h1(text)) : h1(clipShown(text, fs.longCut)), toggle, done };
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
    // An engine card: a launch (or a stop or message whose words named no agent) the person typed or said, or a card a
    // button asked for (forget, merge, throw away). Its own words for yes and no; a dangerous one has no default answer.
    const c = f.confirm;
    const words = CARD_COUNT[c.kind] || 'You said';
    // its words name branches, paths and tasks: anything that could hide or turn text is shown
    const sentence = visibleControls(c.sentence), detail = c.detail ? visibleControls(c.detail) : '';
    const t = long(sentence);
    // A card about an agent's work keeps what it says at every fit step but the last, where it goes under "See all of it":
    // a merge's counts and checks, and what a throw-away deletes, are what the person decides on.
    const keep = !!c.danger || c.kind === 'merge' || c.kind === 'discard';
    let msg = '';
    if (detail && !keep) msg = fs.meta ? metaP(esc(detail)) : '';
    else if (detail && !fs.last) msg = metaP(esc(detail));
    else if (detail) msg = (open.exact ? readAllBox(metaP(esc(detail))) : '') + quiet(open.exact ? 'Show less' : 'See all of it', { act: 'exact' }, ` aria-expanded="${!!open.exact}"`);
    return {
      key: focusKey(f), idle: false, count: words, say: `${words}: ${sentence} ${detail}`.trim(), bind: { confirmId: c.id },
      html: page(countLine('ask', c.danger ? 'stuck' : 'work', words), t.html,
        { msg,
          acts: big(c.yes || 'Do it', { act: 'confirm', confirm: c.id, go: '1' }, !c.danger) + big(c.no || 'Cancel', { act: 'confirm', confirm: c.id, go: '0' }),
          after: t.toggle }),
    };
  }

  if (f.empty) {
    const working = [...S.agents.values()].filter(a => !a.parentId && ['working', 'starting', 'waiting_helpers'].includes(a.state)).length;
    const aside = f.aside || [];
    const sub = working ? `${working} agent${working === 1 ? ' is' : 's are'} working quietly.`
      : S.agents.size ? 'Say or type what you want.' : 'Say or type what you want an agent to do, for example “start an agent to fix the flaky checkout test”.';
    const asideBtn = aside.length ? quiet(`Look at ${clipShown(visibleControls(aside[0].name), 28)} now`, { act: 'pick', agent: aside[0].id }) : '';
    if (f.connect) {
      // No coding agent can start work yet (meta.connect.ready is false): the lid says so, with the way to connect one.
      // Its Connect button opens Agents & keys (app.js); it acts on nothing, so the swap guard does not hold it.
      const w = lidConnectWords(f.connect);
      return {
        key: 'connect', idle: false, count: w.count, say: `${w.sentence} ${w.sub}`, bind: {},
        html: page(countLine('need', 'need', w.count), h1(w.sentence), { msg: fs.meta ? metaP(esc(w.sub)) : '', acts: big('Connect', { act: 'connect' }, true), after: asideBtn }),
      };
    }
    const count = aside.length ? `${aside.length} set aside` : 'All clear';
    return {
      key: 'empty', idle: true, count, say: `${count}. Nothing needs you.`, bind: {},
      html: page(countLine('ok', 'ok', count), h1('Nothing needs you.'), { msg: fs.meta ? metaP(esc(sub)) : '', after: asideBtn }),
    };
  }

  const a = f.agent;
  const ask = a.ask;
  const nm = visibleControls(a.name);
  const parentName = p0 => visibleControls(p0 ? p0.name : '');
  const m = markOfAgent(a, LOOK);
  const parent = a.parentId ? S.agents.get(a.parentId) : null;
  const inQueue = f.total != null && !f.review;
  const earlierRoot = !!a.earlier && !a.parentId;
  const wl = workLid(a);
  const countWords = inQueue ? `${f.index + 1} of ${f.total} need${f.total === 1 ? 's' : ''} you`
    : f.review ? (f.total > 1 ? `${f.index + 1} of ${f.total} to look at` : 'Ready for you to look at')
    : wl && !earlierRoot ? WORK_COUNT[wl] : m.label;
  const waited = ask?.createdAt || a.stateSince;
  const id = { agent: a.id };
  const withAsk = ask ? { agent: a.id, ask: ask.id } : id;
  const st = { agent: a.id, state: a.state };
  const step = (inQueue || f.review) && f.total > 1 ? `<button type="button" class="step" data-act="next" data-key="next" aria-label="Show the next one (or press the right arrow)">next</button>` : '';
  let count = `<div class="count"><span class="who">${mark(m.shape, m.tone)}<span>${esc(countWords)}</span></span>${step}</div>`;
  let sentence = null, msg = '', acts = '', after = '', spoken = null;
  // the meta line: everything in "more", the essentials when calm, nothing once the lid is short of room
  const meta = (extraHtml, essentials = extraHtml) => metaP(fs.meta === 2 && more ? metaLine(a, extraHtml, true) : fs.meta ? metaLine(a, essentials, false) : '');

  // An agent's work. Buttons about it carry its signature (data-work) as well as the state, and Merge the branch it was
  // drawn for (data-into), so one drawn before an outcome, or before the person changed branch, cannot act after it.
  // Its links sit in one row under the answers, at every fit step and in calm too.
  const wk = workKey(a);
  const into = S.meta.repo?.branch || null;
  const links = [];
  let leaves = false;   // the lid has its own way to let this item go ("Not now", "Look later", "Dismiss")
  // "Review the changes" (the git screen, on its branch and its diff): its branch and folder are there, and it may hold
  // work that is not merged yet (nothing counted its files, or some changed)
  const reviewable = canReview(a) && (unmergedWork(a) || !a.files);
  const reviewLink = () => quiet('Review the changes', { act: 'review', ...st, work: wk });
  const mergeButton = () => big(`Merge into ${branchLabel(into)}`, { act: 'merge', ...st, work: wk, into }, true, branchTitle('Merge into ', into));

  switch (wl || (earlierRoot ? 'earlier' : a.state)) {
    case 'thrown': {
      // the person threw its work away (a hidden copy stays in git): nothing more to do with it here
      sentence = `${nm}’s work was thrown away.`;
      if (fs.meta) msg += metaP(esc('Workbench keeps a hidden copy in git.'));
      acts = big('Dismiss', { act: 'reviewed', ...st, work: wk }, true);
      leaves = true;
      break;
    }
    case 'problem': {
      // a merge that did not go through, until it clears (a merge that works, a new turn, a message it takes)
      const p = a.work.problem;
      const paths = (Array.isArray(p.paths) ? p.paths : []).filter(x => typeof x === 'string' && x);
      const listed = pathsText(paths, fs.paths, fs.pathMax);
      // the branch the merge went into, when the engine says; else where the next merge would go
      const target = (typeof p.into === 'string' && p.into) || into || a.work.from || null;
      if (p.why === 'conflict') {
        sentence = `${nm}’s work does not merge cleanly into ${target ? visibleControls(target) : 'your branch'}.`;
        if (paths.length) msg += metaP(esc(`Both changed: ${listed}`));
        const all = paths.slice(0, 20).join(', ') + (paths.length > 20 ? ` and ${paths.length - 20} more` : '');
        const text = target
          ? `Your work conflicts with the latest ${target}${paths.length ? ` in: ${all}` : ''}. Please merge ${target} into your branch, resolve the conflicts, and finish.`
          : `Your work conflicts with my latest work${paths.length ? ` in: ${all}` : ''}. Please merge my branch into yours, resolve the conflicts, and finish.`;
        acts = big(`Ask it to bring in ${target ? branchLabel(target) : 'my work'}`, { act: 'fix', ...st, work: wk, text }, true, target ? branchTitle('Ask it to bring in ', target) : '')
          + big('Look later', { act: 'later', ...st, work: wk });
      } else if (p.why === 'blocked') {
        sentence = 'Your own changes are in the way.';
        if (paths.length) msg += metaP(esc(`In the way: ${listed}`));
        if (fs.meta) msg += metaP(esc(`Commit or put them aside, then merge ${nm} again.`));
        acts = big('Try again', { act: 'merge', ...st, work: wk, into }, true) + big('Not now', { act: 'later', ...st, work: wk });
      } else {
        // the engine's own words: the first sentence as the headline, what to do under it ("main changed since you
        // looked." / "Have another look."); a screen reader gets all of it
        spoken = prose(p.sentence || `${a.name}’s work could not be merged.`);
        const two = /^(.+?[.!?])\s+(?=[A-Z])(.+)$/s.exec(spoken);
        sentence = long(two ? two[1] : spoken);
        if (two) msg += metaP(esc(two[2]));
        if (paths.length) msg += metaP(esc(listed));
        acts = big('Try again', { act: 'merge', ...st, work: wk, into }, true) + big('Not now', { act: 'later', ...st, work: wk });
      }
      if (reviewable) links.push(reviewLink());
      leaves = true;
      break;
    }
    case 'merged': {
      // merged, with nothing new since: it is out of the review queue, so this shows when the person picks it
      const mg = a.work.merged;
      sentence = `${nm}’s work is in ${visibleControls(mg.into || into || 'your branch')}.`;
      const n = Number(mg.files) || 0;
      if (fs.meta) msg += metaP(`${mg.at ? since(mg.at, 'Merged ', 'Merged just now', ' ago') : 'Merged'}${n ? esc(` · ${n} file${n === 1 ? '' : 's'}`) : ''}`);
      acts = big('See it in git', { act: 'review', ...st, work: wk }, true) + big('Ask for a change', { act: 'reply', ...st, mode: 'say' });
      break;
    }
    case 'earlier': {
      // Restored from history: it has no process. It can be picked up where it left off (a new spending limit for this
      // run), or forgotten; either way what it did stays in its folder.
      const ended = { done_checked: 'was done and checked', done_claimed: 'said it was done', checks_failed: 'was done, but a check failed', failed: 'stopped with an error', stopped: 'was stopped' }[a.state] || 'ran earlier';
      sentence = `${nm} ${ended}.`;
      const budget = S.meta.defaultBudgetUsd;
      const note = a.canContinue
        ? (budget ? `It would get a new spending limit of ${money(budget)} for this run.` : 'It would pick up where it left off.')
        : (prose(a.continueReason) || 'It cannot continue.');
      msg += metaP(esc(`${agoText(Date.now() - (a.endedAt || a.stateSince))}${fs.meta && a.says ? ` · ${clipShown(prose(a.says), more ? 110 : 70)}` : ''}`));
      if (fs.meta) msg += metaP(esc(note));
      acts = (a.canContinue ? big('Continue', { act: 'fix', ...st, text: 'Please continue where you left off.' }, true) : '')
        + big('Forget', { act: 'forget', ...st }, !a.canContinue);
      // its folder is still there: what it changed can be looked at (merge and throw-away are in the git screen's detail)
      if (reviewable) links.push(reviewLink());
      break;
    }
    case 'needs_ok': {
      sentence = `${prose(ask?.sentence || `${a.name} needs your OK`).replace(/[.\s]+$/, '')}.`;
      // Security over calm: the exact command or path, always, with the check's own reason.
      const full = ask?.detail ? visibleControls(ask.detail) : '';
      const cm = clipMiddle(full, fs.cmd);
      const whyFull = prose(ask?.why);
      const whyShown = whyFull.length > fs.why ? clipShown(whyFull, fs.why) : whyFull;
      const cut = cm.clipped || whyShown !== whyFull;
      if (full) {
        const toggle = cut ? `<button type="button" class="quiet" data-act="exact" data-key="exact" aria-expanded="${!!open.exact}">${open.exact ? 'Show less' : 'See all of it'}</button>` : '';
        const code = open.exact && cut
          ? `<code class="all" tabindex="0" data-scroll="1" aria-label="The exact command, in full">${esc(full)}${whyFull ? `\n\n${esc(whyFull)}` : ''}</code>`
          : `<code>${esc(cm.text)}</code>`;
        msg += `<div class="exact${fs.close ? ' close' : ''}">${code}${toggle}</div>`;
      }
      if (whyFull && !(open.exact && cut)) msg += `<p class="why${fs.close ? ' close' : ''}">${esc(whyShown)}</p>`;
      msg += fs.meta ? meta(since(waited, 'waiting ', 'asked just now')) : parent ? metaP(esc(`helper of ${parentName(parent)}`)) : '';
      const opts = ask?.options?.length ? ask.options.slice(0, 2) : ['Allow', 'Deny'];
      // Allow and Deny carry equal weight: the person reads before answering.
      acts = opts.map(o2 => big(prose(o2), { act: 'answer', ...withAsk, answer: o2 })).join('');
      break;
    }
    case 'question': {
      const who = whoAsks(parent ? `${parentName(parent)}’s helper` : nm, inQueue ? f.index : 0, inQueue ? f.total : 1, o.whoMax ? o.whoMax(inQueue ? f.total : 1) : 28);
      count = `<div class="count"><span class="who">${mark(m.shape, m.tone)}<span>${esc(who)}</span></span>${step}</div>`;
      const t = long(prose(ask?.sentence || a.says || `${a.name} has a question.`));
      sentence = t;
      msg += meta(since(waited, 'waiting ', 'asked just now'));
      const opts = (ask?.options || []).slice(0, 2);
      acts = opts.length ? opts.map((o2, i) => big(prose(o2), { act: 'answer', ...withAsk, answer: o2 }, i === 0)).join('')
        : big('Answer', { act: 'reply', ...withAsk, mode: 'answer' }, true);
      if (opts.length && more && fs.extras) after = quiet('Answer in your own words', { act: 'reply', ...withAsk, mode: 'answer' });
      // a live question comes with what the agent changed so far
      if (more && fs.extras && a.files?.changed) after += quiet(open.changed ? 'Hide the changes' : 'What changed?', { act: 'changed' }, ` aria-expanded="${!!open.changed}"`) + (open.changed ? filesList(a) : '');
      break;
    }
    case 'maybe_stuck': {
      if (ask?.about === 'background') {
        // not stuck: it finished, but something it started still runs ("It is done" / "Keep waiting")
        sentence = `${prose(ask.sentence || `${a.name} has finished, but something it started is still running`).replace(/[.\s]+$/, '')}.`;
        const work = prose(String(ask.detail || '').split('\n').map(x => x.trim()).filter(Boolean).join(' · '));
        if (work) msg += metaP(esc(clipShown(work, fs.meta ? 110 : 70)));
        const opts = ask.options?.length ? ask.options.slice(0, 2) : ['It is done', 'Keep waiting'];
        acts = opts.map((o2, i) => big(prose(o2), { act: 'answer', ...withAsk, answer: o2 }, i === 0)).join('');
        break;
      }
      sentence = `${nm} might be stuck.`;
      // the agent's own name is matched as it is, before anything in the sentence is shown
      const why = ask?.sentence ? ask.sentence.replace(new RegExp('^' + String(a.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' has'), 'It has') : 'It has not made progress for a while.';
      msg += metaP(esc(clipShown(prose(why), fs.meta ? 110 : 70)));
      if (more && ask?.detail && fs.meta === 2) msg += `<p class="why">${esc(clipShown(prose(ask.detail), 160))}</p>`;
      const opts = ask?.options?.length ? ask.options.slice(0, 2) : ['Stop it', 'Let it keep trying'];
      acts = opts.map((o2, i) => big(prose(o2), { act: 'answer', ...withAsk, answer: o2 }, i === 0)).join('');
      if (more && fs.extras) after = quiet('Give it a hint', { act: 'reply', ...withAsk, mode: 'answer' });
      break;
    }
    case 'checks_failed': {
      const failed = (a.checks?.results || []).filter(r => !r.ok).map(r => r.name);
      sentence = `${nm} is done, but a check failed.`;
      const what = failed.length ? esc(`failed: ${clipShown(failed.map(prose).join(', '), 60)}`) : '';
      msg += fs.meta ? meta(what) : metaP(what);
      acts = big('Ask it to fix that', { act: 'fix', ...st, text: `A check failed (${failed.join(', ') || 'see the output'}). Please fix it.` }, true)
        + big('Look later', { act: 'later', ...st });
      // its work can be looked at, and merged anyway (through the same card, whose words name the failed check)
      if (mergeApplies(a)) links.push(reviewLink(), quiet('Merge anyway', { act: 'merge', ...st, work: wk, into }));
      else if (reviewable) links.push(reviewLink());
      else if (more && fs.extras) after = quiet(open.changed ? 'Hide the changes' : 'What changed?', { act: 'changed' }, ` aria-expanded="${!!open.changed}"`) + (open.changed ? filesList(a) : '');
      break;
    }
    case 'done_checked': case 'done_claimed': {
      sentence = a.state === 'done_checked' ? `${nm} is done and checked.` : `${nm} says it is done.`;
      const broken = a.rules?.broken || [];
      if (broken.length) msg += `<p class="know">One thing to know: it broke a rule you set (${esc(clipShown(prose(broken[0].say), 60))}).</p>`;
      if (a.says && fs.meta) msg += metaP(esc(clipShown(prose(a.says), more && fs.meta === 2 ? 200 : 110)));
      else if (more && fs.meta === 2) msg += meta(a.state === 'done_checked' ? 'its checks passed' : 'nothing checked it');
      if (mergeApplies(a)) {
        // its work can go into the person's branch: Merge (always through the engine's card) or a change; "Not now" does
        // what "Looks good" did, and "Review the changes" opens its diff in the git screen
        acts = mergeButton() + big('Ask for a change', { act: 'reply', ...st, mode: 'say' });
        links.push(reviewLink(), quiet('Not now', { act: 'looksgood', ...st, answer: 'Not now' }));
        leaves = true;
      } else {
        // not here (the demo, no git, nothing to merge), or git cannot (not on a branch, no name and email): say which
        const why = gitReason(a);
        if (why) msg += `<p class="meta git">${esc(fs.last ? why.replace(/^(.*?\.)\s.*$/, '$1') : why)}</p>`;
        acts = big('Looks good', { act: 'looksgood', ...st, answer: 'Looks good' }, true) + big('Ask for a change', { act: 'reply', ...st, mode: 'say' });
        if (reviewable) links.push(reviewLink());
        else if (more && fs.extras) after = quiet(open.changed ? 'Hide the changes' : 'What changed?', { act: 'changed' }, ` aria-expanded="${!!open.changed}"`) + (open.changed ? filesList(a) : '');
      }
      break;
    }
    case 'failed': {
      sentence = `${nm} stopped with an error.`;
      // A Claude Code agent stopped by its spending limit: "Try again" would find none of it left, so it is given the run's
      // limit once more (the engine checks again) and continues where it left off. The line under the sentence says why it
      // stopped in the engine's words, also when its process then exited with an error of its own.
      const budget = S.meta.defaultBudgetUsd;
      const atLimit = a.atLimit === true && a.harness === 'claude' && S.meta.mode === 'live' && budget > 0;
      msg += metaP(esc(clipShown(prose(atLimit ? LIMIT_REASON : (a.error || a.stateReason || 'The agent exited unexpectedly.')), fs.meta ? 120 : 70)));
      acts = a.parentId ? big('Back', { act: 'parent', ...id }, true)
        : (atLimit ? big(`Give it ${money(budget)} more`, { act: 'raise', ...st }, true) : big('Try again', { act: 'fix', ...st, text: 'Please try again.' }, true))
          + big('Dismiss', { act: 'reviewed', ...st });
      if (reviewable) links.push(reviewLink());
      break;
    }
    case 'stopped': {
      sentence = `${nm} was stopped.`;
      if (more && fs.meta === 2) msg += meta('');
      acts = a.parentId ? big('Back', { act: 'parent', ...id }, true)
        : big('Continue', { act: 'fix', ...st, text: 'Please continue where you left off.' }, true) + big('Dismiss', { act: 'reviewed', ...st });
      if (reviewable) links.push(reviewLink());
      break;
    }
    case 'finished': {
      sentence = `${nm} finished its part.`;
      if (a.says && fs.meta) msg += metaP(esc(clipShown(prose(a.says), more && fs.meta === 2 ? 200 : 110)));
      acts = big(`Back to ${clipShown(parent ? parentName(parent) : 'its agent', 24)}`, { act: 'parent', ...id }, true);
      break;
    }
    case 'waiting_helpers': {
      // what it waits for, in the engine's words ("Waiting for a background command"), never a count of helper views:
      // it may be waiting on a command it left running
      const w = /^waiting for /i.test(a.now || '') ? a.now.replace(/^waiting for /i, '').replace(/[.\s]+$/, '') : '';
      sentence = `${nm} is waiting for ${prose(w) || 'its background work'}.`;
      msg += meta(since(a.stateSince, 'for '));
      acts = big('Tell it something', { act: 'reply', ...st, mode: 'say' }, true) + big('Stop it', { act: 'stop', ...st });
      break;
    }
    default: { // working, starting
      sentence = `${nm} is working.`;
      const now = prose(a.thinking && (!a.now || a.now === 'Thinking') ? 'Thinking' : (a.now || 'Starting'));
      msg += fs.meta === 2 && more ? metaP(`${esc(clipShown(now, 70))} · ${metaLine(a, '', true)}`) : metaP(esc(clipShown(now, 70)));
      acts = big('Tell it something', { act: 'reply', ...st, mode: 'say' }, true) + big('Stop it', { act: 'stop', ...st });
      if (more && fs.extras && !a.parentId && a.usage) { const sw = spentWords(a.usage, money, a.harness); after = metaP(esc(/^not reported/.test(sw) ? `cost ${sw}` : `${sw} so far${a.budgetUsd != null ? ` of ${money(a.budgetUsd)}` : ''}`)); }
    }
  }
  if (earlierRoot) count = `<div class="count"><span class="who">${mark(m.shape, m.tone)}<span>From an earlier run</span></span></div>`;
  // Something the person picked that does not need them: the way back to what does (not when the lid already has its own
  // way to let it go and nothing else waits).
  if (f.picked && !inQueue && !f.review && !(leaves && !f.queued)) {
    const back = quiet(f.queued ? 'Back to what needs me' : 'Close', { act: 'unpick' });
    if (links.length) links.push(back); else after += back;
  }
  if (links.length) after += `<div class="links">${links.join('')}</div>`;
  const head = typeof sentence === 'string' ? { html: h1(sentence), toggle: '' } : sentence;
  const text = spoken ?? (typeof sentence === 'string' ? sentence : prose(ask?.sentence || a.says || ''));
  const say = `${inQueue || f.review ? countWords + '. ' : ''}${text}${ask?.detail && a.state === 'needs_ok' ? ' It will run: ' + clipShown(visibleControls(ask.detail), 160) + '.' : ''}`;
  return {
    key: focusKey(f), idle: false, count: countWords, say,
    bind: { agentId: a.id, askId: ask ? ask.id : null },
    html: page(count, head.html, { msg, acts, after: head.toggle + after }),
  };
}

/** Refresh the "waiting 4 min" style counters inside an element, in place. Their words change at most once a minute. */
export function tickSince(root) {
  for (const s of root.querySelectorAll('[data-since]')) {
    const t = sinceText(s.dataset.since, s.dataset.prefix || '', s.dataset.fresh || 'just now', s.dataset.suffix || '');
    if (s.textContent !== t) s.textContent = t;
  }
}

