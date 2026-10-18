/** ADR-141: reuse the selected DeepSeek credential; never send another provider's key here. */
export const DEEPSEEK_SEARCH_ENDPOINT = 'https://api.deepseek.com/anthropic/v1/messages'
export const DEEPSEEK_SEARCH_PROVIDER_ID = 'deepseek-native'
export const DEEPSEEK_SEARCH_TIMEOUT_MS = 15_000
export const DEEPSEEK_SEARCH_TOTAL_TIMEOUT_MS = 30_000
export const DEEPSEEK_SEARCH_MAX_PAGES = 2
export const DEEPSEEK_SEARCH_TEST_KEY_ENV = 'DEEPSEEK_SEARCH_TEST_API_KEY'

export interface DeepSeekSearchConfig {
  apiKey: string
  model: string
}

export function loadDeepSeekSearchConfig(
  options: { env?: NodeJS.ProcessEnv; isTestMode?: boolean } = {}
): DeepSeekSearchConfig {
  const env = options.env ?? process.env
  const officialRoute = env.OPENAI_BASE_URL?.replace(/\/$/, '') === 'https://api.deepseek.com'
  const test = options.isTestMode === true || env.DSH_TEST_MODEL_WRAPPER === '1'
  // A test using another chat provider must supply an explicit DeepSeek test credential.
  const apiKey = test ? env[DEEPSEEK_SEARCH_TEST_KEY_ENV] : officialRoute ? env.OPENAI_API_KEY : undefined
  const model = test ? env.DEEPSEEK_SEARCH_TEST_MODEL ?? 'deepseek-flash' : env.OPENAI_LARGE_MODEL
  if (!apiKey?.trim() || /\s/.test(apiKey) || !model?.trim() || /\s/.test(model)) {
    throw new Error(test ? 'native_search_test_config_missing' : 'native_search_requires_official_deepseek_route')
  }
  return { apiKey, model }
}
