import test from 'node:test';
import assert from 'node:assert/strict';
import { render, scan, type PreflightFile } from '../scripts/preflight.ts';

const good: PreflightFile[] = [
  { path: '.gitignore', text: 'node_modules\ndist\n.env\ndata/\n' },
  { path: 'LICENSE', text: 'MIT License' },
  { path: 'README.md', text: '# Bazaar\nRun it.' },
  { path: 'SUBMISSION.md', text: 'All filled in.' },
  { path: 'public/sample-crawl.json', text: JSON.stringify({ ai: 'gemini' }) },
  { path: 'server/index.ts', text: 'const x = process.env.GEMINI_API_KEY;' },
];
const env: [string, string][] = [
  ['GEMINI_API_KEY', 'gemini-secret-value-123456'],
  ['PAYPAL_CLIENT_SECRET', 'paypal-secret-value-abcdef'],
  ['PORT', '3000'],
  ['PUBLIC_BASE_URL', 'http://localhost:3000'],
  ['MOCK_LLM', '0'],
];
const fails = (f: ReturnType<typeof scan>) => f.filter((x) => x.level === 'fail');
const warns = (f: ReturnType<typeof scan>) => f.filter((x) => x.level === 'warn');

test('preflight: a clean repo passes with no findings', () => {
  const f = scan(good, env);
  assert.deepEqual(f, []);
  assert.match(render(f), /All clear/);
});

test('preflight: a value copied from .env into ANY file is a hard failure that names the setting but never shows the value', () => {
  const leaked = [...good, { path: 'docs/notes.md', text: 'my key is gemini-secret-value-123456 do not share' }];
  const f = scan(leaked, env);
  assert.equal(fails(f).length, 1);
  assert.match(f[0].message, /GEMINI_API_KEY/);
  const text = render(f);
  assert.ok(!text.includes('gemini-secret-value-123456'), 'the report must never print the secret');
  assert.match(text, /DO NOT PUSH YET/);
});

test('preflight: harmless .env values (ports, URLs, flags) are not treated as secrets', () => {
  const f = scan([...good, { path: 'README.md', text: 'Open http://localhost:3000 on port 3000 with MOCK_LLM=0' }], env);
  assert.deepEqual(f, []);
});

test('preflight: well-known key shapes are caught even when they are not in your .env', () => {
  for (const [text, what] of [
    ['AIza' + 'a'.repeat(35), 'Google'],
    ['sk-ant-' + 'b'.repeat(30), 'Anthropic'],
    ['Authorization: Bearer ' + 'c'.repeat(40), 'bearer'],
    ['CLIENT_SECRET=' + 'd'.repeat(30), 'inline'],
  ]) {
    const f = scan([...good, { path: 'scripts/x.ts', text }], []);
    assert.equal(fails(f).length, 1, `${what} key shape should be caught`);
  }
  // the lockfile's integrity hashes must not trigger false alarms
  assert.deepEqual(scan([...good, { path: 'package-lock.json', text: '"integrity": "sha512-' + 'A'.repeat(90) + '", "x": "sk-' + 'a1'.repeat(20) + '"' }], []), []);
});

test('preflight: a real .env file in the publish set, or committed data/dist/node_modules, is a failure', () => {
  assert.equal(fails(scan([...good, { path: '.env', text: 'GEMINI_API_KEY=x' }], [])).length, 1);
  assert.equal(fails(scan([...good, { path: '.env.example', text: 'GEMINI_API_KEY=' }], [])).length, 0);
  const f = scan(good, [], ['data/store.json', 'dist/index.html', 'node_modules/x/y.js', 'server/index.ts']);
  assert.equal(fails(f).length, 3);
});

test('preflight: missing licence, README or gitignore entries are failures', () => {
  assert.equal(fails(scan(good.filter((x) => x.path !== 'LICENSE'), [])).length, 1);
  assert.equal(fails(scan(good.filter((x) => x.path !== 'README.md'), [])).length, 1);
  const f = scan(good.map((x) => (x.path === '.gitignore' ? { ...x, text: 'dist\n' } : x)), []);
  assert.deepEqual(fails(f).map((x) => x.message).sort(), ['does not ignore .env', 'does not ignore data', 'does not ignore node_modules']);
});

test('preflight: leftover placeholders and a mock recording are warnings, not blockers', () => {
  const f = scan(
    [
      ...good.filter((x) => x.path !== 'SUBMISSION.md' && x.path !== 'public/sample-crawl.json'),
      { path: 'SUBMISSION.md', text: 'Live site: <your Render URL>. Login: <sandbox buyer email> / <sandbox buyer password>. TODO video.' },
      { path: 'public/sample-crawl.json', text: JSON.stringify({ ai: 'mock' }) },
    ],
    [],
  );
  assert.equal(fails(f).length, 0);
  const w = warns(f).map((x) => x.message).join('\n');
  assert.match(w, /<your Render URL>/);
  assert.match(w, /<sandbox buyer email>/);
  assert.match(w, /TODO/);
  assert.match(w, /offline demo agents/);
  assert.match(render(f), /Safe to push\. Before you submit/);
});

test('preflight: the shipped repository itself is free of secrets and well-formed', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const path = await import('node:path');
  const skip = new Set(['node_modules', 'dist', 'data', '.git']);
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (skip.has(n) ? [] : statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : [path.join(d, n)]));
  const files = walk('.').filter((p) => !/^\.env$/.test(path.basename(p))).map((p) => ({ path: p.replace(/^\.\//, ''), text: readFileSync(p, 'utf8') }));
  const f = scan(files, []);
  assert.deepEqual(fails(f), [], JSON.stringify(fails(f)));
});
