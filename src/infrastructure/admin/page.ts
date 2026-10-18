/**
 * A1 / **WP2：首版管理页**（一页 HTML，无构建链 —— `R-A1-1` 批准的"轻量、独立"档）。
 *
 * ============================================================================
 *  三条不可退让（`A1-G4`：页面显示 = 程序事实）
 * ============================================================================
 * ```text
 * ① 页面**不含任何数据**：它是空壳 + 一段脚本，数据一律**现取** `/api/*`（会话必需）
 *    ⇒ 所以"页面显示的是程序事实"是结构性的，而不是渲染时碰巧对
 * ② **密钥不进页面**：脚本不内联任何配置值；`effective_config` 的密钥已由端口遮成 `******`
 * ③ **不知道就说不知道**：`unavailable` 里的字段渲染成「不可用」，**不**渲染成 0/空
 * ```
 * ⚠️ 首版**没有**真浏览器量具 ⇒ "渲染是否正确"要**人**看一眼；机器判据只到
 *    "HTML 可取 · 不含数据/密钥 · 只调用冻结清单里的路径 · 那些路径带会话可取"（见 `a1:page:verify`）。
 */
import { ADMIN_READ_SURFACES } from './query-ports.ts'

/** 转义（HTML 文本位；页面**不**接受任何用户输入，但输出仍按最保守处理） */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 渲染管理页（**纯函数**：只吃冻结清单，不吃任何读数 ⇒ 不可能把数据烤进 HTML）。
 */
export function renderAdminPage(): string {
  const nav = ADMIN_READ_SURFACES.map(
    (surface) =>
      `      <button class="tab" data-path="${escapeHtml(surface.path)}" data-title="${escapeHtml(surface.title)}">${escapeHtml(surface.title)}</button>`
  ).join('\n')
  const paths = JSON.stringify(ADMIN_READ_SURFACES.map((surface) => surface.path))
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>苏沐薇 · 管理后台（A1 首版）</title>
<style>
  :root { color-scheme: light dark }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 12px }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center }
  .tab { padding: 6px 10px; border: 1px solid #8884; border-radius: 6px; background: #8881; cursor: pointer }
  .tab[aria-current="true"] { border-color: #4a8; background: #4a82 }
  table { border-collapse: collapse; margin-top: 12px; width: 100% }
  th, td { border: 1px solid #8884; padding: 4px 8px; text-align: left; vertical-align: top }
  th { background: #8881 }
  .muted { color: #888 }
  .bad { color: #c33 }
  input, button { font: inherit; padding: 6px 8px }
  #banner { margin-top: 10px }
  code { background: #8881; padding: 0 4px; border-radius: 4px }
</style>
</head>
<body>
<h1>苏沐薇 · 管理后台（A1 首版 · 只读）</h1>

<!-- ① 登录（页面本身不含数据；数据在 /api/* 后面，会话必需） -->
<div class="row" id="login">
  <input id="pw" type="password" placeholder="管理口令" autocomplete="current-password">
  <button id="loginBtn">登录</button>
  <span class="muted">口令只发给本机 <code>/login</code>；页面不保存它</span>
</div>

<!-- ② 只读面（清单来自程序冻结档；页面只负责取数与呈现） -->
<div class="row" id="nav" hidden>
${nav}
</div>
<div id="banner" class="muted"></div>
<div id="view"></div>

<script>
(() => {
  'use strict'
  var PATHS = ${paths}
  var current = null
  var banner = document.getElementById('banner')
  var view = document.getElementById('view')
  var nav = document.getElementById('nav')
  var login = document.getElementById('login')

  function setBanner(text, bad) {
    banner.textContent = text || ''
    banner.className = bad ? 'bad' : 'muted'
  }
  function cell(value) {
    if (value === null || value === undefined) return '<span class="muted">不可用</span>'
    if (Array.isArray(value)) return value.length + ' 条'
    if (typeof value === 'object') return '<code>' + JSON.stringify(value) + '</code>'
    return String(value)
  }
  function render(payload) {
    var rows = payload.items || []
    var unavailable = payload.unavailable || []
    var head = []
    rows.forEach(function (row) { Object.keys(row).forEach(function (k) { if (head.indexOf(k) < 0) head.push(k) }) })
    var html = ''
    if (unavailable.length) {
      html += '<div class="bad">不可用：' + unavailable.join(' · ') + '（这一面读不到，页面不把它显示成 0）</div>'
    }
    html += '<table><thead><tr>' + head.map(function (k) { return '<th>' + k + '</th>' }).join('') + '</tr></thead><tbody>'
    rows.forEach(function (row) {
      html += '<tr>' + head.map(function (k) { return '<td>' + cell(row[k]) + '</td>' }).join('') + '</tr>'
    })
    html += '</tbody></table>'
    if (!rows.length && !unavailable.length) html += '<div class="muted">这一面暂时没有行</div>'
    if (payload.nextCursor) html += '<div class="muted">还有下一页（cursor 原样回传，页面不解释它）</div>'
    view.innerHTML = html
    setBanner('读数时刻：' + (payload.generatedAt || '（缺）') + ' · 行数：' + rows.length, false)
  }
  function load(path) {
    current = path
    Array.prototype.forEach.call(nav.querySelectorAll('.tab'), function (b) {
      b.setAttribute('aria-current', b.getAttribute('data-path') === path ? 'true' : 'false')
    })
    fetch(path, { credentials: 'same-origin' }).then(function (response) {
      if (response.status === 401) { setBanner('未登录（先登录）', true); view.innerHTML = ''; return null }
      if (response.status === 501) { setBanner('这一面还没接线（501）—— 不是"没有数据"', true); view.innerHTML = ''; return null }
      if (response.status === 400) { setBanner('请求被拒（400）', true); view.innerHTML = ''; return null }
      if (!response.ok) { setBanner('读失败（' + response.status + '）', true); view.innerHTML = ''; return null }
      return response.json()
    }).then(function (payload) { if (payload) render(payload) })
  }
  nav.addEventListener('click', function (event) {
    var button = event.target.closest('.tab')
    if (button) load(button.getAttribute('data-path'))
  })
  document.getElementById('loginBtn').addEventListener('click', function () {
    var pw = document.getElementById('pw')
    fetch('/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pw.value })
    }).then(function (response) {
      pw.value = ''
      if (response.ok) { login.hidden = true; nav.hidden = false; load(PATHS[0]); return }
      setBanner(response.status === 429 ? '登录被限速（稍后再试）' : '登录失败', true)
    })
  })
  /* 已登录就直接进第一面（cookie 在 HttpOnly 里，脚本读不到、也不需要读） */
  fetch('/session', { credentials: 'same-origin' }).then(function (r) { return r.json() }).then(function (s) {
    if (s && s.authenticated) { login.hidden = true; nav.hidden = false; load(PATHS[0]) }
  })
})()
</script>
</body>
</html>
`
}
