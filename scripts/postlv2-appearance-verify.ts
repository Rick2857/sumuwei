/** Clothing/effect overlays against real asset definitions; Cubism rendering and audio are stubs. */
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { createAppearanceController } = await import(pathToFileURL(resolve('scripts/postlv2_appearance_client.js')).href)
const { createExpressionPlayback } = await import(pathToFileURL(resolve('scripts/postlv2_expression_client.js')).href)
type Preset = { id: string; parameters: { Id: string; Value: number }[] }
const definition: { costumes: Preset[]; effects: Preset[] } = JSON.parse(readFileSync(resolve(homedir(), 'postlv2-deps/Open-LLM-VTuber-Web-source/src/renderer/src/utils/postlv2-appearance.json'), 'utf8'))
const checks: string[] = []
function check(name: string, body: () => void) { body(); checks.push(name) }
const ownedIds = [...new Set<string>([...definition.costumes, ...definition.effects].flatMap(item => item.parameters.map(p => p.Id)))]
const ids = [...ownedIds, 'ParamAngleY', 'ParamAngleZ', 'ParamMouthOpenY', 'ParamEyeLOpen']
const defaults: number[] = ids.map(id => id === 'V0101_Param3' ? 1 : 0)
const values = [...defaults]
values[ids.indexOf('ParamMouthOpenY')] = 0.7
values[ids.indexOf('ParamEyeLOpen')] = 0.4
const baseline = [...values]
let rendered: number[] = []
const core = {
  getParameterCount: () => ids.length,
  getParameterId: (i: number) => ({ getString: () => ({ s: ids[i] }) }),
  getParameterValueByIndex: (i: number) => values[i],
  setParameterValueByIndex: (i: number, value: number) => { values[i] = value },
  getParameterDefaultValue: (i: number) => defaults[i],
  getParameterMinimumValue: () => 0,
  getParameterMaximumValue: (i: number) => ids[i] === 'e_Param110' ? 24 : 30,
  update: () => { rendered = [...values] },
}
const original = core.update
const model = { _model: core, _modelSetting: { getModelFileName: () => 'ulvm2_0001.moc3' } }
const appearance = createAppearanceController(definition)
const value = (id: string) => rendered[ids.indexOf(id)]
check('three real costumes and thirteen effects; no face/mouth/head parameters owned', () => {
  assert.equal(definition.costumes.length, 3)
  assert.equal(definition.effects.length, 13)
  assert.ok(ownedIds.every(id => !id.startsWith('ParamAngle') && !id.startsWith('ParamMouth') && !id.startsWith('ParamEye')))
  assert.equal(appearance.bind(model), true)
})
check('costumes switch exclusively and return to native original', () => {
  for (const [preset, enabled] of [['costume_v0000', 'v0000_Param8'], ['costume_v0052', 'v0052_Param3'], ['costume_v0101', 'V0100Param44']]) {
    assert.equal(appearance.setCostume(preset), true)
    core.update()
    assert.equal(value(enabled), 1)
    for (const other of ['v0000_Param8', 'v0052_Param3', 'V0100Param44'].filter(id => id !== enabled)) assert.equal(value(other), 0)
  }
  appearance.setCostume('original')
  core.update()
  assert.equal(value('V0101_Param3'), 1)
  assert.deepEqual(values, baseline)
})
check('all effects can be enabled and individually disabled without accumulation', () => {
  for (const item of definition.effects) {
    appearance.setEffect(item.id, true)
    core.update()
    core.update()
    for (const p of item.parameters) assert.equal(value(p.Id), defaults[ids.indexOf(p.Id)] + p.Value)
    appearance.setEffect(item.id, false)
    core.update()
    for (const p of item.parameters) assert.equal(value(p.Id), defaults[ids.indexOf(p.Id)])
  }
  assert.deepEqual(values, baseline)
})
check('multiple effects coexist; clearing effects preserves clothing', () => {
  appearance.setCostume('costume_v0052')
  appearance.setEffect('fx_1_heart', true)
  appearance.setEffect('fx_3_note', true)
  core.update()
  assert.equal(value('e_Param48'), 1)
  assert.equal(value('e_Param61'), 1)
  appearance.clearEffects()
  core.update()
  assert.equal(value('v0052_Param3'), 1)
  assert.equal(value('e_Param48'), 0)
  assert.equal(value('e_Param61'), 0)
})
let clock = 0
const adapter = { setExpression() {}, getExpressionCount: () => 3, getExpressionName: (i: number) => ['neutral', 'smile', 'surprised'][i] }
const speech = createExpressionPlayback(() => model, () => adapter, () => clock)
const meta = { version: 'lg-expression@1', generation: 1, replyId: 'r', segmentId: 'r#0', cue: 'reassuring', expression: 'smile', gesture: 'nod' }
const audio = { pause() {}, dispatchEvent() {} }
check('speech nod, mouth and eye movement coexist with clothing and effects', () => {
  appearance.setEffect('fx_1_heart', true)
  speech.begin(1)
  speech.start(meta, audio)
  clock = 350
  core.update()
  assert.ok(value('ParamAngleY') > 0)
  assert.equal(value('v0052_Param3'), 1)
  assert.equal(value('e_Param48'), 1)
  assert.equal(value('ParamMouthOpenY'), 0.7)
  assert.equal(value('ParamEyeLOpen'), 0.4)
  assert.deepEqual(values, baseline)
})
check('natural speech end and interruption both retain manual selections', () => {
  speech.finish('r#0')
  core.update()
  assert.equal(value('v0052_Param3'), 1)
  speech.start({ ...meta, segmentId: 'r#1' }, audio)
  appearance.setCostume('costume_v0101')
  speech.stop('interrupted')
  core.update()
  assert.equal(value('V0100Param44'), 1)
  assert.equal(value('e_Param48'), 1)
  speech.disconnect()
  core.update()
  assert.equal(value('V0100Param44'), 1)
})
check('unknown manual commands are rejected; LLM costume cue remains rejected', () => {
  const before = appearance.reading()
  assert.equal(appearance.setCostume('arbitrary'), false)
  assert.equal(appearance.setEffect('ParamMouthOpenY', true), false)
  assert.deepEqual(appearance.reading(), before)
  speech.begin(1)
  assert.equal(speech.canPlay({ ...meta, expression: 'costume_v0052' }), false)
})
check('unbinding under an active speech hook disables old appearance writes', () => {
  speech.start({ ...meta, segmentId: 'r#2' }, audio)
  appearance.unbind()
  core.update()
  assert.equal(value('V0100Param44'), 0)
  assert.equal(value('e_Param48'), 0)
  speech.finish('r#2')
  core.update()
  appearance.bind(model)
})
check('unbind restores owned hook; wrong or incomplete models receive no writes', () => {
  appearance.unbind()
  assert.equal(core.update, original)
  assert.equal(appearance.bind({ ...model, _modelSetting: { getModelFileName: () => 'other.moc3' } }), false)
  assert.equal(appearance.bind({ ...model, _model: { ...core, getParameterCount: () => 1 } }), false)
  assert.equal(core.update, original)
  assert.equal(appearance.bind(model), true)
  core.update()
  assert.equal(value('V0100Param44'), 1)
  appearance.unbind()
})
const out = resolve('artifacts/post-lv2/appearance-controls-20261004')
mkdirSync(out, { recursive: true })
writeFileSync(resolve(out, 'offline.json'), JSON.stringify({ scope: 'real asset definitions with Cubism/audio stubs; no model calls or database', passed: checks.length, checks }, null, 2) + '\n')
console.log(`Appearance offline checks PASS ${checks.length}/${checks.length}`)
