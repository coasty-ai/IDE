// The CLI's argument handling. These cases all stop before any module is loaded,
// so no agent, simulator or server ever starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/workbench.mjs', import.meta.url));

function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { timeout: 10_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test('without --repo or --demo it explains what it needs', async () => {
  const r = await run([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Workbench needs a git repository to work on\. Run it with --repo/);
  assert.match(r.stderr, /--demo/);
});

test('--help prints the usage and exits cleanly', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /node bin\/workbench\.mjs --demo \[--port 4317\] \[--no-open\]/);
  assert.match(r.stdout, /node bin\/workbench\.mjs --repo <path> \[--budget 2\] \[--model <name>\]/);
});

test('bad options get plain messages', async () => {
  const cases = [
    [['--demo', '--port', 'abc'], /The port must be a whole number from 0 to 65535/],
    [['--demo', '--port=70000'], /The port must be a whole number/],
    [['--demo', '--repo', '.'], /Choose one: --demo/],
    [['--demo', '--bogus'], /I don't know the option “--bogus”/],
    [['--repo', '.', '--budget', '-1'], /The budget must be a positive number/],
    [['--repo'], /--repo needs a value/],
    [['--repo', '--demo'], /--repo needs a value/],
  ];
  for (const [args, message] of cases) {
    const r = await run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
  }
});
