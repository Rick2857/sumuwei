/** The avatar test entry always opens a copy, through the existing main.ts bridge. */
import 'dotenv/config'
import { config } from 'dotenv'
import { cpSync } from 'node:fs'
import { isolateDatabase, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'

const testConfig = config({ path: '.env.test', override: true, quiet: true })
process.env.CHARACTER_EXPRESSIVE_SPEECH = 'true'
if (!testConfig.parsed?.OPENAI_API_KEY?.trim()) throw new Error('Avatar test requires .env.test OPENAI_API_KEY')
const sandbox = isolateDatabase('postlv2-avatar', { keep: true })
cpSync(PRODUCTION_DB_DIR, sandbox.dir, { recursive: true })
process.argv = [process.argv[0]!, process.argv[1]!, '--bridge']
await import('../src/main.ts')
