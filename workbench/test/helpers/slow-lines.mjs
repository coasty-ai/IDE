// The command lines on which a permission check once took seconds on Workbench's main thread, and the agent's folder they
// are checked in. policy.test.mjs and engine.test.mjs hold each check to 250 ms, with full permissions on and off.
import fs from 'node:fs';
import path from 'node:path';

const rep = (n, f, sep = ' && ') => Array.from({ length: n }, (_, i) => f(i)).join(sep);
const upTo64k = unit => { let s = ''; for (let i = 0; s.length < 65536; i++) s += unit(i); return s; };

/**
 * Fills `dir`, an agent's folder, for the lines below: 200 packages (pkg0 to pkg199), 120 more folders (d0 to d59, e0 to
 * e59), a folder of 5,000 files (dir/prefix0.txt to dir/prefix4999.txt), a .claude folder, and a chain of 40 links
 * (links/l0 to links/l39, then links/target), more links in a row than the system follows.
 */
export function slowFolder(dir) {
  for (const d of ['.claude', 'dir', 'links/target']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  for (let i = 0; i < 200; i++) fs.mkdirSync(path.join(dir, `pkg${i}`));
  for (let i = 0; i < 60; i++) { fs.mkdirSync(path.join(dir, `d${i}`)); fs.mkdirSync(path.join(dir, `e${i}`)); }
  for (let i = 0; i < 5000; i++) fs.writeFileSync(path.join(dir, 'dir', `prefix${i}.txt`), '');
  for (let i = 0; i < 40; i++) fs.symlinkSync(i < 39 ? `l${i + 1}` : 'target', path.join(dir, 'links', `l${i}`));
}

/**
 * The lines, `{ label, command, full }`: `full` is what full permissions decide for it, 'allow' when the policy checks it
 * in time and it names nothing of Claude Code's own settings, 'unchecked' when it is too long or too involved to check in
 * time. None of them names those settings.
 */
export function slowLines() {
  const json = upTo64k(i => `{"id":${i},"name":"item${i}"},\n`);
  const rows = [
    ['200 cd steps', rep(200, i => `cd pkg${i} && npm test && cd ..`), 'unchecked'],
    ['200 cd steps with an output file', rep(200, i => `cd pkg${i} && npm test > out.txt && cd ..`), 'unchecked'],
    ['60 cd || cd pairs', rep(60, i => `cd d${i} || cd e${i} &&`, ' ') + ' npm test', 'unchecked'],
    ['touch . with forty * and x', 'touch .' + '*'.repeat(40) + 'x', 'allow'],
    ['a wildcard of 30,000 stars and letters over 5,000 files', 'ls dir/' + '*a'.repeat(30000), 'allow'],
    ['a wildcard of 60,000 ? over 5,000 files', 'ls dir/' + '?'.repeat(60000), 'allow'],
    ['git with a wildcard and 64 KB of words', 'git add dir/prefix49* ' + upTo64k(() => 'a '), 'unchecked'],
    ['30 ls dir/prefix* over 5,000 files', rep(30, () => 'ls dir/prefix*'), 'allow'],
    ['256 ls dir/prefix* over 5,000 files', rep(256, () => 'ls dir/prefix*'), 'allow'],
    ['256 ls dir/prefix* after ;', rep(256, () => 'ls dir/prefix*', '; '), 'allow'],
    ['64 KB of echo &&', upTo64k(i => `echo ${i} && `) + 'true', 'unchecked'],
    ['64 KB of cd ;', upTo64k(i => `cd d${i % 60}; `) + 'ls', 'unchecked'],
    ['64 KB of ls words', 'ls ' + upTo64k(i => `a${i} `), 'unchecked'],
    ['64 KB option word', 'ls -' + 'a'.repeat(65536), 'allow'],
    ['64 KB heredoc', "cat > data.json <<'EOF'\n" + json + 'EOF', 'allow'],
    ['64 KB of braces', 'echo ' + upTo64k(() => '{a,b}'), 'unchecked'],
    ['300 brace groups in words', 'echo ' + rep(300, i => `x{a,b}${i}`, ' '), 'allow'],
    ['300 brace groups to rm', 'rm -f ' + rep(300, i => `x{a,b}${i}`, ' '), 'allow'],
    ['300 brace groups in one word', 'echo ' + rep(300, () => '{a,b}', ''), 'allow'],
    ['300 brace groups in quotes', 'echo "' + rep(300, () => '{a,b}', ',') + '" > notes.md', 'allow'],
    ['300 brace groups in a heredoc', "cat > data.json <<'EOF'\n" + rep(300, i => `{"id":${i},"n":"{a,b}"}`, ',\n') + '\nEOF', 'allow'],
    ['a write through 40 links', 'echo x > links/l0/out.txt', 'allow'],
    ['a read through 40 links', 'cat links/l0/x', 'allow'],
    ['30 writes through 40 links', rep(30, i => `echo x > links/l${i}/out${i}.txt`, '; '), 'allow'],
  ];
  return rows.map(([label, command, full]) => ({ label, command, full }));
}
