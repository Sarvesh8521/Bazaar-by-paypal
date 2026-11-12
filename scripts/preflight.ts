import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ *
 * `npm run preflight`: run it right before you push to a public repo.
 * It looks for the one mistake that cannot be undone (a key in a public
 * file) and for the placeholders you still have to fill in.
 * ------------------------------------------------------------------ */

export interface PreflightFile {
  path: string;
  text: string;
}
export interface Finding {
  level: 'fail' | 'warn';
  file: string;
  message: string;
}

// Shapes of real keys. Anything matching is almost certainly a secret.
const KEY_SHAPES: [RegExp, string][] = [
  [/AIza[0-9A-Za-z_-]{30,}/, 'a Google API key'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic API key'],
  [/sk-[A-Za-z0-9]{32,}/, 'an OpenAI-style API key'],
  [/Bearer [A-Za-z0-9._-]{30,}/, 'a bearer token'],
  [/(?:client_secret|CLIENT_SECRET|api[_-]?key|API_KEY)["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{24,}/, 'a key or secret assigned inline'],
];
const SKIP_SHAPES = new Set(['package-lock.json']);
const PLACEHOLDER = /<your Render URL>|<sandbox buyer (?:email|password)>|<your[^>\n]{0,40}>|REPLACE_ME|YOUR_[A-Z_]{3,}|youtu\.be\/xxxx|\bTODO\b/g;

export function scan(files: PreflightFile[], env: [string, string][], trackedPaths: string[] = files.map((f) => f.path)): Finding[] {
  const out: Finding[] = [];
  const secrets = env.filter(([, v]) => v.length >= 8 && !/^(true|false|none|http|https|\d+)$/i.test(v) && !/^https?:\/\//.test(v) && !/^\.?\.?\//.test(v));

  for (const f of files) {
    if (/(^|\/)\.env(\.|$)/.test(f.path) && !/\.env\.example$/.test(f.path)) {
      out.push({ level: 'fail', file: f.path, message: 'a real .env file is among the files to publish. Remove it from git: git rm --cached .env' });
      continue;
    }
    for (const [key, value] of secrets) if (f.text.includes(value)) out.push({ level: 'fail', file: f.path, message: `contains the value of ${key} from your .env. Remove it before pushing, and rotate that key.` });
    if (!SKIP_SHAPES.has(path.basename(f.path))) for (const [re, what] of KEY_SHAPES) if (re.test(f.text)) out.push({ level: 'fail', file: f.path, message: `looks like it contains ${what}` });
  }

  const tracked = (re: RegExp) => trackedPaths.filter((p) => re.test(p));
  for (const p of tracked(/^(data|dist|node_modules)\//)) out.push({ level: 'fail', file: p, message: 'this folder must not be committed (see .gitignore)' });

  const gi = files.find((f) => f.path === '.gitignore')?.text ?? '';
  for (const need of ['.env', 'node_modules', 'data']) if (!new RegExp(`^${need}\\b`, 'm').test(gi)) out.push({ level: 'fail', file: '.gitignore', message: `does not ignore ${need}` });
  if (!files.some((f) => /^LICENSE(\.md|\.txt)?$/.test(f.path))) out.push({ level: 'fail', file: 'LICENSE', message: 'the open-source licence file is missing (the rules require it, visible in the repo)' });
  if (!files.some((f) => f.path === 'README.md')) out.push({ level: 'fail', file: 'README.md', message: 'missing' });

  const sample = files.find((f) => f.path === 'public/sample-crawl.json');
  if (!sample) out.push({ level: 'warn', file: 'public/sample-crawl.json', message: 'no recorded crawl: the replay page will not work' });
  else {
    try {
      const j = JSON.parse(sample.text) as { ai?: string };
      if (j.ai === 'mock') out.push({ level: 'warn', file: 'public/sample-crawl.json', message: 'the recording was made with the offline demo agents (it is labelled that way). Replace it with a real run: npm run sample -- <sessionId>' });
    } catch {
      out.push({ level: 'fail', file: 'public/sample-crawl.json', message: 'is not valid JSON' });
    }
  }

  // The README legitimately says things like https://<your-service>.onrender.com, so only SUBMISSION.md gets the full check.
  for (const [name, re] of [['SUBMISSION.md', PLACEHOLDER], ['README.md', /REPLACE_ME|\bTODO\b/g]] as [string, RegExp][]) {
    const f = files.find((x) => x.path === name);
    const hits = [...new Set((f?.text.match(re) ?? []).map((h) => h.trim()))];
    if (f && hits.length) out.push({ level: 'warn', file: name, message: `still has placeholders to fill in: ${hits.join(', ')}` });
  }
  return out;
}

export function render(findings: Finding[]): string {
  const fails = findings.filter((f) => f.level === 'fail');
  const warns = findings.filter((f) => f.level === 'warn');
  const line = (f: Finding) => `${f.level === 'fail' ? '✘' : '!'} ${f.file}: ${f.message}`;
  const verdict = fails.length ? `DO NOT PUSH YET: ${fails.length} problem${fails.length === 1 ? '' : 's'} above must be fixed.` : warns.length ? 'Safe to push. Before you submit, deal with the notes marked (!).' : 'All clear. Safe to push.';
  return `${[...fails, ...warns].map(line).join('\n') || '✔ no problems found'}\n\n${verdict}`;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'data', '.git']);
function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (SKIP_DIRS.has(n)) return [];
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

function main() {
  const root = process.cwd();
  let paths: string[];
  let tracked: string[];
  const inGit = existsSync(path.join(root, '.git'));
  if (inGit) {
    // What git would actually publish: tracked files plus new files that are not ignored.
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
    tracked = git(['ls-files']);
    paths = [...new Set([...tracked, ...git(['ls-files', '--others', '--exclude-standard'])])];
  } else {
    paths = walk(root);
    tracked = [];
    console.log('(This folder is not a git repository yet, so I am checking every file that is not in node_modules, dist or data.)\n');
  }
  const files: PreflightFile[] = paths.filter((p) => existsSync(path.join(root, p))).map((p) => ({ path: p, text: readFileSync(path.join(root, p), 'utf8') }));
  const env: [string, string][] = existsSync('.env')
    ? readFileSync('.env', 'utf8')
        .split(/\r?\n/)
        .flatMap((l) => {
          const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
          return m && m[2] ? [[m[1], m[2].replace(/^["']|["']$/g, '')] as [string, string]] : [];
        })
    : [];
  const findings = scan(files, env, tracked);
  console.log(render(findings));
  process.exit(findings.some((f) => f.level === 'fail') ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
