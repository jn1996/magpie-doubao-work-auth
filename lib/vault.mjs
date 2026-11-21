/**
 * 凭据保管。
 *
 * 为什么要把 Cookie 存下来：豆包工作的登录态在客户端里，用户一退出登录、
 * 或者干脆没装客户端，就什么都读不到。所以导入时把 Cookie 复制一份留在
 * 插件自己的目录里，此后与客户端无关——客户端退出、切号、卸载都不影响
 * 已经导入的账号。
 *
 * 存储用 DPAPI 加密（Windows），或本地 key + AES-256-GCM（其他平台），不落明文。
 * 非 Windows 的 key 单独存一个 600 权限的文件：能挡住同机其他用户和误拷，
 * 挡不住同一用户下运行的恶意程序（Windows 的 DPAPI 也挡不住），别指望它更强。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { unprotect } from './dpapi.mjs'
import { spawn } from 'node:child_process'

/** 保管库根目录 */
export function vaultRoot() {
  if (process.env.DOUBAO_WORK_VAULT) return process.env.DOUBAO_WORK_VAULT
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'magpie-doubao-work-auth', 'vault')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'magpie-doubao-work-auth', 'vault')
}

/** 本地 key 文件（非 Windows）。和保管库放一起，权限 600。 */
function keyFile() {
  return join(dirname(vaultRoot()), 'vault.key')
}

/** AES-GCM 密文的开头，用来和早期版本落的明文区分 */
const SEALED_MAGIC = Buffer.from('DBWK1\0', 'binary')

async function protect(plain) {
  if (process.platform === 'win32') return dpapiProtect(plain)
  return seal(plain)
}

/** 读本地 key，没有就生成一个（0600） */
async function localKey() {
  const file = keyFile()
  try {
    const key = await readFile(file)
    if (key.length === 32) return key
  } catch { /* 没生成过 */ }
  const key = randomBytes(32)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  // 并发时可能已有人写好，用 'wx' 让第二名失败后重读
  try {
    await writeFile(file, key, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = await readFile(file)
    if (existing.length === 32) return existing
    throw new Error('保管库的 key 文件损坏，请重新登录一次让插件重建。')
  }
  try { await chmod(file, 0o600) } catch { /* 已经 600 了 */ }
  return key
}

/** AES-256-GCM 加密：magic | iv(12) | tag(16) | 密文 */
async function seal(plain) {
  const key = await localKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([SEALED_MAGIC, iv, cipher.getAuthTag(), body])
}

/** 解封；不是本插件的新格式返回 null，交给调用方按旧明文处理 */
async function unseal(raw) {
  if (raw.length < SEALED_MAGIC.length + 28) return null
  if (!raw.subarray(0, SEALED_MAGIC.length).equals(SEALED_MAGIC)) return null
  const key = await localKey()
  const iv = raw.subarray(SEALED_MAGIC.length, SEALED_MAGIC.length + 12)
  const tag = raw.subarray(SEALED_MAGIC.length + 12, SEALED_MAGIC.length + 28)
  const body = raw.subarray(SEALED_MAGIC.length + 28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

const PROTECT_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DpapiProt {
  [StructLayout(LayoutKind.Sequential)]
  struct DATA_BLOB { public int cbData; public IntPtr pbData; }
  [DllImport("crypt32.dll", SetLastError = true)]
  static extern bool CryptProtectData(ref DATA_BLOB pDataIn, string desc, IntPtr entropy,
    IntPtr reserved, IntPtr prompt, int flags, ref DATA_BLOB pDataOut);
  public static byte[] Protect(byte[] data) {
    DATA_BLOB inB = new DATA_BLOB(); DATA_BLOB outB = new DATA_BLOB();
    inB.cbData = data.Length; inB.pbData = Marshal.AllocHGlobal(data.Length);
    Marshal.Copy(data, 0, inB.pbData, data.Length);
    try {
      if (!CryptProtectData(ref inB, "doubao-work", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref outB))
        throw new Exception("CryptProtectData failed: " + Marshal.GetLastWin32Error());
      byte[] r = new byte[outB.cbData]; Marshal.Copy(outB.pbData, r, 0, outB.cbData); return r;
    } finally {
      if (inB.pbData != IntPtr.Zero) Marshal.FreeHGlobal(inB.pbData);
      if (outB.pbData != IntPtr.Zero) Marshal.FreeHGlobal(outB.pbData);
    }
  }
}
'@
$b64 = [Console]::In.ReadToEnd().Trim()
$raw = [Convert]::FromBase64String($b64)
[Console]::Out.Write([Convert]::ToBase64String([DpapiProt]::Protect($raw)))
`

function dpapiProtect(plain) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROTECT_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    const out = []
    const err = []
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`DPAPI 加密失败：${Buffer.concat(err).toString('utf8').slice(0, 300)}`))
      resolve(Buffer.from(Buffer.concat(out).toString('utf8').trim(), 'base64'))
    })
    child.stdin.end(plain.toString('base64'))
  })
}

/** 账号在保管库里的文件名：用 uid，避免 Cookie 内容出现在路径上 */
function fileFor(uid) {
  const safe = String(uid).replace(/[^A-Za-z0-9_-]/g, '_')
  return join(vaultRoot(), `${safe}.bin`)
}

/** 保存一个账号的 Cookie 与设备标识 */
export async function saveAccount(account) {
  const payload = {
    version: 1,
    uid: String(account.uid),
    name: account.name ?? '',
    profile: account.profile ?? '',
    userDataDir: account.userDataDir ?? '',
    clientInfo: account.clientInfo ?? {},
    clientVersion: account.clientVersion ?? '',
    bot: account.bot ?? '',
    cookies: account.cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
      expires: c.expires || 0, secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly),
    })),
    savedAt: Date.now(),
  }
  const plain = Buffer.from(JSON.stringify(payload), 'utf8')
  const sealed = await protect(plain)
  const file = fileFor(account.uid)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomBytes(6).toString('hex')}.part`
  await writeFile(temp, sealed, { mode: 0o600, flag: 'wx' })
  await rename(temp, file)
  try { await chmod(file, 0o600) } catch { /* Windows 上无所谓 */ }
  return { uid: payload.uid, file }
}

/** 读回一个账号 */
export async function loadAccount(uid) {
  const raw = await readFile(fileFor(uid))
  let plain
  if (process.platform === 'win32') {
    // DPAPI 密文第一个字节起就是 blob，直接解
    plain = await unprotect(raw)
  } else {
    // 新格式是 AES-GCM；早期版本落的是明文，读到时候按明文认，下次保存自动转成密文
    plain = (await unseal(raw)) ?? raw
  }
  const payload = JSON.parse(plain.toString('utf8'))
  if (!payload?.uid || !Array.isArray(payload.cookies)) throw new Error('保管库里的账号记录已损坏。')
  return payload
}

export async function removeAccount(uid) {
  try { await unlink(fileFor(uid)); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

/** 列出保管库里所有账号（只读元信息，不解密 Cookie） */
export async function listAccounts() {
  const dir = vaultRoot()
  const { readdir } = await import('node:fs/promises')
  let names
  try { names = await readdir(dir) }
  catch { return [] }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.bin')) continue
    try {
      const account = await loadAccount(name.slice(0, -4))
      out.push({
        uid: account.uid, name: account.name, profile: account.profile,
        savedAt: account.savedAt, cookieCount: account.cookies.length,
      })
    } catch { /* 解不开的跳过 */ }
  }
  return out
}

export const _internal = { fileFor, fileForTest: (uid) => fileFor(uid), protect, seal, unseal, keyFile, localKey }
