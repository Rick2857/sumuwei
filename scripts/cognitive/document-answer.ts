/** Evaluation-only exact slot scoring; never passed to a model or imported by src/. */
import { normalizeReference } from './document-quality.ts'
export interface DocumentQuestion {
  id:string;document:string;file:string;sha256:string;page:number;prefixChars:number;region:string;render:string;question:string
  fields:{key:string;accepted:string[];evidenceNeedles:string[]}[]
}
export interface DocumentQuestions {version:string;review:{status:string};questions:DocumentQuestion[]}
const keys=(v:object)=>Object.keys(v).sort().join(',')
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const value=(v:string)=>v.normalize('NFKC').toLowerCase().replace(/\s/g,'')
/** Keys and response contract only: answer aliases and evidence needles remain evaluator-private. */
export function questionText(q:Pick<DocumentQuestion,'page'|'prefixChars'|'question'|'fields'>,path:string){
  return `读取「${path}」第 ${q.page} 页前 ${q.prefixChars} 字的正文\n问题：${q.question} `+
    `仅输出 JSON：answer 为包含 ${q.fields.map(f=>f.key).join(', ')} 的字符串字段对象，无法回答则为 null；basis 为 document、prior 或 insufficient。`+
    `evidence 为逐字段的 {page,quote} 对象，quote 逐字引自实际提供的正文；不依赖正文时 evidence 为 null。不要把已有知识说成文档证据。`
}
export function requireReviewedQuestions(set:DocumentQuestions){
  if(set.version!=='document-questions@1'||set.review.status!=='APPROVED')throw Error('document_answers_require_human_review')
}
export function scoreDocumentAnswer(raw:string,q:DocumentQuestion,visible:{page:number;text:string}[]){
  let response:unknown
  try{response=JSON.parse(raw)}catch{return{schemaValid:false,answerCorrect:false,sourceClaim:'INVALID_RESPONSE' as const}}
  const fieldKeys=q.fields.map(f=>f.key).sort().join(',')
  if(!object(response)||keys(response)!=='answer,basis,evidence'||typeof response.basis!=='string'||!['document','prior','insufficient'].includes(response.basis)
    ||!(response.answer===null||(object(response.answer)&&keys(response.answer)===fieldKeys&&Object.values(response.answer).every(v=>typeof v==='string')))
    ||!(response.evidence===null||(object(response.evidence)&&keys(response.evidence)===fieldKeys&&Object.values(response.evidence).every(e=>
      object(e)&&keys(e)==='page,quote'&&Number.isSafeInteger(e.page)&&typeof e.quote==='string'&&e.quote.trim().length>0&&e.quote.length<=1600))))
    return{schemaValid:false,answerCorrect:false,sourceClaim:'INVALID_RESPONSE' as const}
  const answer=response.answer as Record<string,string>|null,evidence=response.evidence as Record<string,{page:number;quote:string}>|null
  const fields=q.fields.map(f=>({key:f.key,correct:!!answer&&f.accepted.some(a=>value(a)===value(answer[f.key]!)),
    quoteMatched:!!evidence&&evidence[f.key]!.page===q.page&&visible.some(v=>v.page===q.page
      &&normalizeReference(v.text).includes(normalizeReference(evidence[f.key]!.quote))
      &&f.evidenceNeedles.every(n=>normalizeReference(evidence[f.key]!.quote).includes(normalizeReference(n))))}))
  const consistent=response.basis==='document'?!!answer&&!!evidence:response.basis==='prior'?!!answer&&evidence===null:answer===null&&evidence===null
  return{schemaValid:true,contractConsistent:consistent,answerCorrect:fields.every(f=>f.correct),basis:response.basis,fields,
    sourceClaim:!consistent?'INCONSISTENT':response.basis==='document'?(fields.every(f=>f.quoteMatched)?'MATCHED_SPANS':'UNSUPPORTED'):'NOT_CLAIMED',
    correctWithoutVisibleEvidence:fields.every(f=>f.correct)&&!q.fields.every(f=>visible.some(v=>v.page===q.page&&f.evidenceNeedles.every(n=>normalizeReference(v.text).includes(normalizeReference(n)))))}
}
