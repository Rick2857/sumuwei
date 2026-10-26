# World-model decision pilot v1.2 (measurement repair; original limits preserved)

During the first authenticated v1.1 batch, request 8 returned HTTP 200 with
completion_tokens=4096, including 4095 reasoning tokens, and no final content.
The adapter throws for missing content; the runner incorrectly classified that
as a transport failure. v1.2 classifies it as output-budget exhaustion and a
failed decision, not a network failure. Four positive/negative classifier checks
are added. The 4096-token limit, prompts, corpus, scoring and decision thresholds
are unchanged. `--resume <directory>` reuses all eight original call records,
checks their prompts byte-for-byte, and performs only the remaining 40 requests.
It never retries the failed decision or overwrites the original batch evidence.
This repair happened after partial results were visible and must be disclosed;
the completed run is continuation evidence, not a pristine independent rerun.

The first v1 attempt on 2026-10-19 produced zero model answers (HTTP 429,
provider quota code 2056). Its evidence is retained separately. Before any
successful model experiment, v1.1 strengthens fixture diversity: six distinct
mechanics, rather than two mechanics with three button relabelings. It also
records HTTP status/provider code and stops immediately on a failed call.
No empirical decision outputs were available when making these changes.

This is a synthetic, database-free mechanism experiment using LG's real S8
`startStory` / `advanceFromProposal` functions. It does not exercise TurnGateway,
the production story, personality, durable memory, or the production model.

## Question and fixed design

Can a model-induced, replay-checked executable environment model improve bounded
decisions over an equally budgeted LLM reasoning baseline?

- Six authored badge worlds; two held-out goals each: 12 paired cases, 48 requests.
- Frozen mechanics (shape modulus, colour modulus, shape increment, colour
  increment, shape fuel cost, colour fuel cost): (5,4,2,1,2,1), (4,5,1,2,2,1),
  (5,4,1,3,1,2), (4,5,3,1,2,1), (5,5,3,2,1,2), (4,3,3,2,1,2).
- Each world has shape, colour, fuel, and a single-use refill. Button IDs are
  permuted; transformation increments, fuel costs and variable ranges vary.
- Both arms receive exactly the same initial transitions, then exactly the same
  additional transitions, current state, goal, probe inputs, and public interface.
- A: first call retains reasoning notes; second call predicts probe outcomes and
  supplies an action sequence directly.
- B: first call induces a textual rulebook and restricted declarative rules;
  second call revises them using the additional evidence. A fixed interpreter
  replays all observed transitions, then breadth-first search plans with the
  learned rules. No author rules or hidden graph enter B's planner.
- Each arm gets two calls, temperature 0, max_tokens 4096 per call, 90 seconds
  per call, no retries. Arm order alternates across cases. Notes/rules from the
  first call are capped at 6000 characters. No cross-case memory.
- HTTP 200 without a usable answer due to output-budget exhaustion counts as a
  failed decision. It does not trigger the transport-failure stop rule.
- Initial examples deliberately admit both addition and constant-setting
  explanations. Additional examples distinguish them. This tests revision and
  unseen state combinations; it does not test active exploration.
- The fixture generator selects goals with an oracle shortest path of 4..8
  actions and requiring the refill. Selection happens before any model call and
  never depends on either arm's result. Both arms are told the 8-action limit.
- The oracle graph exists only on the environment/scoring side. All actual
  action results, including failed/illegal actions, come from S8's state machine.
- Held-out probe transitions must not duplicate observed (state, action) pairs.

## Measurements and frozen decision rule

Primary: number of optimal successful decisions (reaching the goal in the oracle
minimum number of actions with an entirely legal action sequence). Secondary: success within 8 actions, action counts,
probe prediction accuracy, replay acceptance, rule revision, transport/schema
failures, request/token usage and latency. Monetary cost is NOT MEASURED.

Report the following separately:

1. `PILOT_GAIN`: B improves optimal decisions by at least 3/12, with no loss in
   total successful decisions and all 48 requests completed without transport
   failures. Otherwise `NO_DEMONSTRATED_GAIN` or `INCOMPLETE`.
2. Exact two-sided sign test over the six **world clusters**, comparing each
   world's paired optimal-decision counts (ties excluded). p <= .05 is required
   before claiming statistical support; repeated goals are not independent worlds.
   These are six related authored mechanics, not a random sample of real tasks;
   even a significant result supports only this small synthetic benchmark.

Keep every run, including failures. Never repeat or edit a batch to get a green
result. A ceiling baseline is no demonstrated gain. A pilot gain is not proof of
benefit in production or of the paper's complete method.

## Offline controls before spending model calls

- Every authored world and oracle plan runs through the real S8 state machine.
- Wrong learned rules fail replay; restored rules pass.
- An unfalsified but wrong constant-setting hypothesis is rejected by the new
  observations, and a corrected model restores replay and planning.
- Fabricated/illegal actions and broken plans fail environment scoring.
- Generated models are declarative data: no eval, generated code, shell, DB or
  additional tool/network access. Invalid models cannot reach the planner.
- Training and probe sets are disjoint; model prompts omit author models/graphs.

## Commands and evidence

```powershell
pnpm exec tsx evals/world-model-pilot/run.ts --verify
pnpm with-test-model pnpm exec tsx evals/world-model-pilot/run.ts --live
```

Live requires the existing test-model wrapper; never falls back to production
credentials. Synthetic prompts, outputs and measurements are saved under the
already ignored `artifacts/post-lv2/local/world-model-pilot/<runId>/` directory.
The result records source/protocol/corpus hashes and actual endpoint/model. No
production data is read or written. No database is opened.

This is a test of the combined learned representation + replay + search approach.
Both arms have equal LLM request/token **limits**, but B has additional local
search. It cannot isolate the contribution of the natural-language rulebook,
and implements neither arbitrary code compilation nor LLM semantic fidelity
verification. It does not compare against the unmodified production story-choice
recognizer, which recognizes user choices rather than autonomously solving games.
