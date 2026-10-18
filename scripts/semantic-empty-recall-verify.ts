import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createSemanticProbe } from '../src/infrastructure/semantic/semantic-probe.ts'
import { loadEmbeddingManifest, embeddingFingerprintOf } from '../src/infrastructure/semantic/embedding-manifest.ts'
import { asCharacterId, asMemoryId } from '../src/kernel/contracts/ids.ts'
const manifest = loadEmbeddingManifest(resolve('evals/m9.5/embedding-manifest.json'))
let encodes=0,queries=0,indexed=true
const probe = createSemanticProbe({ manifest, db: { execute: async () => {
  queries++
  if(queries===1)return indexed?[{generation_id:'fixture',dimension:manifest.dimension,model_fingerprint:embeddingFingerprintOf(manifest)}]:[]
  return [{memory_id:'memory-fixture',distance:0.25}]
} }, encoder: { encode: async () => {encodes++;return {ok:true,dimension:manifest.dimension,vectors:[Array(manifest.dimension).fill(0)]}} } })
const request={characterId:asCharacterId('character-fixture'),text:'普通闲聊',memoryIds:[]}
assert.deepEqual(await probe.score(request),{ok:false,reason:'missing_score'})
assert.equal(encodes,0,'zero eligible memories must not invoke the encoder')
assert.equal(queries,1)
queries=0
const positive=await probe.score({...request,memoryIds:[asMemoryId('memory-fixture')]})
assert(positive.ok);assert.equal(positive.scores.get('memory-fixture'),0.75);assert.equal(encodes,1)
indexed=false;queries=0
assert.deepEqual(await probe.score(request),{ok:false,reason:'not_indexed'})
assert.equal(encodes,1,'index failures remain visible and never encode')
console.log('PASS empty recall avoids encoding; populated recall preserves exact scores; missing-index diagnosis preserved')
