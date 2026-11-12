#!/usr/bin/env node
// Workbench: launch coding agents and see what each one is doing, in plain language.
//
//   node bin/workbench.mjs --demo [--port 4317] [--no-open]
//   node bin/workbench.mjs --repo <path> [--budget 2] [--model <name>] [--claude <path>] [--port 4317] [--no-open]
//
// Wires the real modules together: store, engine, commands, policy, workspaces, receipt, machines,
// the adapters and the local web server. Every agent process is stopped when Workbench exits.
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 4317;
const DEFAULT_BUDGET_USD = 2;

/** Said instead of starting, when the variable every agent gets is set: this is an agent's own command. */
const INSIDE_AGENT = 'Workbench is running inside an agent. It will not start real agents from there.';
/** Said at the start when git has no user.name and user.email for the repository. */
const NO_GIT_IDENTITY ='Git does not know your name and email yet. Agents can work, but Workbench cannot merge their work until you set them: git config --global user.name "Your Name" and git config --global user.email you@example.com';
/** How the start says where Claude Code was found. */
const CLAUDE_FROM = { flag: ' (from --claude)', env: ' (from WORKBENCH_CLAUDE_BIN)', path: '', vscode: ' (from the VS Code extension)' };

const USAGE = `Workbench launches coding agents and shows what each one is doing, in plain language.

Try it with simulated agents (nothing is spent):
  node bin/workbench.mjs --demo [--port 4317] [--no-open]

Run real agents on a git repository:
  node bin/workbench.mjs --repo <path> [--budget 2] [--model <name>] [--claude <path>] [--port 4317] [--no-open]

Options:
  --demo              simulated agents and machines
  --repo <path>       the git repository the agents work on (each gets its own copy)
  --budget <usd>      the most each agent may spend, in US dollars (default 2)
  --model <name>      the model to ask for
  --claude <path>     the Claude Code program to run. Without it: WORKBENCH_CLAUDE_BIN, then claude on the
                      PATH, then the newest Claude Code extension in VS Code or Cursor
  --port <n>          the port for the web page (default 4317; 0 picks a free one)
  --no-open           do not open the browser
  --event-log <file>  also write every event to this file, one JSON object per line
  --verbose           print more about what Workbench is doing
  --help              show this help`;

// ------------------------------------------------------------------ arguments

function parseArgs(argv) {
  const out = { demo: false, repo: null, budget: null, model: null, claude: null, port: DEFAULT_PORT, open: true, help: false, verbose: false, eventLog: null, error: null };
  for (let i = 0; i < argv.length && !out.error; i++) {
    const raw = argv[i];
    let flag = raw;
    let inline = null;
    const eq = raw.indexOf('=');
    if (raw.startsWith('--') && eq > 2) {
      flag = raw.slice(0, eq);
      inline = raw.slice(eq + 1);
    }
    const value = () => {
      if (inline != null) return inline;
      const v = argv[i + 1];
      if (v == null || v.startsWith('--')) {
        out.error = `${flag} needs a value.`;
        return null;
      }
      i += 1;
      return v;
    };
    switch (flag) {
      case '--demo': out.demo = true; break;
      case '--repo': out.repo = value(); break;
      case '--model': out.model = value(); break;
      case '--claude': {
        const v = value();
        if (v == null) break;
        if (!v.trim()) out.error = '--claude needs the path of the Claude Code program.';
        else out.claude = v;
        break;
      }
      case '--event-log': out.eventLog = value(); break;
      case '--no-open': out.open = false; break;
      case '--verbose': out.verbose = true; break;
      case '--help': case '-h': out.help = true; break;
      case '--budget': {
        const v = value();
        if (v == null) break;
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) out.error = 'The budget must be a positive number of US dollars, like 2 or 0.5.';
        else out.budget = n;
        break;
      }
      case '--port': {
        const v = value();
        if (v == null) break;
        const n = Number(v);
        if (!/^\d+$/.test(String(v)) || n > 65535) out.error = 'The port must be a whole number from 0 to 65535.';
        else out.port = n;
        break;
      }
      default:
        out.error = `I don't know the option “${raw}”. Use --help to see the options.`;
    }
  }
  if (!out.error && !out.help) {
    if (out.demo && out.repo) out.error = 'Choose one: --demo for simulated agents, or --repo for real ones.';
    else if (!out.demo && !out.repo) {
      out.error = 'Workbench needs a git repository to work on. Run it with --repo <path to a git repository>, or try it with simulated agents using --demo.';
    }
  }
  return out;
}

// ------------------------------------------------------------------ output

function say(text) {
  process.stdout.write(text + '\n');
}

function complain(text) {
  process.stderr.write(text + '\n');
}

function createLogger(verbose) {
  const show = (a) => {
    if (a instanceof Error) return verbose ? (a.stack || a.message) : a.message;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  const write = (level, args) => {
    try { process.stderr.write(`[workbench ${level}] ${args.map(show).join(' ')}\n`); } catch { /* ignore */ }
  };
  const log = (...args) => { if (verbose) write('info', args); };
  log.info = (...args) => { if (verbose) write('info', args); };
  log.debug = (...args) => { if (verbose) write('debug', args); };
  log.warn = (...args) => write('warn', args);
  log.error = (...args) => write('error', args);
  return log;
}

// ------------------------------------------------------------------ modules

async function load(rel) {
  try {
    return await import(pathToFileURL(path.join(ROOT, rel)).href);
  } catch (err) {
    const e = new Error(`Workbench could not load ${rel}: ${err.message}`);
    e.cause = err;
    throw e;
  }
}

async function loadOptional(rel, log) {
  try {
    return await load(rel);
  } catch (err) {
    log.warn(err.message);
    return null;
  }
}

async function loadModules(demo, log) {
  const [storeMod, engineMod, httpMod, commands, machinesMod] = await Promise.all([
    load('src/core/store.mjs'),
    load('src/core/engine.mjs'),
    load('src/server/http.mjs'),
    load('src/core/commands.mjs'),
    load('src/core/machines.mjs'),
  ]);
  const base = { Store: storeMod.Store, Engine: engineMod.Engine, createServer: httpMod.createServer, commands, Machines: machinesMod.Machines };
  if (demo) {
    const sim = await load('src/adapters/sim/simulator.mjs');
    // Not needed by the simulator, but passed along when present.
    const [policy, workspace, receipt] = await Promise.all([
      loadOptional('src/core/policy.mjs', log), loadOptional('src/core/workspace.mjs', log), loadOptional('src/core/receipt.mjs', log),
    ]);
    return { ...base, Simulator: sim.Simulator, policy, workspace, receipt };
  }
  const [policy, workspace, receipt, history] = await Promise.all([
    load('src/core/policy.mjs'), load('src/core/workspace.mjs'), load('src/core/receipt.mjs'), loadOptional('src/core/history.mjs', log),
  ]);
  const [claude, codex] = await Promise.all([
    loadOptional('src/adapters/claude/runner.mjs', log), loadOptional('src/adapters/codex/runner.mjs', log),
  ]);
  return { ...base, policy, workspace, receipt, history, claude, codex };
}

/** End a reason with one full stop: reasons are often whole sentences already. */
function sentence(text) {
  const t = String(text || '').trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * The Claude Code adapter, told the --claude path when one was given. The engine calls available() and
 * createRunner() itself, and every launch looks Claude Code up again from this path.
 */
function claudeAdapter(mod, claudePath) {
  if (!mod || !claudePath) return mod;
  return {
    ...mod,
    available: (o = {}) => mod.available({ ...o, claudePath }),
    createRunner: (o = {}) => mod.createRunner({ ...o, claudePath }),
  };
}

/** Whether an adapter can run here: { ok, version?, reason? }. */
async function availability(mod, name) {
  if (!mod) return { ok: false, reason: `${name} support could not be loaded.` };
  if (typeof mod.available !== 'function' || typeof mod.createRunner !== 'function') return { ok: false, reason: `${name} support is incomplete.` };
  let timer;
  try {
    const res = await Promise.race([
      Promise.resolve().then(() => mod.available()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`checking for ${name} took too long`)), 15_000); }),
    ]);
    return res && typeof res === 'object' ? res : { ok: !!res };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function openBrowser(address) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? null : 'xdg-open';
  if (!cmd) {
    say('Open the address above in your browser.');
    return;
  }
  try {
    const child = spawn(cmd, [address], { stdio: 'ignore', detached: true });
    child.on('error', () => say('Could not open the browser. Open the address above yourself.'));
    child.unref();
  } catch {
    say('Could not open the browser. Open the address above yourself.');
  }
}

/** Exit with a code once output is flushed; force it if something keeps the process alive. */
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500).unref();
}

// ------------------------------------------------------------------ main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    say(USAGE);
    return 0;
  }
  if (args.error) {
    complain(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  // Every agent Workbench starts has WORKBENCH_AGENT_ID. An agent working on this repository could otherwise start a
  // second Workbench, whose real agents would run on the person's login without the person seeing them.
  if (!args.demo && process.env.WORKBENCH_AGENT_ID !== undefined) {
    complain(INSIDE_AGENT);
    return 2;
  }
  const log = createLogger(args.verbose);

  let mods;
  try {
    mods = await loadModules(args.demo, log);
  } catch (err) {
    complain(err.message);
    if (args.verbose && err.cause) complain(err.cause.stack || String(err.cause));
    return 1;
  }

  // Live mode: the repository and at least one harness must be there.
  let repo = null;
  let identity; // { name, email } or null from the workspace module; undefined when it could not tell
  const adapters = {};
  if (!args.demo) {
    const repoPath = path.resolve(args.repo);
    try {
      repo = await mods.workspace.prepareRepo(repoPath);
    } catch (err) {
      complain(err?.message || `Workbench could not use ${repoPath} as a git repository.`);
      return 1;
    }
    if (typeof mods.workspace.gitIdentity === 'function') {
      try {
        identity = await mods.workspace.gitIdentity({ repoRoot: repo.root });
      } catch (err) {
        log.debug('Could not read git’s name and email:', err);
      }
    }
    const claude = claudeAdapter(mods.claude, args.claude);
    const claudeInfo = await availability(claude, 'Claude Code');
    const codexInfo = await availability(mods.codex, 'Codex');
    if (claudeInfo.ok) adapters.claude = claude;
    if (codexInfo.ok) adapters.codex = mods.codex;
    if (!adapters.claude && !adapters.codex) {
      complain('Workbench could not find Claude Code or Codex on this computer, so it has nothing to run.');
      complain(`  Claude Code: ${sentence(claudeInfo.reason || 'It is not available')}`);
      complain(`  Codex: ${sentence(codexInfo.reason || 'It is not available')}`);
      complain('Install one of them, or try Workbench with simulated agents using --demo.');
      return 1;
    }
    if (claudeInfo.ok) {
      say(`Claude Code${claudeInfo.version ? ' ' + claudeInfo.version : ''} is ready${CLAUDE_FROM[claudeInfo.from] || ''}.`);
      if (claudeInfo.path) log.info(`Claude Code is ${claudeInfo.path}`);
    } else {
      say(`Claude Code is not available: ${sentence(claudeInfo.reason || 'it was not found')}`);
    }
    say(codexInfo.ok ? `Codex${codexInfo.version ? ' ' + codexInfo.version : ''} is ready.` : `Codex is not available: ${sentence(codexInfo.reason || 'it was not found')}`);
  }

  const token = crypto.randomBytes(32).toString('hex');
  // Each Claude Code agent gets its own hook token: an HMAC of its id under a key that never leaves this process.
  // A token opens /hook for that one agent only, and never /api.
  const hookKey = crypto.randomBytes(32);
  const hookTokenFor = (agentId) => crypto.createHmac('sha256', hookKey).update(`workbench-hook:${agentId}`).digest('hex');
  const hook = { url: null, tokenFor: hookTokenFor };
  const store = new mods.Store({ logPath: args.eventLog ? path.resolve(args.eventLog) : null, log });
  const machines = new mods.Machines({ demo: args.demo });

  let engine = null;
  const early = []; // simulator events emitted before the engine exists
  if (args.demo) {
    adapters.sim = new mods.Simulator({
      emit: (ev) => (engine ? engine.ingest(ev) : early.push(ev)),
      now: () => Date.now(),
      speed: 1,
      seed: 1,
    });
  }
  engine = new mods.Engine({
    store,
    mode: args.demo ? 'demo' : 'live',
    repo,
    hook,
    defaultBudgetUsd: args.budget ?? DEFAULT_BUDGET_USD,
    defaultModel: args.model || null,
    adapters,
    machines,
    deps: { policy: mods.policy, commands: mods.commands, workspace: mods.workspace, receipt: mods.receipt, history: mods.history },
    log,
  });
  for (const ev of early.splice(0)) engine.ingest(ev);

  const server = mods.createServer({ engine, store, token, hookTokenFor, port: args.port, host: '127.0.0.1', rootDir: ROOT, log });

  // From here on, every way out stops the agents first: orphaned agents keep spending.
  // The only copy of an agent's work is its own folder: every way out also says where the folders are.
  let toldKept = false;
  const tellKept = (kept, tidied) => {
    if (toldKept || !kept.length) return;
    toldKept = true;
    const one = kept.length === 1;
    // After a clean shutdown the folders with no changes are gone. A forced exit skips that, so it claims no work.
    if (tidied) say(one ? 'What the agent did stays on this computer, in its own folder:' : 'What the agents did stays on this computer, each in its own folder:');
    else say(one ? 'The agent’s folder is still on this computer:' : 'The agents’ folders are still on this computer:');
    for (const k of kept) say(`  ${k.name}: ${k.path}${k.branch ? ` (branch ${k.branch})` : ''}`);
  };
  /** Exit once what was said has reached the terminal or a pipe, or after half a second. */
  const exitAfterOutput = (code) => {
    process.exitCode = code;
    process.stdout.write('', () => process.exit(code));
    setTimeout(() => process.exit(code), 500).unref();
  };
  let forcing = false;
  /** Stop waiting (a second Ctrl-C, or 12 seconds): end every agent and check now, say where the folders are, exit. */
  const forceExit = (code) => {
    if (forcing) { process.exit(code); return; } // asked again while the words go out
    forcing = true;
    try { engine.killAllSync(); } catch (err) { log.error('Could not stop everything:', err); }
    let kept = [];
    try { kept = engine.keptFolders(); } catch (err) { log.error('Could not list the agent folders:', err); }
    tellKept(kept, false);
    exitAfterOutput(code);
  };
  let stopping = null;
  const stopAll = (code) => {
    if (stopping) return stopping;
    stopping = (async () => {
      say('Stopping the agents and closing Workbench…');
      const force = setTimeout(() => forceExit(code), 12_000);
      force.unref();
      let kept = [];
      try { kept = (await engine.shutdown())?.kept || []; } catch (err) { log.error('Shutdown failed:', err); }
      try { await server.close(); } catch (err) { log.error('Closing the server failed:', err); }
      try { store.close(); } catch { /* ignore */ }
      if (forcing) return; // a forced exit is already on its way out
      tellKept(kept, true);
      exitAfterOutput(code);
    })();
    return stopping;
  };
  process.on('SIGINT', () => {
    if (stopping) { // a second Ctrl-C: stop waiting
      forceExit(130);
      return;
    }
    stopAll(0);
  });
  process.on('SIGTERM', () => stopAll(0));
  process.on('SIGHUP', () => stopAll(0));
  process.on('exit', () => {
    try { engine.killAllSync(); } catch { /* ignore */ }
  });
  process.on('uncaughtException', (err) => {
    log.error('Unexpected error:', err);
    stopAll(1);
  });
  process.on('unhandledRejection', (err) => {
    log.error('Unexpected error:', err);
  });

  let url;
  try {
    ({ url } = await server.listen());
  } catch (err) {
    if (err.code === 'EADDRINUSE') complain(`Port ${args.port} is already in use. Try another one with --port, or --port 0 to pick a free one.`);
    else if (err.code === 'EACCES') complain(`Workbench is not allowed to use port ${args.port}. Try another one with --port, or --port 0.`);
    else complain(`Workbench could not start its web page: ${err.message}`);
    await engine.shutdown().catch(() => {});
    return 1;
  }
  hook.url = new URL('hook/pretool', url).href;

  try {
    await engine.start();
  } catch (err) {
    complain(err?.message || 'Workbench could not start.');
    await engine.shutdown().catch(() => {});
    await server.close().catch(() => {});
    return 1;
  }

  const address = `${url}?t=${token}`;
  say(`Workbench is running at ${address}`);
  if (args.demo) {
    say('This is the demo: the agents and cloud machines are simulated, and nothing is spent.');
  } else {
    say(`Agents work on ${repo.name || 'your repository'}, each in its own copy made from the last commit.`);
    const dirty = Number(repo.dirty) || 0;
    if (dirty) say(`Your ${dirty} uncommitted change${dirty === 1 ? ' is' : 's are'} not included.`);
    say(`Each agent can spend up to $${(args.budget ?? DEFAULT_BUDGET_USD).toFixed(2)}.`);
    if (identity === null) say(NO_GIT_IDENTITY);
  }
  say('Press Ctrl-C to stop.');
  if (args.open) openBrowser(address);
  return null; // keep running
}

main().then(
  (code) => { if (code != null) finish(code); },
  (err) => {
    complain(`Workbench stopped because of an unexpected error: ${err?.message || err}`);
    finish(1);
  },
);
