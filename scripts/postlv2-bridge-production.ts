/** Formal avatar entry: production credentials and the existing guarded ChatSession. */
import { config } from 'dotenv'
import { assertProductionAvatarEnvironment } from './postlv2-production-env.ts'

assertProductionAvatarEnvironment(process.env, process.cwd())
const productionConfig = config({ path: '.env', override: true, quiet: true })
if (!productionConfig.parsed?.OPENAI_API_KEY?.trim()) throw new Error('Formal avatar requires .env OPENAI_API_KEY')
assertProductionAvatarEnvironment(process.env, process.cwd())
process.env.CHARACTER_EXPRESSIVE_SPEECH = 'true'
process.argv = [process.argv[0]!, process.argv[1]!, '--bridge']
await import('../src/main.ts')
