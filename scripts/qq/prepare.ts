/** Prepare independent NapCat configuration; does not start QQ or open LG's database. */
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
  const yukiPath = resolve(process.env.USERPROFILE ?? '', 'Yuki-QQbot/.env')
  const yuki = existsSync(yukiPath) ? parse(readFileSync(yukiPath)) : {}
  env = {
    QQ_OWNER_ID: option('owner'), QQ_BOT_ID: option('bot'), QQ_ONEBOT_WS_URL: 'ws://127.0.0.1:6701/',
    QQ_ONEBOT_ACCESS_TOKEN: randomBytes(32).toString('base64url'),
    QQ_NAPCAT_WEBUI_TOKEN: randomBytes(32).toString('base64url'),
    QQ_NAPCAT_IMAGE: yuki.NAPCAT_IMAGE ?? 'mlikiowa/napcat-docker@sha256:1336a777f9a4f1f8cb89fef42f7548deacd3645919a067a50df5b66b5e77390e',
  }
  if (env.QQ_BOT_ID === yuki.NAPCAT_ACCOUNT) throw new Error('Independent QQ bot must not reuse Yuki account')
  readQqPrivateConfig(env)
  writeFileSync(path, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { flag: 'wx' })
}
const settings = readQqPrivateConfig(env)
const configDir = resolve(root, 'data/qq-private/config')
mkdirSync(configDir, { recursive: true })
mkdirSync(resolve(root, 'data/qq-private/qq'), { recursive: true })
const config = {
  network: {
    httpServers: [], httpClients: [], httpSseServers: [], websocketClients: [],
    websocketServers: [{
      name: 'lg-private-ws', enable: true, host: '0.0.0.0', port: 3001,
      messagePostFormat: 'array', reportSelfMessage: false, token: settings.token, debug: false, heartInterval: 30000,
    }],
  },
  musicSignUrl: '', enableLocalFile2Url: false, parseMultMsg: false,
}
for (const name of ['onebot11.json', `onebot11_${settings.botId}.json`]) {
  writeFileSync(resolve(configDir, name), JSON.stringify(config, null, 2) + '\n')
}
console.log('QQ configuration prepared: independent data/qq-private; existing pinned NapCat image; no service started')
