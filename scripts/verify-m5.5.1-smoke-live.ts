/** ADR-141: provider-specific Tavily live gate retired; historical evidence remains unchanged. */
console.error('This Tavily live gate is retired. Use pnpm with-test-model pnpm search:native:live with an explicit DeepSeek test credential. Historical PASS does not validate the native provider.')
process.exitCode = 2