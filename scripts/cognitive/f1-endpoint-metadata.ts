/**
 * **非机密端点元数据与摘要**（宿主 / 容器两侧各跑一次，摘要必须一致）。
 *
 * ⚠️ 只读 `OPENAI_BASE_URL` / 模型名 / key 的**长度**；**不**打印、不落盘 key 取值。
 *    用途：G9 的“有效模型参数核对”与封存清单的端点绑定。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { endpointMetadataDigest, endpointMetadataFromEnvText } from './f1-live-runner-guards.ts'

const candidates = [
  process.argv.slice(2).find(item => !item.startsWith('--')),
  process.env.F1_TEST_ENV_FILE,
  process.env.TEST_MODEL_ENV_FILE,
  '/opt/serversim/env/.env.test',
  '.env.test',
]
const file = candidates.find((candidate): candidate is string =>
  candidate !== undefined && candidate.trim() !== '' && existsSync(candidate))
if (file === undefined) {
  console.error('endpoint_env_file_missing（F1_TEST_ENV_FILE / TEST_MODEL_ENV_FILE / .env.test）')
  process.exit(2)
}

const metadata = endpointMetadataFromEnvText(readFileSync(file, 'utf8'))
const digest = endpointMetadataDigest(metadata)
if (process.argv.includes('--digest')) {
  console.log(digest)
} else {
  console.log(JSON.stringify({
    schema: 'f1-endpoint-metadata@1',
    envFile: resolve(file),
    metadata,
    digest,
    note: '只含非机密元数据（host / model / key 长度）；不含 key 取值',
  }, null, 2))
}
