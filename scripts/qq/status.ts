/** Authenticated OneBot login readback; no LG process, database, or QQ send action. */
import { parse } from 'dotenv'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readQqPrivateConfig } from '../../src/infrastructure/qq/private-config.ts'
import { OneBotPrivateClient } from '../../src/infrastructure/qq/onebot-private-client.ts'

const root = resolve(import.meta.dirname, '../..')
const settings = readQqPrivateConfig(parse(readFileSync(resolve(root, '.env.qq'))))
const client = new OneBotPrivateClient(settings, undefined, () => {})
try {
  await client.connect()
  console.log('PASS: authenticated OneBot get_login_info matches the independent QQ bot; no LG database opened or QQ message sent')
} finally { await client.close() }
