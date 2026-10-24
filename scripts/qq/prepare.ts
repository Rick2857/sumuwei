/** Prepare LLBot/PMHQ configuration; does not start QQ or open LG's database. */
import { parse } from 'dotenv'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readQqPrivateConfig } from '../../src/infrastructure/qq/private-config.ts'

const root = resolve(import.meta.dirname, '../..')
const path = resolve(root, '.env.qq')
let env: Record<string, string>
if (existsSync(path)) {
  env = parse(readFileSync(path))
} else {
  const option = (name: string): string => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? ''
  env = {
    QQ_OWNER_ID: option('owner'), QQ_BOT_ID: option('bot'), QQ_ONEBOT_WS_URL: 'ws://127.0.0.1:13001/',
    QQ_ONEBOT_ACCESS_TOKEN: randomBytes(32).toString('base64url'),
  }
}
env.QQ_ONEBOT_WS_URL ||= 'ws://127.0.0.1:13001/'
env.QQ_ONEBOT_ACCESS_TOKEN ||= randomBytes(32).toString('base64url')
const settings = readQqPrivateConfig(env)
env.QQ_ONEBOT_PORT = new URL(settings.wsUrl).port || '80'
env.LLBOT_IMAGE ||= 'linyuchen/llbot@sha256:9a6f187e6792e5d42001997ac3c40e19f6024db0db0d0efdbc9a87f0832a26c8'
env.PMHQ_IMAGE ||= 'linyuchen/pmhq@sha256:7f875d1aa0a0e1baa9d37c4fe6394d6ddce2b50fa1811088629033d13506757f'
env.LLBOT_WEBUI_PORT ||= '13080'
env.LLBOT_WEBUI_TOKEN ||= randomBytes(32).toString('base64url')
env.PMHQ_AUTH_TOKEN ||= ''
delete env.QQ_NAPCAT_IMAGE
delete env.QQ_NAPCAT_WEBUI_TOKEN
const configDir = resolve(root, 'data/qq-llbot/data')
mkdirSync(configDir, { recursive: true, mode: 0o700 })
mkdirSync(resolve(root, 'data/qq-llbot/qq'), { recursive: true, mode: 0o700 })
const config = {
  webui: { enable: true, host: '0.0.0.0', port: 3080 },
  ob11: { enable: true, connect: [{ type: 'ws', enable: true, host: '0.0.0.0', port: 3001,
    token: settings.token, messageFormat: 'array', reportSelfMessage: false,
    reportOfflineMessage: false, debug: false, heartInterval: 5000 }] },
  milky: { enable: false, reportSelfMessage: false,
    http: { host: '127.0.0.1', port: 3010, prefix: '', accessToken: '' }, webhook: { urls: [], accessToken: '' } },
  satori: { enable: false, host: '127.0.0.1', port: 5600, token: '' },
  enableLocalFile2Url: false, log: false, logLevel: 'info', autoDeleteFile: false,
  autoDeleteFileSecond: 60, musicSignUrl: '', msgCacheExpire: 120, ffmpeg: '/usr/bin/ffmpeg',
}
for (const name of ['default_config.json', `config_${settings.botId}.json`]) {
  writeFileSync(resolve(configDir, name), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}
writeFileSync(resolve(configDir, 'webui_token.txt'), env.LLBOT_WEBUI_TOKEN, { mode: 0o600 })
writeFileSync(path, Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 })
console.log('LLBot PMHQ prepared: data/qq-llbot; set PMHQ_AUTH_TOKEN in .env.qq before starting; no service started')
