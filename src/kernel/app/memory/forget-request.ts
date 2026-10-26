/** Only an affirmative command can take the destructive memory fast path. */
export function isExplicitForgetCommand(text: string): boolean {
  const value = text.trim()
  if (/[?？]\s*$/u.test(value)) return false
  return /^(?:(?:嗯|好|行)[，,\s]*)?(?:(?:请|麻烦)(?:你)?|帮我|替我|你)?(?:不要再记|别再记|不要记了|别记了|忘掉|忘记|删掉|删除|清除)/u.test(value)
    || /^(?:(?:请|麻烦)(?:你)?|帮我|替我|你)?把[^，。！？\n]{1,80}(?:删掉|删除|清除|忘掉)[吧。！!\s]*$/u.test(value)
}
