#!/usr/bin/env node
// Workbench: launch coding agents and see what each one is doing, in plain language.
//
//   node bin/workbench.mjs --demo [--port 4317] [--no-open]
//   node bin/workbench.mjs --repo <path> [--budget 2] [--model <name>] [--port 4317] [--no-open]
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

const USAGE = `Workbench launches coding agents and shows what each one is doing, in plain language.

Try it with simulated agents (nothing is spent):
  node bin/workbench.mjs --demo [--port 4317] [--no-open]

Run real agents on a git repository:
  node bin/workbench.mjs --repo <path> [--budget 2] [--model <name>] [--port 4317] [--no-open]

Options:
  --demo              simulated agents and machines
  --repo <path>       the git repository the agents work on (each gets its own copy)
  --budget <usd>      the most each agent may spend, in US dollars (default 2)
  --model <name>      the model to ask for
  --port <n>          the port for the web page (default 4317; 0 picks a free one)
  --no-open           do not open the browser
  --event-log <file>  also write every event to this file, one JSON object per line
  --verbose           print more about what Workbench is doing
  --help              show this help`;

// ------------------------------------------------------------------ arguments

function parseArgs(argv) {
  const out = { demo: false, repo: null, budget: null, model: null, port: DEFAULT_PORT, open: true, help: false, verbose: false, eventLog: null, error: null };
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
  const [policy, workspace, receipt] = await Promise.all([
    load('src/core/policy.mjs'), load('src/core/workspace.mjs'), load('src/core/receipt.mjs'),
  ]);
  const [claude, codex] = await Promise.all([
    loadOptional('src/adapters/claude/runner.mjs', log), loadOptional('src/adapters/codex/runner.mjs', log),
  ]);
  return { ...base, policy, workspace, receipt, claude, codex };
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
  const adapters = {};
  if (!args.demo) {
    const repoPath = path.resolve(args.repo);
    try {
      repo = await mods.workspace.prepareRepo(repoPath);
    } catch (err) {
      complain(err?.message || `Workbench could not use ${repoPath} as a git repository.`);
      return 1;
    }
    const claudeInfo = await availability(mods.claude, 'Claude Code');
    const codexInfo = await availability(mods.codex, 'Codex');
    if (claudeInfo.ok) adapters.claude = mods.claude;
    if (codexInfo.ok) adapters.codex = mods.codex;
    if (!adapters.claude && !adapters.codex) {
      complain('Workbench could not find Claude Code or Codex on this computer, so it has nothing to run.');
      complain(`  Claude Code: ${claudeInfo.reason || 'not available'}`);
      complain(`  Codex: ${codexInfo.reason || 'not available'}`);
      complain('Install one of them, or try Workbench with simulated agents using --demo.');
      return 1;
    }
    say(claudeInfo.ok ? `Claude Code${claudeInfo.version ? ' ' + claudeInfo.version : ''} is ready.` : `Claude Code is not available: ${claudeInfo.reason || 'not found'}.`);
    say(codexInfo.ok ? `Codex${codexInfo.version ? ' ' + codexInfo.version : ''} is ready.` : `Codex is not available: ${codexInfo.reason || 'not found'}.`);
  }

  const token = crypto.randomBytes(32).toString('hex');
  // Agents get only this second token: it opens /hook, never /api.
  const hookToken = crypto.randomBytes(32).toString('hex');
  const hook = { url: null, token: hookToken };
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
    deps: { policy: mods.policy, commands: mods.commands, workspace: mods.workspace, receipt: mods.receipt },
    log,
  });
  for (const ev of early.splice(0)) engine.ingest(ev);

  const server = mods.createServer({ engine, store, token, hookToken, port: args.port, host: '127.0.0.1', rootDir: ROOT, log });

  // From here on, every way out stops the agents first: orphaned agents keep spending.
  let stopping = null;
  const stopAll = (code) => {
    if (stopping) return stopping;
    stopping = (async () => {
      say('Stopping the agents and closing Workbench…');
      const force = setTimeout(() => { engine.killAllSync(); process.exit(code); }, 12_000);
      force.unref();
      try { await engine.shutdown(); } catch (err) { log.error('Shutdown failed:', err); }
      try { await server.close(); } catch (err) { log.error('Closing the server failed:', err); }
      try { store.close(); } catch { /* ignore */ }
      process.exit(code);
    })();
    return stopping;
  };
  process.on('SIGINT', () => {
    if (stopping) { // a second Ctrl-C: stop waiting
      engine.killAllSync();
      process.exit(130);
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
