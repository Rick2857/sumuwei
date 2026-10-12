/** A formal avatar must use the normal main.ts production guard, never a test override. */
import { resolve } from 'node:path'

export function assertProductionAvatarEnvironment(env: NodeJS.ProcessEnv, repoRoot: string): void {
  if (env.PROJECT_LG_SANDBOX !== undefined || env.DSH_TEST_MODEL_WRAPPER !== undefined) {
    throw new Error('Formal avatar refuses sandbox/test-model environment; run postlv2-avatar.cmd for testing')
  }
  if (env.PGLITE_DATA_DIR !== undefined &&
      resolve(repoRoot, env.PGLITE_DATA_DIR).toLowerCase() !== resolve(repoRoot, 'data/pglite').toLowerCase()) {
    throw new Error('Formal avatar requires the normal data/pglite database')
  }
}
