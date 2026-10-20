/** Subprocess fixture: load the actual main import graph without invoking main. */
import assert from 'node:assert/strict'
import nodeModule from 'node:module'
import net from 'node:net'
import ts from 'typescript'

const mode = process.argv[2]
assert.equal(typeof nodeModule.registerHooks, 'function', 'this load-graph check needs a Node build with registerHooks; runtime use does not')
assert(['default', 'enabled', 'injected'].includes(mode))
const mainUrl = new URL('../src/main.ts', import.meta.url).href
const featureUrl = new URL('../src/features/lv25/index.ts', import.meta.url).href
const loaded = new Set<string>()
let mainSuppressed = false
let connectionAttempts = 0
net.Socket.prototype.connect = function () {
  connectionAttempts += 1
  throw new Error('offline_probe_connection_forbidden')
} as typeof net.Socket.prototype.connect
globalThis.fetch = async () => { throw new Error('offline_probe_fetch_forbidden') }

const isMainInvocation = (node: ts.Expression): boolean => {
  if (!ts.isCallExpression(node)) return false
  if (ts.isIdentifier(node.expression)) return node.expression.text === 'main'
  return ts.isPropertyAccessExpression(node.expression) && isMainInvocation(node.expression.expression)
}
nodeModule.registerHooks({
  load(url, context, nextLoad) {
    if (/\/(?:features\/lv25|kernel\/storyline|kernel\/app\/storyline|infrastructure\/storyline|content\/storyline)\//.test(url) ||
        /\/(?:story-cognition|story-start-command|story-withdraw-command|openai-story-choice)\.ts(?:\?|$)/.test(url) ||
        /\/inkjs\//.test(url)) loaded.add(url)
    const result = nextLoad(url, context)
    if (url !== mainUrl) return result
    assert(result.source !== undefined && result.source !== null)
    const bytes = result.source
    const text = typeof bytes === 'string' ? bytes : Buffer.from(ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes)).toString()
    const ast = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true)
    const invocations = ast.statements.filter(node => ts.isExpressionStatement(node) && isMainInvocation(node.expression))
    assert.equal(invocations.length, 1, 'probe must suppress exactly the real main invocation')
    const invocation = invocations[0]
    mainSuppressed = true
    const source = text.slice(0, invocation.getFullStart()) + text.slice(invocation.end) +
      (mode === 'injected' ? '\nimport ' + JSON.stringify(featureUrl) + '\n' : '')
    return { ...result, source }
  },
})
await import(mainUrl)
assert(mainSuppressed)
const defaultLoaded = loaded.size
if (mode === 'enabled') {
  const feature = await import(featureUrl)
  assert.equal(typeof feature.createStoryCognition, 'function')
  assert.equal(typeof feature.createOpenAiStoryChoicePort, 'function')
  assert.equal(typeof feature.runStoryStartCommand, 'function')
  assert.equal(typeof feature.runStoryWithdrawCommand, 'function')
  assert(feature.JICHUANG_PACK.storyId)
}
assert.equal(connectionAttempts, 0)
console.log(JSON.stringify({ mode, mainSuppressed, defaultLoaded, featureModulesLoaded: loaded.size, connectionAttempts }))
