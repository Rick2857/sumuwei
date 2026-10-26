import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { startStory, advanceFromProposal } from '../../src/kernel/storyline/world-machine.ts'
import { STORY_ENDING_IDS, type StoryContentPack } from '../../src/kernel/storyline/story-types.ts'

export type State = { shape: number; colour: number; fuel: number; refill: boolean }
export type Rule = { action: string; op: 'add' | 'set' | 'refill'; field: 'shape' | 'colour' | 'fuel'; value: number; cost: number }
export type Sample = { before: State; action: string; after: State }
export type World = ReturnType<typeof makeWorld>
export const ACTIONS = ['key_a', 'key_b', 'key_c'] as const
export const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const key = (s: State): string => `n_${s.shape}_${s.colour}_${s.fuel}_${Number(s.refill)}`
export const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
export const goalReached = (s: State, goal: Pick<State, 'shape' | 'colour'>): boolean => s.shape === goal.shape && s.colour === goal.colour

export function makeWorld(index: number) {
  const [shapeMod, colourMod, shapeDelta, colourDelta, shapeCost, colourCost] = [
    [5, 4, 2, 1, 2, 1], [4, 5, 1, 2, 2, 1], [5, 4, 1, 3, 1, 2],
    [4, 5, 3, 1, 2, 1], [5, 5, 3, 2, 1, 2], [4, 3, 3, 2, 1, 2],
  ][index]
  const capacity = 6
  const shift = Math.floor(index / 2)
  const rules: Rule[] = [
    { action: ACTIONS[shift % 3], op: 'add', field: 'shape', value: shapeDelta, cost: shapeCost },
    { action: ACTIONS[(shift + 1) % 3], op: 'add', field: 'colour', value: colourDelta, cost: colourCost },
    { action: ACTIONS[(shift + 2) % 3], op: 'refill', field: 'fuel', value: capacity, cost: 0 },
  ]
  // Author-side mechanics; the learned interpreter below does not call this.
  const authorStep = (s: State, action: string): State | undefined => {
    if (action === rules[2].action) return s.refill ? { ...s, fuel: capacity, refill: false } : undefined
    if (action === rules[0].action && s.fuel >= shapeCost) return { ...s, shape: (s.shape + shapeDelta) % shapeMod, fuel: s.fuel - shapeCost }
    if (action === rules[1].action && s.fuel >= colourCost) return { ...s, colour: (s.colour + colourDelta) % colourMod, fuel: s.fuel - colourCost }
    return undefined
  }
  const states: State[] = []
  for (let shape = 0; shape < shapeMod; shape++) for (let colour = 0; colour < colourMod; colour++)
    for (let fuel = 0; fuel <= capacity; fuel++) for (const refill of [true, false]) states.push({ shape, colour, fuel, refill })
  const start: State = { shape: 0, colour: 0, fuel: 2, refill: true }
  const pack: StoryContentPack = {
    storyId: `world-model-pilot-${index}`, storyVersion: 1, contentDigest: hash(rules), title: 'Synthetic badge laboratory',
    variables: [
      { name: 'shape', range: { kind: 'int', min: 0, max: shapeMod - 1 }, initial: 0 },
      { name: 'colour', range: { kind: 'int', min: 0, max: colourMod - 1 }, initial: 0 },
      { name: 'fuel', range: { kind: 'int', min: 0, max: capacity }, initial: 2 },
      { name: 'refill', range: { kind: 'bool' }, initial: true },
    ],
    nodes: states.map(s => ({ id: key(s), stage: 'prepare_and_drill', choices: ACTIONS.filter(a => authorStep(s, a)), visibleEvents: [] })),
    transitions: states.flatMap(s => ACTIONS.flatMap(action => {
      const next = authorStep(s, action)
      return next ? [{ from: key(s), choice: action, to: key(next), setVariables: next }] : []
    })),
    entryNodeId: key(start), exitNodes: [key(start)],
    endings: STORY_ENDING_IDS.map(id => ({ id, nodeId: `end_${id}` })),
    endingTransitions: STORY_ENDING_IDS.filter(id => id !== 'exited_by_user').map(ending => ({ from: key(start), to: `end_${ending}`, ending, rule: 'pilot_scoring_only' })),
  }
  for (const ending of pack.endings) (pack.nodes as { id: string; stage: 'result_and_review'; choices: string[]; visibleEvents: string[] }[]).push({ id: ending.nodeId, stage: 'result_and_review', choices: [], visibleEvents: [] })
  const edges = new Map(pack.transitions.map(t => [`${t.from}:${t.choice}`, t.setVariables as State]))
  const oracleStep = (s: State, a: string) => edges.get(`${key(s)}:${a}`)
  const publicInterface = { shapeMod, colourMod, capacity, actions: ACTIONS, maxActions: 8 }
  return { index, pack, rules, start, states, publicInterface, oracleStep }
}

export function execute(w: World, start: State, plan: readonly string[]): { state: State; valid: boolean; trace: Sample[] } {
  const pack = { ...w.pack, entryNodeId: key(start), variables: w.pack.variables.map(v => ({ ...v, initial: start[v.name as keyof State] })) }
  let state = startStory({ pack, runId: 'isolated-pilot', now: 0 as never }).state
  const trace: Sample[] = []
  for (const action of plan) {
    const before = { ...state.variables } as State
    const result = advanceFromProposal(pack, state, { proposedBy: 'rules', choiceId: action, expectedRevision: state.revision, expectedStoryVersion: 1 }, 0 as never)
    if (!result.ok) return { state: before, valid: false, trace: [...trace, { before, action, after: before }] }
    state = result.state
    trace.push({ before, action, after: { ...state.variables } as State })
  }
  return { state: { ...state.variables } as State, valid: true, trace }
}

export function parseRules(raw: unknown): Rule[] {
  assert(raw && typeof raw === 'object' && !Array.isArray(raw))
  const r = raw as Record<string, unknown>
  assert.deepEqual(Object.keys(r).sort(), ['rulebook', 'rules'])
  assert(typeof r.rulebook === 'string' && r.rulebook.length > 0 && r.rulebook.length <= 4000)
  assert(Array.isArray(r.rules) && r.rules.length === 3)
  assert(r.rules.every(x => x && typeof x === 'object' && !Array.isArray(x)))
  const rules = r.rules as Rule[]
  assert.deepEqual(rules.map(x => x.action).sort(), [...ACTIONS])
  for (const item of rules) {
    assert.deepEqual(Object.keys(item).sort(), ['action', 'cost', 'field', 'op', 'value'])
    assert(['add', 'set', 'refill'].includes(item.op) && ['shape', 'colour', 'fuel'].includes(item.field))
    assert(Number.isInteger(item.value) && item.value >= 0 && item.value <= 6)
    assert(Number.isInteger(item.cost) && item.cost >= 0 && item.cost <= 3)
    assert(item.op === 'refill' ? item.field === 'fuel' && item.cost === 0 : item.field !== 'fuel')
  }
  return rules
}

export function predict(info: World['publicInterface'], rules: Rule[], s: State, action: string): State | undefined {
  const r = rules.find(x => x.action === action)
  if (!r || s.fuel < r.cost || (r.op === 'refill' && !s.refill)) return undefined
  if (r.op === 'refill') return r.value <= info.capacity ? { ...s, fuel: r.value, refill: false } : undefined
  const mod = r.field === 'shape' ? info.shapeMod : info.colourMod
  const value = r.op === 'add' ? (s[r.field] + r.value) % mod : r.value
  if (value >= mod) return undefined
  return { ...s, [r.field]: value, fuel: s.fuel - r.cost }
}

export function search(start: State, goal: Pick<State, 'shape' | 'colour'>, step: (s: State, a: string) => State | undefined): string[] | undefined {
  const queue = [{ state: start, plan: [] as string[] }]
  const seen = new Set([key(start)])
  for (let i = 0; i < queue.length; i++) {
    const { state, plan } = queue[i]
    if (goalReached(state, goal)) return plan
    if (plan.length >= 8) continue
    for (const action of ACTIONS) {
      const next = step(state, action)
      if (next && !seen.has(key(next))) { seen.add(key(next)); queue.push({ state: next, plan: [...plan, action] }) }
    }
  }
  return undefined
}

export function observations(w: World): { initial: Sample[]; additional: Sample[] } {
  const initial = ACTIONS.map(action => ({ before: { shape: 0, colour: 0, fuel: 4, refill: true }, action }))
  const additional = ACTIONS.flatMap(action => [
    { before: { shape: 1, colour: 1, fuel: 3, refill: true }, action },
    { before: { shape: w.publicInterface.shapeMod - 1, colour: w.publicInterface.colourMod - 1, fuel: 0, refill: false }, action },
  ])
  const observe = (x: { before: State; action: string }): Sample => ({ ...x, after: execute(w, x.before, [x.action]).state })
  return { initial: initial.map(observe), additional: additional.map(observe) }
}

export function replay(w: World, rules: Rule[], samples: Sample[]): boolean {
  return samples.every(x => equal(predict(w.publicInterface, rules, x.before, x.action) ?? x.before, x.after))
}

export function casesFor(w: World) {
  const obs = observations(w)
  const observed = new Set([...obs.initial, ...obs.additional].map(s => `${key(s.before)}:${s.action}`))
  const probes = w.states.filter(s => s.fuel === 5 && s.shape === 2 && s.colour === 2).flatMap(before => ACTIONS.map(action => ({ before, action })))
  assert(probes.every(p => !observed.has(`${key(p.before)}:${p.action}`)))
  const goals: { shape: number; colour: number }[] = []
  for (let shape = w.publicInterface.shapeMod - 1; shape >= 0; shape--) for (let colour = w.publicInterface.colourMod - 1; colour >= 0; colour--) {
    const goal = { shape, colour }
    const plan = search(w.start, goal, w.oracleStep)
    if (plan && plan.length >= 4 && plan.includes(w.rules[2].action)) goals.push(goal)
  }
  assert(goals.length >= 2)
  return goals.slice(0, 2).map((goal, i) => ({ id: `w${w.index}-g${i}`, world: w.index, publicInterface: w.publicInterface, initial: obs.initial, additional: obs.additional, start: w.start, goal, probes }))
}

export function verify(): number {
  let controls = 0
  assert.equal(new Set(Array.from({ length: 6 }, (_, i) => {
    const w = makeWorld(i)
    return hash([w.publicInterface.shapeMod, w.publicInterface.colourMod, w.rules.map(({ action: _, ...r }) => r)])
  })).size, 6); controls++
  for (let i = 0; i < 6; i++) {
    const w = makeWorld(i), obs = observations(w), samples = [...obs.initial, ...obs.additional]
    assert(replay(w, w.rules, samples)); controls++
    const wrong = w.rules.map(r => r.op === 'add' ? { ...r, op: 'set' as const } : r)
    assert(replay(w, wrong, obs.initial) && !replay(w, wrong, samples)); controls++
    for (const c of casesFor(w)) {
      const oracle = search(c.start, c.goal, w.oracleStep)!
      assert(goalReached(execute(w, c.start, oracle).state, c.goal)); controls++
      const learned = search(c.start, c.goal, (s, a) => predict(w.publicInterface, w.rules, s, a))!
      assert.equal(learned.length, oracle.length)
      assert(goalReached(execute(w, c.start, learned).state, c.goal)); controls++
      assert(!goalReached(execute(w, c.start, []).state, c.goal)); controls++
    }
    assert(!execute(w, w.start, ['invented_action']).valid); controls++
    assert.throws(() => parseRules({ rulebook: 'bad', rules: w.rules, shell: 'no' })); controls++
  }
  return controls
}
