'use strict';
/**
 * dpapi.js — Windows DPAPI 解密（零依赖）
 *
 * 用于读取 TeleAgent 的 safe_storage 凭据：
 *   Local State → os_crypt.encrypted_key → DPAPI 解密 → AES key
 *
 * 实现方式：调用系统自带的 PowerShell + .NET ProtectedData（无需 Add-Type 编译 C#）。
 * 目标机器只要是 Windows 就有 PowerShell，不需要额外安装任何东西。
 *
 * 注意：DPAPI 绑定 **Windows 用户 + 机器**。
 *   → 别的机器/别的用户解不开，这是设计使然，不是 bug。
 *   → 跨机器请用 local 方案（见 account-manager/exporter.js）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CACHE = new Map();

/**
 * 从 Local State 解出 safe_storage 的 AES key
 * @param {string} localStatePath
 * @returns {Buffer|null} 32 字节 AES key，失败返回 null
 */
function readAesKey(localStatePath) {
  if (CACHE.has(localStatePath)) return CACHE.get(localStatePath);

  let key = null;
  try {
    const ls = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
    const ek = ls?.os_crypt?.encrypted_key;
    if (ek) {
      const b64 = ek.includes('|') ? ek.split('|')[1] : ek;
      const blob = Buffer.from(b64, 'base64');
      // Electron 3.x 会在 DPAPI blob 前加 "DPAPI" 5 字节前缀
      const payload = blob.subarray(0, 5).toString('latin1') === 'DPAPI' ? blob.subarray(5) : blob;
      key = dpapiUnprotect(payload);
      if (key && key.length !== 32) key = null;
    }
  } catch (e) {
    key = null;
  }
  CACHE.set(localStatePath, key);
  return key;
}

/**
 * DPAPI 解密（当前用户作用域）
 * @param {Buffer} payload 已去掉 "DPAPI" 前缀的 blob
 * @returns {Buffer|null}
 */
function dpapiUnprotect(payload) {
  const tmp = path.join(os.tmpdir(), `tav2-dpapi-${Date.now()}-${process.pid}.b64`);
  const ps = path.join(os.tmpdir(), `tav2-dpapi-${Date.now()}-${process.pid}.ps1`);
  try {
    fs.writeFileSync(tmp, payload.toString('base64'), 'ascii');
    fs.writeFileSync(ps, PS_TEMPLATE.replace('__FILE__', tmp.replace(/\\/g, '\\\\')), 'utf8');
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps],
      { encoding: 'utf8', timeout: 20000, windowsHide: true }
    ).trim();
    if (!out || out.startsWith('FAIL')) return null;
    const buf = Buffer.from(out, 'base64');
    return buf.length ? buf : null;
  } catch (e) {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
    try { fs.unlinkSync(ps); } catch (_) {}
  }
}

const PS_TEMPLATE = `
Add-Type -AssemblyName System.Security
$b = [Convert]::FromBase64String([IO.File]::ReadAllText('__FILE__'))
try {
  $c = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Convert]::ToBase64String($c)
} catch {
  'FAIL'
}
`;

function clearCache() {
  CACHE.clear();
}

module.exports = { readAesKey, dpapiUnprotect, clearCache };

if (require.main === module) {
  const p = process.argv[2] || path.join(
    process.env.USERPROFILE || os.homedir(), '.local', 'share', 'TeleAgent', 'Local State');
  const k = readAesKey(p);
  console.log(k ? `✓ AES key = ${k.toString('hex')}` : '✗ 解密失败（DPAPI 绑定当前 Windows 用户+机器）');
}
