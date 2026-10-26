import { readFile, writeFile, mkdir, rename, stat, open, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createXidianClient, type XidianSession, type XidianCredentials } from '../../src/infrastructure/xidian/client.ts'
import { XidianError } from '../../src/infrastructure/xidian/timetable.ts'
import { DEFAULT_DOC_PYTHON } from '../../src/infrastructure/action/adapters/document-read.ts'

const dir = resolve(process.env.PROJECT_LG_XIDIAN_DIR ?? 'data/xidian')
const mode = process.argv[2] ?? 'sync'
type Status = { ok: boolean; code: string; attemptedAt: number; credentialsMtime: number; loginDate?: string; loginCount?: number }

async function readJson(name: string): Promise<any> { return JSON.parse(await readFile(resolve(dir,name),'utf8')) }
async function save(name: string, value: unknown): Promise<void> {
  const temp = resolve(dir,`${name}.${process.pid}.tmp`)
  await writeFile(temp,JSON.stringify(value),{ mode:0o600 }); await rename(temp,resolve(dir,name))
}
await mkdir(dir,{ recursive:true,mode:0o700 })
let lock: Awaited<ReturnType<typeof open>> | undefined
try { lock = await open(resolve(dir,'sync.lock'),'wx',0o600) }
catch { console.error('xidian: sync_locked (another sync or stale lock; inspect before removing)'); process.exit(1) }
let previous: Status | undefined
let credentialsMtime = 0
try {
  if (!['sync','send-code','verify-code'].includes(mode)) throw new XidianError('invalid_mode')
  const metadata = await stat(resolve(dir,'credentials.json'))
  credentialsMtime = metadata.mtimeMs
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) throw new XidianError('credentials_permissions')
  const credentials = await readJson('credentials.json') as XidianCredentials
  if (!/^\d{8,16}$/.test(credentials.username) || typeof credentials.password !== 'string' || !credentials.password) throw new XidianError('credentials_invalid')
  try { previous = await readJson('status.json') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new XidianError('status_corrupt')
  }
  if (mode === 'sync' && previous?.code === 'password_rejected' && previous.credentialsMtime === credentialsMtime) throw new XidianError('password_rejected')
  let session: XidianSession
  try { session = await readJson('session.json') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new XidianError('session_corrupt')
    session = { fingerprint:randomBytes(16).toString('hex').toUpperCase() }
  }
  if (!/^[0-9A-F]{32}$/.test(session.fingerprint)) throw new XidianError('session_corrupt')
  const client = createXidianClient({ session,credentials,saveSession: s => save('session.json',s),
    beforePasswordLogin: async () => {
      const day = new Date().toISOString().slice(0,10)
      const count = previous?.loginDate === day ? previous.loginCount ?? 0 : 0
      if (count >= 3) throw new XidianError('daily_login_limit')
      previous = { ok:false,code:'login_in_progress',attemptedAt:Date.now(),credentialsMtime,loginDate:day,loginCount:count+1 }
      // Write before transport so a crash cannot erase a password attempt.
      await save('status.json',previous)
    },
    solveCaptcha: async puzzle => {
      const child = execFile(process.env.PROJECT_LG_XIDIAN_PYTHON ?? DEFAULT_DOC_PYTHON,
        ['-I',resolve('scripts/xidian/solve-slider.py')],{ timeout:15000,maxBuffer:4096,windowsHide:true })
      child.stdin!.end(JSON.stringify(puzzle))
      const result = await new Promise<string>((resolve,reject) => {
        let output = ''; child.stdout!.on('data',s => { output += String(s) })
        child.on('error',reject); child.on('close',code => code === 0 ? resolve(output) : reject(new XidianError('captcha_failed')))
      }).catch(() => { throw new XidianError('captcha_runtime_or_match_failed') })
      return Number(JSON.parse(result).offset)
    },
  })
  if (mode === 'send-code') { await client.sendVerificationCode(); console.log('xidian: verification_code_requested') }
  else if (mode === 'verify-code') {
    // Code arrives through stdin from the local getpass helper, never a command-line argument.
    let code = ''
    for await (const chunk of process.stdin) { code += chunk; if (code.length > 32) throw new XidianError('invalid_verification_code') }
    await client.submitVerificationCode(code.trim()); console.log('xidian: trusted_device_verified')
  } else {
    const snapshot = await client.fetchTimetable(Date.now())
    await save('timetable.json',snapshot)
    await save('status.json',{ ...previous,ok:true,code:'synced',attemptedAt:Date.now(),credentialsMtime })
    console.log(JSON.stringify({ status:'synced',semester:snapshot.semester,courses:snapshot.courses.length,changes:snapshot.changesApplied,fetchedAt:snapshot.fetchedAt }))
  }
} catch (error) {
  const code = error instanceof XidianError ? error.code : 'sync_failed'
  await save('status.json',{ ...previous,ok:false,code,attemptedAt:Date.now(),credentialsMtime }).catch(() => {})
  console.error(`xidian: ${code}`); process.exitCode = 1
} finally { await lock.close(); await unlink(resolve(dir,'sync.lock')) }
