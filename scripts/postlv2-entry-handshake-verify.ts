/**
 * 入口握手（`LG_ENTRY <token>`）的门。
 *
 * 2026-10-17 · 远程执行缺口 2/4「应用层鉴权」
 *
 * ⚠️ 这道门要证明的不是"正确 token 能过"（那太容易），
 *    而是三件容易做错的事：
 *      ① **长度不同时也必须被拒**（否则 `timingSafeEqual` 的等长前提会漏）
 *      ② **三种失败对外同形**（分���报就等于开了一个 oracle）
 *      ③ **不能引入"前缀一致"假设**（token 前缀相符即可通过是最经典的坑）
 */
import { verifyEntryHandshake, ENTRY_HANDSHAKE_REJECT } from '../src/infrastructure/qq/entry-handshake.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail: string): void => {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}  ${detail}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}  ${detail}`)
  }
}

const TOKEN = 'fixture-'.repeat(4)
const line = (t: string, v?: string): string => (v === undefined ? `LG_ENTRY ${t}` : `LG_ENTRY ${t} ${v}`)

console.log('=== D-H1 正控：正确的 token（带协议版本）===')
{
  const v = verifyEntryHandshake(line(TOKEN, 'v1'), TOKEN)
  check('正确 token + 正确版本通过', v.ok, JSON.stringify(v))
  check('通过时带回版本号', v.ok && v.version === 1, `version=${v.ok ? v.version : '-'}`)
}

console.log('\n=== D-H7 ★ 协议版本（ADR-146 `D07`）===')
{
  const bad: Array<[string, string | undefined]> = [
    ['不带版本（旧形态）', line(TOKEN)],
    ['空版本标记', line(TOKEN, 'v')],
    ['版本号非数字', line(TOKEN, 'vx')],
    ['主版本 0', line(TOKEN, 'v0')],
    ['主版本 2', line(TOKEN, 'v2')],
    ['主版本 99', line(TOKEN, 'v99')],
    ['大写 V', line(TOKEN, 'V1')],
  ]
  for (const [name, input] of bad) {
    const v = verifyEntryHandshake(input, TOKEN)
    const isVer = !v.ok && (v.code === 'version_missing' || v.code === 'version_unsupported')
    check(`${name} ⇒ 版本类失败`, isVer, `code=${v.ok ? '(被采纳!)' : v.code}`)
  }
}

console.log('\n=== D-H7b ★★ token 错时**不能**泄漏"版本"这条信息 ===')
{
  // 反过来先判版本的话，"版本不对"就成了不需要知道 token 就能问出来的 oracle
  const v = verifyEntryHandshake(line('wrong-token', 'v999'), TOKEN)
  check('token 错 + 版本也错 ⇒ 报 token_mismatch（不报版本）', !v.ok && v.code === 'token_mismatch',
    `code=${v.ok ? '(被采纳!)' : v.code}`)
  const v2 = verifyEntryHandshake(line('wrong-token', 'v1'), TOKEN)
  check('token 错（版本正确）⇒ 同样是 token_mismatch', !v2.ok && v2.code === 'token_mismatch',
    `code=${v2.ok ? '(被采纳!)' : v2.code}`)
  const v3 = verifyEntryHandshake(line('wrong-token'), TOKEN)
  check('token 错 + 也不带版本 ⇒ **仍**报 token_mismatch（token 优先）', !v3.ok && v3.code === 'token_mismatch',
    `code=${v3.ok ? '(被采纳!)' : v3.code}`)
}

console.log('\n=== D-H7c token 对但版本错时，对端**能**知道自己版本不对 ===')
{
  const v = verifyEntryHandshake(line(TOKEN, 'v2'), TOKEN)
  check('版本类失败带 version 供诊断', !v.ok && v.version === 2, `version=${v.ok ? '-' : v.version}`)
}

console.log('\n=== D-H2 同长度错误 token 必须被拒 ===')
{
  const wrong = TOKEN.slice(0, -1) + (TOKEN.endsWith('9') ? '8' : '9')
  const v = verifyEntryHandshake(line(wrong), TOKEN)
  check('同长度错 token 被拒', !v.ok, JSON.stringify(v))
}

console.log('\n=== D-H3 ★ 不同长度也必须被拒（长度不泄露、不依赖等长）===')
for (const wrong of ['x', TOKEN + 'extra', TOKEN.slice(0, 5), '']) {
  const v = verifyEntryHandshake(line(wrong), TOKEN)
  const label = wrong === '' ? '(空)' : wrong.length > 12 ? '(更长)' : wrong.length < 12 ? '(更短)' : ''
  check(`长度 ${wrong.length} 的 token 被拒 ${label}`, !v.ok, JSON.stringify(v))
}

console.log('\n=== D-H4 ★ 前缀一致不足以通过（经典坑）===')
{
  const near = `${TOKEN}x`
  const v = verifyEntryHandshake(line(near), TOKEN)
  check('前缀相符但尾部多一字符 ⇒ 仍被拒', !v.ok, JSON.stringify(v))
}

console.log('\n=== D-H5 形状不合法的都归 malformed/empty ===')
{
  const cases: Array<[string, string | undefined]> = [
    ['没有 LG_ENTRY 前缀', 'Bearer abc'],
    ['只有前缀', 'LG_ENTRY '],
    ['空行', '   '],
    ['undefined（对端直接断开）', undefined],
    ['整行是 token 没有前缀', TOKEN],
  ]
  for (const [name, input] of cases) {
    const v = verifyEntryHandshake(input, TOKEN)
    check(name, !v.ok, JSON.stringify(v))
  }
}

console.log('\n=== D-H6 ★ 三种失败对外必须同形（不能开 oracle）===')
{
  const codes = [
    verifyEntryHandshake(undefined, TOKEN),
    verifyEntryHandshake('Bearer abc', TOKEN),
    verifyEntryHandshake(line('wrong'), TOKEN),
  ]
  const shapes = codes.map((c) => (c.ok ? 'ACCEPTED' : ENTRY_HANDSHAKE_REJECT))
  check(
    '三种失败回同一句',
    new Set(shapes).size === 1,
    `实际 = ${JSON.stringify(shapes)}`,
  )
  check(
    '三种失败的**对外**形状与内部 code 不同',
    codes.every((c) => !c.ok) && new Set(codes.map((c) => (c.ok ? '' : c.code)).map((s) => ENTRY_HANDSHAKE_REJECT)).size === 1,
    '内部 code 可用于日志，但不得回给对端',
  )
}

console.log('\n=== D-H7b 空白容忍但不是"随便什么都能过" ===')
{
  // ⚠️ 握手现在是 `LG_ENTRY <token> v1`（ADR-146 `D07`），所以"正确的行"要带版本
  check('前后空白被容忍', verifyEntryHandshake(`  ${line(TOKEN, 'v1')}  \n`, TOKEN).ok, 'trim 后应通过')
  check('token 内部的空格**不被**容忍', !verifyEntryHandshake(`LG_ENTRY  ${TOKEN}`, TOKEN).ok, '多一个空格 ⇒ 前缀吃掉一个后不匹配')
  check('token 后面多一个词（不是 vN）⇒ 拒', !verifyEntryHandshake(`LG_ENTRY ${TOKEN} hello`, TOKEN).ok, '版本位形状不对')
}

console.log('\n=== D-H8 ★ 期望 token 自身为空时必须失败关闭 ===')
{
  const v = verifyEntryHandshake(line('anything', 'v1'), '')
  check('expectedToken 为空 ⇒ 拒绝', !v.ok, JSON.stringify(v))
  const v2 = verifyEntryHandshake(`LG_ENTRY ${TOKEN} v1`, '')
  check('expectedToken 为空时，正确 token 也不该通过', !v2.ok, JSON.stringify(v2))
}

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
