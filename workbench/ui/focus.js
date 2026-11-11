// The centre of the screen: one thing at a time, in one sentence, with at most two answers.
import { lookOf, NEEDS_YOU } from '/shared/states.mjs';
import { clip, money } from '/shared/format.mjs';
import { S, childrenOf, machineName, harnessLabel } from './model.js';
import { esc } from './util.js';

const shape = (st, live) => {
  const l = lookOf(st);
  return `<svg class="sh t-${l.tone}${live ? ' breathe' : ''}" aria-hidden="true"><use href="#s-${l.shape}"/></svg>`;
};
const btn = (label, act, extra = '', pri = false) =>
  `<button class="big${pri ? ' pri' : ''}" data-act="${act}" ${extra}>${esc(label)}</button>`;
const since = (ms, suffix = '') => `<span data-since="${ms}" data-suffix="${esc(suffix)}"></span>`;
/** Long sentences get smaller type so they still fit inside the centre circle. */
const lenClass = t => (t.length <= 38 ? '' : t.length <= 80 ? 'len-m' : t.length <= 150 ? 'len-l' : 'len-xl');

/** "Claude · Cloud 1 · <extraHtml>". Text parts are escaped; `extraHtml` is trusted markup built here. */
function metaFor(a, extraHtml) {
  const parts = [esc(harnessLabel(a.harness)), esc(a.parentId ? `helper of ${S.agents.get(a.parentId)?.name || 'an agent'}` : machineName(a.machineId))];
  if (extraHtml) parts.push(extraHtml);
  return parts.filter(Boolean).join(' · ');
}

function filesList(a) {
  const f = a.files;
  if (!f || !f.changed) return '<p class="more-text" hidden>No files changed.</p>';
  const items = (f.list || []).slice(0, 6).map(x => `<li>${esc(x.path)} <span style="color:var(--faint)">+${x.adds} −${x.dels}</span></li>`).join('');
  const rest = f.changed > 6 ? `<li style="color:var(--faint)">and ${f.changed - 6} more</li>` : '';
  return `<div class="more-text" hidden><ul>${items}${rest}</ul></div>`;
}

/** Build the centre view. Returns { sig, html }; the caller re-renders only when sig changes. */
export function focusView(f) {
  if (f.confirm) {
    const c = f.confirm;
    return {
      sig: 'confirm:' + c.id,
      html: `<div class="count">You said</div><h1 class="${lenClass(c.sentence)}">${esc(c.sentence)}</h1>${c.detail ? `<p class="meta">${esc(c.detail)}</p>` : ''}
        <div class="acts">${btn('Do it', 'confirm', 'data-go="1"', true)}${btn('Cancel', 'confirm', 'data-go="0"')}</div>`,
    };
  }
  if (f.empty) {
    const working = [...S.agents.values()].filter(a => !a.parentId && ['working', 'starting', 'waiting_helpers'].includes(a.state)).length;
    const live = S.meta.mode === 'live';
    const sub = working ? `${working} agent${working === 1 ? ' is' : 's are'} working quietly.` :
      (live ? 'Say or type what you want an agent to do, for example: start an agent to fix the flaky checkout test.' : 'Say or type what you want.');
    return {
      sig: `empty:${working}:${live}`,
      html: `<div class="count">${shape('done_checked')}All clear</div><h1>Nothing needs you.</h1><p class="meta">${esc(sub)}</p>`,
    };
  }

  const a = f.agent;
  const ask = a.ask;
  const q = f.total ? `${f.index + 1} of ${f.total} need${f.total === 1 ? 's' : ''} you` : (f.review ? 'Ready for you to look at' : lookOf(a.state).label);
  const count = `<div class="count">${shape(a.state, lookOf(a.state).live)}${esc(q)}</div>`;
  const sigBase = [a.id, a.state, ask && ask.id, a.name, a.says, a.files && a.files.changed, a.rules && a.rules.broken.length, a.checks && a.checks.state, a.now, f.total, f.index, S.reply && S.reply.agentId].join('|');
  let h1 = '', meta = '', body = '', acts = '', quiet = '';

  switch (a.state) {
    case 'needs_ok': {
      h1 = `${clip(ask?.sentence || `${a.name} needs your OK`, 140)}.`.replace(/\.\.$/, '.');
      meta = metaFor(a, `waiting ${since(ask?.createdAt || a.stateSince)}`);
      acts = btn(ask?.options?.[0] || 'Allow', 'answer', `data-answer="${esc(ask?.options?.[0] || 'Allow')}"`, true) +
             btn(ask?.options?.[1] || 'Deny', 'answer', `data-answer="${esc(ask?.options?.[1] || 'Deny')}"`);
      if (ask?.detail) { quiet = `<button class="quiet" data-act="more">What exactly?</button>`; body = `<div class="more-text" hidden><span class="detail">${esc(ask.detail)}</span></div>`; }
      break;
    }
    case 'question': {
      h1 = clip(ask?.sentence || a.says || `${a.name} has a question.`, 220);
      meta = metaFor(a, `waiting ${since(ask?.createdAt || a.stateSince)}`);
      const opts = (ask?.options || []).slice(0, 2);
      acts = opts.length ? opts.map((o, i) => btn(o, 'answer', `data-answer="${esc(o)}"`, i === 0)).join('') : btn('Answer', 'reply', 'data-mode="answer"', true);
      quiet = opts.length ? `<button class="quiet" data-act="reply" data-mode="answer">Answer in your own words</button>` : '';
      break;
    }
    case 'maybe_stuck': {
      h1 = `${a.name} might be stuck.`;
      meta = esc(ask?.sentence ? clip(ask.sentence, 120) : 'It has not made progress for a while.');
      const opts = ask?.options?.length ? ask.options.slice(0, 2) : ['Stop it', 'Let it keep trying'];
      acts = opts.map((o, i) => btn(o, 'answer', `data-answer="${esc(o)}"`, i === 0)).join('');
      quiet = `<button class="quiet" data-act="reply" data-mode="say">Give it a hint</button>`;
      break;
    }
    case 'checks_failed': {
      const failed = (a.checks?.results || []).filter(r => !r.ok).map(r => r.name);
      h1 = `${a.name} is done, but a check failed.`;
      meta = metaFor(a, failed.length ? esc(`failed: ${failed.join(', ')}`) : '');
      acts = btn('Ask it to fix that', 'fix', `data-text="${esc(`A check failed (${failed.join(', ') || 'see the output'}). Please fix it.`)}"`, true) + btn('Look later', 'reviewed');
      quiet = `<button class="quiet" data-act="more">What changed?</button>`; body = filesList(a);
      break;
    }
    case 'done_checked': case 'done_claimed': {
      h1 = a.state === 'done_checked' ? `${a.name} is done and checked.` : `${a.name} says it is done.`;
      meta = a.state === 'done_checked' ? metaFor(a, 'the workbench ran its checks') : metaFor(a, 'nothing was set up to check it');
      const broken = a.rules?.broken || [];
      if (broken.length) body += `<p class="know">One thing to know: it broke a rule you set (${esc(clip(broken[0].say, 60))}).</p>`;
      if (a.says) body += `<p class="more-text">${esc(clip(a.says, 220))}</p>`;
      acts = btn('Looks good', 'reviewed', '', true) + btn('Ask for a change', 'reply', 'data-mode="say"');
      quiet = `<button class="quiet" data-act="more">What changed?</button>`; body += filesList(a);
      break;
    }
    case 'failed': {
      h1 = `${a.name} stopped with an error.`;
      meta = esc(clip(a.error || a.stateReason || 'The agent exited unexpectedly.', 140));
      acts = a.parentId ? btn('Back', 'parent', '', true) : btn('Try again', 'fix', 'data-text="Please try again."', true) + btn('Dismiss', 'reviewed');
      break;
    }
    case 'stopped': {
      h1 = `${a.name} was stopped.`;
      meta = metaFor(a);
      acts = a.parentId ? btn('Back', 'parent', '', true) : btn('Continue', 'fix', 'data-text="Please continue where you left off."', true) + btn('Dismiss', 'reviewed');
      break;
    }
    case 'finished': {
      h1 = `${a.name} finished its part.`;
      meta = metaFor(a);
      if (a.says) body = `<p class="more-text">${esc(clip(a.says, 220))}</p>`;
      acts = btn(`Back to ${clip(S.agents.get(a.parentId)?.name || 'its agent', 24)}`, 'parent', '', true);
      break;
    }
    case 'waiting_helpers': {
      const k = childrenOf(a.id).filter(c => ['working', 'starting', 'needs_ok'].includes(c.state)).length;
      h1 = `${a.name} is waiting for ${k === 1 ? 'its helper' : `${k || 'its'} helpers`}.`;
      meta = metaFor(a, `for ${since(a.stateSince)}`);
      acts = btn('Tell it something', 'reply', 'data-mode="say"', true) + btn('Stop it', 'stop');
      break;
    }
    default: { // working, starting
      h1 = `${a.name} is working.`;
      meta = `${esc(clip(a.thinking && (!a.now || a.now === 'Thinking') ? 'Thinking' : (a.now || 'Starting'), 70))} · ${metaFor(a)}`;
      acts = btn('Tell it something', 'reply', 'data-mode="say"', true) + btn('Stop it', 'stop');
      if (a.usage?.costUsd != null && !a.parentId) quiet = `<span class="quiet" style="text-decoration:none">${esc(money(a.usage.costUsd))} so far${a.budgetUsd != null ? ` of ${esc(money(a.budgetUsd))}` : ''}</span>`;
    }
  }

  // When the person picked something that does not need them, offer the way back to what does.
  const back = f.picked && !NEEDS_YOU.has(a.state) ? `<button class="quiet" data-act="unpick" style="margin-left:14px">Back to what needs me</button>` : '';
  return {
    sig: sigBase + '|' + !!back,
    html: `${count}<h1 class="${lenClass(h1)}">${esc(h1)}</h1>${meta ? `<p class="meta">${meta}</p>` : ''}${body}<div class="acts">${acts}</div>${quiet}${back}`,
  };
}
