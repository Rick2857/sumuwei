// Copyright 2026 Project LG contributors.
// SPDX-License-Identifier: MPL-2.0
// Authentication and eHall protocol adapted from BenderBlog/traintime_pda,
// commit e780e4d01ea740c979ff5c31b9db439dbc586864 (see scripts/xidian/NOTICE.md).
// Original copyright 2023-2025 BenderBlog Rodriguez and contributors; 2025-2026 Traintime PDA authors.
import { CookieJar, JSDOM } from 'jsdom'
import { createCipheriv, randomInt } from 'node:crypto'
import { XidianError, rowsOf, buildTimetable, type TimetableSnapshot } from './timetable.ts'

export const IDS = 'https://ids.xidian.edu.cn'
export const EHALL = 'https://ehall.xidian.edu.cn'
export const SERVICE = `${EHALL}/appShow?appId=4770397878132218`
export interface XidianSession {
  cookies?: ReturnType<CookieJar['serializeSync']>; fingerprint: string; challenge?: string
}
export interface XidianCredentials { username: string; password: string }
export interface CaptchaPuzzle { bigImage: string; smallImage: string }
export interface XidianClientOptions {
  session: XidianSession; credentials: XidianCredentials
  saveSession: (session: XidianSession) => Promise<void>
  beforePasswordLogin: () => Promise<void>
  solveCaptcha: (puzzle: CaptchaPuzzle) => Promise<number>
  fetchImpl?: typeof fetch
}
export function encryptPassword(password: string, salt: string): string {
  const key = Buffer.from(salt)
  if (![16,24,32].includes(key.length)) throw new XidianError('auth_protocol_changed')
  const cipher = createCipheriv(`aes-${key.length*8}-cbc`, key, Buffer.from('xidianscriptsxdu'))
  return Buffer.concat([cipher.update('xidianscriptsxdu'.repeat(4) + password, 'utf8'), cipher.final()]).toString('base64')
}
function safeUrl(raw: string, base = IDS): URL {
  const url = new URL(raw, base)
  // Some eHall redirects advertise HTTP. Upgrade before sending any request/cookie.
  if (url.protocol === 'http:') url.protocol = 'https:'
  if (url.protocol !== 'https:' || !['ids.xidian.edu.cn','ehall.xidian.edu.cn'].includes(url.hostname) ||
    url.port || url.username || url.password) throw new XidianError('unexpected_auth_redirect')
  return url
}
export function createXidianClient(options: XidianClientOptions) {
  const session = options.session
  const jar = session.cookies ? CookieJar.deserializeSync(session.cookies) : new CookieJar()
  let calls = 0
  const deadline = AbortSignal.timeout(90000)
  const fetchImpl = options.fetchImpl ?? fetch
  const persist = async () => { session.cookies = jar.serializeSync(); await options.saveSession(session) }
  async function request(raw: string, form?: Record<string,string>): Promise<{ body: string; location?: string; status: number }> {
    if (++calls > 40) throw new XidianError('request_budget_exceeded')
    const url = safeUrl(raw)
    const signal = AbortSignal.any([AbortSignal.timeout(15000),deadline])
    try {
      const headers: Record<string,string> = {
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
        cookie: jar.getCookieStringSync(url.href),
        ...(url.origin === EHALL ? { referer: `${EHALL}/new/index_xd.html` } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
        ...(url.pathname.endsWith('/verifySliderCaptcha.htl') ? {
          Origin:IDS, 'X-Requested-With':'XMLHttpRequest', Accept:'application/json, text/javascript, */*; q=0.01',
        } : {}),
      }
      const response = await fetchImpl(url, { method: form ? 'POST' : 'GET', redirect: 'manual', headers,
        ...(form ? { body: new URLSearchParams(form).toString() } : {}), signal })
      // Upstream Dio CookieManager also ignores invalid Set-Cookie fields. Keep the
      // jar's domain/path validation; discard malformed/foreign cookies, never widen it.
      for (const cookie of response.headers.getSetCookie()) jar.setCookieSync(cookie,url.href,{ignoreError:true})
      await persist()
      if (response.status === 401) throw new XidianError(url.origin === IDS && form?.password ? 'password_rejected' : 'login_required')
      if (response.status >= 400) throw new XidianError('school_http_error')
      const chunks: Uint8Array[] = []; let bytes = 0
      if (response.body) {
        const reader = response.body.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            bytes += value.length
            if (bytes > 2*1024*1024) { await reader.cancel(); throw new XidianError('response_too_large') }
            chunks.push(value)
          }
        } finally { reader.releaseLock() }
      }
      const location = response.headers.get('location')
      return { body: Buffer.concat(chunks).toString('utf8'), status: response.status,
        ...(location ? { location: safeUrl(location, url.href).href } : {}) }
    } catch (error) {
      if (error instanceof XidianError) throw error
      throw new XidianError(signal.aborted ? 'school_timeout' : 'school_network_error')
    }
  }
  function json(body: string): Record<string, any> {
    try { const parsed = JSON.parse(body); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed } catch {}
    throw new XidianError('invalid_response')
  }
  async function follow(initial: string): Promise<void> {
    let url = initial
    for (let i=0; i<15; i++) {
      const next = safeUrl(url)
      if (next.hostname === 'ids.xidian.edu.cn' && /reAuth/i.test(next.pathname)) {
        session.challenge = next.href; await persist(); throw new XidianError('human_verification_required')
      }
      const result = await request(next.href)
      if (!result.location) {
        if (next.hostname !== 'ehall.xidian.edu.cn' || /pwdFromId/.test(result.body)) throw new XidianError('login_required')
        delete session.challenge; await persist(); return
      }
      url = result.location
    }
    throw new XidianError('auth_redirect_limit')
  }
  async function captcha(): Promise<void> {
    const result = json((await request(`${IDS}/authserver/common/openSliderCaptcha.htl?_=${Date.now()}`)).body)
    if (typeof result.bigImage !== 'string' || typeof result.smallImage !== 'string') throw new XidianError('captcha_protocol_changed')
    const offset = await options.solveCaptcha({ bigImage: result.bigImage, smallImage: result.smallImage })
    if (!Number.isInteger(offset) || offset < 0 || offset > 280) throw new XidianError('captcha_failed')
    const piece = Buffer.from(result.smallImage, 'base64')
    if (piece.length < 16) throw new XidianError('captcha_protocol_changed')
    // Preserve upstream's complete track/encryption protocol. One puzzle, at most seven
    // neighbouring offsets; never multiply by its six-puzzle retry loop.
    for (const delta of [1,-1,2,-2,3,-3,4]) {
      const move = offset+delta
      if (move < 0 || move > 280) continue
      const count = randomInt(10,15), norm = 1/(1+Math.exp(-7*(1-.42)))
      const tracks = [{ a:0,b:0,c:0 }]; let b = 0
      for (let i=0; i<count; i++) {
        const z = (1/(1+Math.exp(-7*(i/count-.42))))/norm
        const a = Math.min(move-1,Math.max(tracks.at(-1)!.a+1,Math.round(move*z)))
        const r = Math.random()
        b = Math.max(-10,Math.min(10,b+(r<.65 ? -1 : r<.8 ? 1 : 0)))
        tracks.push({ a,b,c:randomInt(300,501) })
      }
      tracks.push({ a:move,b,c:randomInt(300,501) })
      const alphabet = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678'
      const nonce = Array.from({length:80},()=>alphabet[randomInt(alphabet.length)]).join('')
      const cipher = createCipheriv('aes-128-cbc',piece.subarray(-16),Buffer.from(nonce.slice(64)))
      const payload = nonce.slice(0,64)+JSON.stringify({canvasLength:280,moveLength:move,tracks})
      const sign = Buffer.concat([cipher.update(payload,'utf8'),cipher.final()]).toString('base64')
      await new Promise(resolve=>setTimeout(resolve,Math.max(tracks.at(-1)!.c-100,0)))
      const verified = json((await request(`${IDS}/authserver/common/verifySliderCaptcha.htl`,{sign})).body)
      if (verified.errorCode === 1) return
    }
    throw new XidianError('captcha_failed')
  }
  async function login(): Promise<void> {
    const loginUrl = `${IDS}/authserver/login?${new URLSearchParams({ service: SERVICE })}`
    let response = await request(loginUrl)
    if (response.location) return follow(response.location)
    const document = new JSDOM(response.body).window.document
    const continuation = document.querySelector('form#continue')
    if (continuation) {
      const fields = Object.fromEntries([...continuation.querySelectorAll('input[name]')].map(i => [i.getAttribute('name')!,i.getAttribute('value') ?? '']))
      response = await request(loginUrl, fields)
      if (response.location) return follow(response.location)
      throw new XidianError('auth_protocol_changed')
    }
    const form = document.querySelector('form#pwdFromId')
    if (!form) throw new XidianError('auth_protocol_changed')
    const fields: Record<string,string> = {}
    for (const name of ['pwdEncryptSalt','lt','execution']) {
      const inputs = [...form.querySelectorAll('input[type="hidden"]')].filter(i => i.id === name || i.getAttribute('name') === name)
      const value = inputs[0]?.getAttribute('value')
      if (inputs.length !== 1 || value == null || (name !== 'lt' && !value)) throw new XidianError('auth_protocol_changed')
      fields[name] = value
    }
    await request(`${IDS}/authserver/bfp/info?${new URLSearchParams({ bfp: session.fingerprint })}`)
    await captcha()
    const password = encryptPassword(options.credentials.password, fields.pwdEncryptSalt!)
    delete fields.pwdEncryptSalt
    await options.beforePasswordLogin()
    response = await request(loginUrl, { ...fields, username: options.credentials.username, password,
      rememberMe: 'true', cllt: 'userNameLogin', dllt: 'generalLogin', _eventId: 'submit' })
    if (!response.location) throw new XidianError('password_rejected')
    await follow(response.location)
  }
  async function table(name: string, module: string, form: Record<string,string> = {}): Promise<Record<string,unknown>[]> {
    const result = await request(`${EHALL}/jwapp/sys/wdkb/modules/${module}/${name}.do`, form)
    if (result.location || /pwdFromId/.test(result.body)) throw new XidianError('login_required')
    return rowsOf(json(result.body), name)
  }
  async function fetchTimetable(now: number): Promise<TimetableSnapshot> {
    // Check eHall before re-authenticating. A valid cookie never triggers a password attempt.
    let semesters: Record<string,unknown>[]
    try { semesters = await table('dqxnxq','jshkcb') }
    catch (error) { if (!(error instanceof XidianError) || error.code !== 'login_required') throw error
      if (session.challenge) throw new XidianError('human_verification_required')
      await login(); semesters = await table('dqxnxq','jshkcb') }
    const semester = semesters[0]?.DM
    if (typeof semester !== 'string' || !/^\d{4}-\d{4}-[123]$/.test(semester)) throw new XidianError('invalid_semester')
    const calendar = await table('cxjcs','jshkcb',{ XN: semester.split('-').slice(0,2).join('-'), XQ: semester.split('-')[2]! })
    const termStart = calendar[0]?.XQKSRQ
    if (typeof termStart !== 'string') throw new XidianError('invalid_term_anchor')
    const form = { XNXQDM: semester, XH: options.credentials.username, pageSize: '2000', pageNumber: '1' }
    const rows = await table('xskcb','xskcb',form)
    const unarranged = await table('cxxsllsywpk','xskcb',form)
    const changes = await table('xsdkkc','xskcb',{ XNXQDM: semester, '*order': '-SQSJ', pageSize:'2000', pageNumber:'1' })
    return buildTimetable({ semester, termStart, rows, unarranged, changes, fetchedAt: now })
  }
  let deliveryUsername = options.credentials.username
  async function prepareVerification(): Promise<void> {
    if (!session.challenge) throw new XidianError('no_verification_pending')
    const page = await request(session.challenge)
    deliveryUsername = /"reAuthUserId"\s*:\s*"([^"\\]+)"/.exec(page.body)?.[1] ?? options.credentials.username
    await request(`${IDS}/authserver/bfp/info?${new URLSearchParams({ bfp: session.fingerprint })}`)
    const result = json((await request(`${IDS}/authserver/reAuthCheck/changeReAuthType.do`, {
      isMultifactor: new URL(session.challenge).searchParams.get('isMultifactor') ?? 'true', reAuthType: '3', service: SERVICE,
    })).body)
    if (String(result.code) !== '1') throw new XidianError('verification_expired')
  }
  return { fetchTimetable,
    async sendVerificationCode(): Promise<void> {
      await prepareVerification()
      // Never log the delivery response, which may include a phone number.
      const result = json((await request(`${IDS}/authserver/dynamicCode/getDynamicCodeByReauth.do`, {
        userName: deliveryUsername, authCodeTypeName: 'reAuthDynamicCodeType',
      })).body)
      if (!['success','other_success','wechat_success','code_time_fail'].includes(String(result.res))) throw new XidianError('verification_delivery_failed')
    },
    async submitVerificationCode(code: string): Promise<void> {
      if (!/^\d{4,8}$/.test(code)) throw new XidianError('invalid_verification_code')
      await prepareVerification()
      const result = json((await request(`${IDS}/authserver/reAuthCheck/reAuthSubmit.do`, {
        service: SERVICE, reAuthType:'3', isMultifactor: new URL(session.challenge!).searchParams.get('isMultifactor') ?? 'true',
        password:'', dynamicCode:code, uuid:'', answer1:'', answer2:'', otpCode:'', skipTmpReAuth:'true',
      })).body)
      if (result.code !== 'reAuth_success') throw new XidianError('verification_rejected')
      delete session.challenge; await persist()
      await login()
    },
  }
}
