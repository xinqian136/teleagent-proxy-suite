#!/usr/bin/env node
/**
 * verify-monorepo.js —— 逐分支校验本地与远端内容是否一致
 *
 * 用法:
 *   node tools/verify-monorepo.js <token> [localDir] [owner/repo]
 *
 * 对每个分支：
 *   - 远端：GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1  → path -> blob sha
 *   - 本地：git ls-tree -r <branch>                                → path -> blob sha
 *   - 比对两边集合，输出差异
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const TOKEN = process.argv[2];
const LOCAL = process.argv[3] || path.join(__dirname, '..');
const SLUG = process.argv[4] || 'xinqian136/teleagent-proxy-suite';
const BRANCHES = ['main', 'v1', 'v2', 'v3', 'v4'];

if (!TOKEN) {
  console.error('usage: node verify-monorepo.js <token> [localDir] [owner/repo]');
  process.exit(1);
}

const GIT = 'C:/Program Files (x86)/Git/cmd/git.exe';

async function gh(pathname) {
  const r = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'teleagent-proxy-verify',
    },
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

function localTree(branch) {
  const out = execFileSync(GIT, ['-c', 'core.quotePath=false', 'ls-tree', '-r', branch], {
    cwd: LOCAL, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
    if (m) map.set(m[2].replace(/\r$/, ''), m[1]);
  }
  return map;
}

(async () => {
  let totalDiff = 0;
  for (const b of BRANCHES) {
    const head = await gh(`/repos/${SLUG}/commits/${b}`);
    const tree = await gh(`/repos/${SLUG}/git/trees/${head.sha}?recursive=1`);
    const remote = new Map();
    for (const e of tree.tree) if (e.type === 'blob') remote.set(e.path, e.sha);

    const local = localTree(b);
    const diff = [];
    for (const [k, v] of local) {
      if (!remote.has(k)) diff.push(`MISSING:${k}`);
      else if (remote.get(k) !== v) diff.push(`DIFF:${k}`);
    }
    for (const k of remote.keys()) if (!local.has(k)) diff.push(`EXTRA:${k}`);

    totalDiff += diff.length;
    console.log(`${b.padEnd(5)} local=${String(local.size).padStart(4)} remote=${String(remote.size).padStart(4)} diff=${String(diff.length).padStart(4)} head=${head.sha.slice(0, 7)}`);
    if (diff.length) console.log(`      ${diff.slice(0, 5).join(' | ')}`);
  }
  console.log('');
  console.log(totalDiff === 0 ? 'ALL BRANCHES MATCH (diff=0)' : `TOTAL DIFF = ${totalDiff}`);
  process.exit(totalDiff === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
