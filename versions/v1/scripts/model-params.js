#!/usr/bin/env node
/**
 * model-params.js — 汇总 TeleAgent 全部模型的参数（catalog + 内核实时 + 实测）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.USERPROFILE || os.homedir();
const CATALOG = path.join(HOME, '.local', 'share', 'TeleAgent', 'users',
  fs.readdirSync(path.join(HOME, '.local', 'share', 'TeleAgent', 'users'))[0], 'model-catalog.json');

function catalogModels() {
  const j = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const out = [];
  for (const g of (j.state?.catalog?.groups || [])) {
    for (const m of (g.models || [])) {
      out.push({
        group: g.title,
        id: m.modelID,
        name: m.displayName,
        context: m.limits?.context,
        output: m.limits?.output,
        desc: m.description,
        credit: m.creditMultiplier,
        default: m.isDefault,
        toolStream: m.behavior?.toolStream,
        tags: (m.tags || []).map(t => t.label),
      });
    }
  }
  return out;
}

(async () => {
  const { setSessionKey, kernelCall } = require('./kernel-client');
  setSessionKey(fs.readFileSync(path.join(__dirname, 'session.key'), 'utf8').trim());
  const p = await kernelCall('GET', '/provider');
  const j = p.json;
  const all = (j && (j.data || j).all) || (j && j.all) || [];
  const na = all.find(x => x.id === 'NewApi');
  const live = na && na.models ? na.models : {};

  const cat = catalogModels();
  console.log(JSON.stringify({ catalog: cat, live: live }, null, 1));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
