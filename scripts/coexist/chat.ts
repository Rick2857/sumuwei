import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import { createInterface as createPrompt } from 'node:readline/promises'
import { randomUUID } from 'node:crypto'
import { ensureEntryTokens } from './readiness.ts'

const tokens = process.env.CHARACTER_COEXIST_CLI_TOKEN && process.env.CHARACTER_COEXIST_CLI_PORT
  ? { cli: process.env.CHARACTER_COEXIST_CLI_TOKEN, cliPort: Number(process.env.CHARACTER_COEXIST_CLI_PORT) }
  : ensureEntryTokens()
if (!tokens.cli || !tokens.cliPort) throw new Error('先运行 pnpm coexist:prepare 并启动共用核心，配置控制台入口')
const socket = connect({ host: '127.0.0.1', port: tokens.cliPort })
const lines = createInterface({ input: socket })
const pending = new Map<string, { resolve: (text: string) => void; reject: (error: Error) => void }>()
const displayed = new Set<string>()
const ready = new Promise<void>((resolve, reject) => {
  socket.once('connect', () => socket.write(`LG_ENTRY ${tokens.cli}\n`))
  socket.once('error', reject)
  lines.on('line', line => {
    if (line.startsWith('LG_ENTRY_READY cli ')) { resolve(); return }
    if (line.startsWith('LG_ENTRY_REJECTED')) { reject(new Error('控制台入口鉴权失败')); return }
    let message: Record<string, unknown>
    try { message = JSON.parse(line) } catch { return }
    const id = String(message.requestId ?? '')
    if (message.kind === 'DELIVER_REMINDER_TEXT' && message.outcome === 'generated') {
      if (typeof message.reminderText !== 'string' || !message.reminderText.trim() || [...message.reminderText].length > 500) return
      if (!displayed.has(id)) {
        process.stdout.write(`\n【提醒】${message.reminderText}\n`, error => {
          socket.write(`${JSON.stringify({ kind: 'REPORT_REMINDER_DELIVERY', requestId: id, deliveryId: id,
            deliveryStatus: error ? 'failed_confirmed' : 'api_accepted', ...(error ? {} : { messageId: `cli:${id}` }) })}\n`)
        })
        displayed.add(id)
        if (displayed.size > 50) displayed.delete(displayed.values().next().value!)
      }
    }
    if (message.kind === 'TURN_RESULT') {
      const waiter = pending.get(id)
      pending.delete(id)
      if (message.outcome === 'replied') waiter?.resolve(String(message.replyText))
      else waiter?.reject(new Error(`回复失败：${String(message.code ?? message.outcome)}`))
    }
  })
})
socket.on('close', () => {
  for (const waiter of pending.values()) waiter.reject(new Error('共用核心连接已断开'))
  pending.clear()
})
await ready
const prompt = createPrompt({ input: process.stdin, output: process.stdout })
socket.once('close', () => prompt.close())
try {
  console.log('已连接共用核心的控制台文字入口。/exit 退出此入口。')
  for (;;) {
    const text = (await prompt.question('你：')).trim()
    if (text === '/exit') break
    if (!text) continue
    const id = randomUUID()
    const reply = new Promise<string>((resolve, reject) => pending.set(id, { resolve, reject }))
    socket.write(`${JSON.stringify({ kind: 'SUBMIT_TURN', requestId: id, userText: text })}\n`)
    console.log(`\n苏沐薇：${await reply}\n`)
  }
} finally { prompt.close(); lines.close(); socket.end() }
