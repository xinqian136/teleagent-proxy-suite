// 实验：在「模拟新机器」的 HOME 下，扫描 + 解密 token
// 目的：验证 v2 跨机器扫描的可行性边界
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');

const HOME = process.env.USERPROFILE || os.homedir();
const DATA = path.join(HOME, '.local', 'share', 'TeleAgent');

console.log('=== 模拟新机器扫描 ===');
console.log('HOME:', HOME);
console.log('');

// 1. 扫描根目录是否存在
if (!fs.existsSync(DATA)) {
  console.log('[结论] 该机器没有 TeleAgent 数据目录 → 扫不到任何账号');
  process.exit(0);
}

// 2. 找账号目录
const users = path.join(DATA, 'users');
if (!fs.existsSync(users)) {
  console.log('[结论] 没有 users 目录 → 未登录过，无账号');
  process.exit(0);
}
const accts = fs.readdirSync(users).filter((d) => d.startsWith('v1_public_'));
console.log('[扫描] users/ 下找到账号目录:', accts.length);

// 3. 读 Local State 的 DPAPI key
function getDpapiKey() {
  const lsPath = path.join(DATA, 'Local State');
  if (!fs.existsSync(lsPath)) return null;
  const ls = JSON.parse(fs.readFileSync(lsPath, 'utf8'));
  const ek = ls?.os_crypt?.encrypted_key;
  if (!ek) return null;
  // 3.0.1: "DPAPI|<base64>"  3.1.0: 纯 base64 blob
  const b64 = ek.includes('|') ? ek.split('|')[1] : ek;
  return Buffer.from(b64, 'base64');
}

// 4. DPAPI 解密（用 Windows CryptUnprotectData）
function dpapiUnprotect(blob) {
  const { execFileSync } = require('child_process');
  const tmp = path.join(os.tmpdir(), 'dpapi-' + Date.now() + '.bin');
  fs.writeFileSync(tmp, blob);
  const ps = `
$sig='[DllImport("crypt32.dll", SetLastError=true)] public static extern bool CryptUnprotectData(ref DATA_BLOB pDataIn, IntPtr ppszDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, out DATA_BLOB pDataOut);
[StructLayout(LayoutKind.Sequential)] public struct DATA_BLOB { public int cbData; public IntPtr pbData; }'
$t=Add-Type -MemberDefinition $sig -Name DP -Namespace D -PassThru
$b=[IO.File]::ReadAllBytes('${tmp.replace(/\\/g, '\\\\')}')
$in=New-Object DP+DATA_BLOB
$in.cbData=$b.Length
$in.pbData=[Runtime.InteropServices.Marshal]::AllocHGlobal($b.Length)
[Runtime.InteropServices.Marshal]::Copy($b,0,$in.pbData,$b.Length)
$out=New-Object DP+DATA_BLOB
$r=[DP]::CryptUnprotectData([ref]$in,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,1,[ref]$out)
if($r){ $o=New-Object byte[] $out.cbData; [Runtime.InteropServices.Marshal]::Copy($out.pbData,$o,0,$out.cbData); [Convert]::ToBase64String($o) } else { 'FAIL' }
`;
  const psFile = path.join(os.tmpdir(), 'dpapi-' + Date.now() + '.ps1');
  fs.writeFileSync(psFile, ps, 'utf8');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], { encoding: 'utf8' }).trim();
    if (out && out !== 'FAIL') return Buffer.from(out, 'base64');
  } catch (e) { }
  return null;
}

// 5. 逐账号尝试解密
for (const d of accts) {
  const tjPath = path.join(users, d, 'app-auth', 'token.json');
  if (!fs.existsSync(tjPath)) { console.log('  ', d, '-> 无 token.json'); continue; }
  const tj = JSON.parse(fs.readFileSync(tjPath, 'utf8'));
  console.log('  ', d, 'scheme=' + tj.scheme);

  if (tj.scheme === 'local') {
    // local 方案：密钥在同目录的 local-key，纯文件，可跨机器
    const lk = path.join(users, d, 'app-auth', 'local-key');
    if (!fs.existsSync(lk)) { console.log('      无 local-key'); continue; }
    const key = fs.readFileSync(lk);
    try {
      const b = Buffer.from(tj.encryptedToken, 'base64');
      const dec = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      dec.setAuthTag(b.subarray(b.length - 16));
      const tok = Buffer.concat([dec.update(b.subarray(12, b.length - 16)), dec.final()]).toString('utf8');
      console.log('      ✓ local 方案解密成功，token 长度', tok.length);
    } catch (e) { console.log('      ✗ local 解密失败:', e.message.slice(0, 50)); }
    continue;
  }

  // safe_storage 方案：需要 DPAPI 解出的 AES key
  const dp = getDpapiKey();
  if (!dp) { console.log('      无 Local State / encrypted_key'); continue; }
  const aesKey = dpapiUnprotect(dp);
  if (!aesKey) { console.log('      ✗ DPAPI 解密失败（本机/本用户不匹配）'); continue; }
  try {
    const b = Buffer.from(tj.encryptedToken, 'base64');
    const dec = crypto.createDecipheriv('aes-256-gcm', aesKey, b.subarray(3, 15));
    dec.setAuthTag(b.subarray(b.length - 16));
    const tok = Buffer.concat([dec.update(b.subarray(15, b.length - 16)), dec.final()]).toString('utf8');
    const pl = JSON.parse(Buffer.from(tok.split(':').slice(1).join(':').split('.')[1], 'base64url').toString('utf8'));
    console.log('      ✓ safe_storage 解密成功 →', pl.accountName);
  } catch (e) {
    console.log('      ✗ safe_storage 解密失败:', e.message.slice(0, 60));
  }
}
