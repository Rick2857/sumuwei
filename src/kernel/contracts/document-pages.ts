import type { CapabilityDefinition } from '../action/capability-registry.ts'
import type { ActionRequest } from '../action/action-request.ts'
import type { ActionResult } from '../action/action-result.ts'

export const DOCUMENT_PAGES = 'document.pages'
export const PDF_PAGES_VERSION = 'pdf-pages@1'
export const PDF_PAGES_PREFIX = 'pdf-pages:'
export const PDF_PAGE_READERS = ['pdfplumber','pdfminer'] as const
export type PdfPageReader = typeof PDF_PAGE_READERS[number]
export const PDF_PAGE_LIMITS = { pages: 4, chars: 1200 } as const
export interface PdfPageGoal { path: string; firstPage: number; lastPage: number; prefixChars?: number }
export interface PdfPagesReceipt {
  protocol: typeof PDF_PAGES_VERSION
  inputFingerprint: string
  reader: PdfPageReader
  firstPage: number
  lastPage: number
  prefixChars: number | null
  pages: { page: number; totalChars: number; includedChars: number }[]
}
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 1
export function validPdfPageRange(first: unknown, last: unknown): boolean {
  return integer(first) && integer(last) && last >= first && last - first < PDF_PAGE_LIMITS.pages
}
export function documentPageGoal(text: string): PdfPageGoal | undefined {
  const m=/^(?:请|帮我|麻烦)?(?:读取|读一下|阅读)\s*(?:「([^」]+\.pdf)」|"([^"\n]+\.pdf)")\s*第\s*(\d+)\s*(?:[-–—至到]\s*(\d+)\s*)?页\s*(?:前\s*(\d+)\s*字)?\s*(?:的正文|正文)[。！!]?$/iu.exec(text.trim())
  if(!m) return undefined
  const path=m[1]??m[2]!,firstPage=Number(m[3]),lastPage=Number(m[4]??m[3]),prefix=m[5]===undefined?undefined:Number(m[5])
  if(!/^(?:\/|[A-Za-z]:[\\/])/.test(path)||/[\x00-\x1f]/.test(path)||!validPdfPageRange(firstPage,lastPage)
    ||(prefix!==undefined&&(!integer(prefix)||prefix>PDF_PAGE_LIMITS.chars)))return undefined
  return{path,firstPage,lastPage,...(prefix===undefined?{}:{prefixChars:prefix})}
}
/** Explicit question attachment is text for the answer, never another action target. */
export function documentPageRequest(text: string): {goal:PdfPageGoal;question?:string} | undefined {
  const plain=documentPageGoal(text)
  if(plain)return{goal:plain}
  const attached=/^([^\r\n]+)\r?\n问题[：:]([^\r\n]+)$/u.exec(text.trim())
  if(!attached)return undefined
  const goal=documentPageGoal(attached[1]!),question=attached[2]!.trim()
  if(!goal||!question||question.length>1000||/[\x00-\x1f\x7f]/.test(question))return undefined
  return{goal,question}
}
export function readPdfPagesReceipt(value: unknown): PdfPagesReceipt | undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined
  const v=value as PdfPagesReceipt
  if(Object.keys(v).sort().join(',')!=='firstPage,inputFingerprint,lastPage,pages,prefixChars,protocol,reader'
    ||v.protocol!==PDF_PAGES_VERSION||!PDF_PAGE_READERS.includes(v.reader)||!validPdfPageRange(v.firstPage,v.lastPage)
    ||typeof v.inputFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(v.inputFingerprint)
    ||!(v.prefixChars===null||(integer(v.prefixChars)&&v.prefixChars<=PDF_PAGE_LIMITS.chars))
    ||!Array.isArray(v.pages)||v.pages.length!==v.lastPage-v.firstPage+1)return undefined
  let included=0
  for(const [i,p] of v.pages.entries()){
    if(!p||Object.keys(p).sort().join(',')!=='includedChars,page,totalChars'||p.page!==v.firstPage+i
      ||!Number.isSafeInteger(p.totalChars)||p.totalChars<0||!Number.isSafeInteger(p.includedChars)||p.includedChars<0
      ||p.includedChars>p.totalChars||(v.prefixChars!==null&&p.includedChars>v.prefixChars))return undefined
    included+=p.includedChars
  }
  return included<=PDF_PAGE_LIMITS.chars?v:undefined
}
export function createDocumentPagesDefinition(): CapabilityDefinition {
  return{id:DOCUMENT_PAGES,version:`${DOCUMENT_PAGES}@1`,description:'读取明确 PDF 的物理页范围，最多 4 页、共 1200 字符；reader 为 pdfplumber/pdfminer，可选 prefixChars 表示每页前缀。截断不代表整页已读完。',
    operations:[{name:'read',description:'有界读取 firstPage 到 lastPage，可绑定 expectedInputFingerprint',sideEffect:'read',riskLevel:'R0'}],
    sideEffectLevel:'read',riskLevel:'R0',permissions:['document:read'],supportsDryRun:true,idempotency:'none'}
}
/** Trusted explicit goal check. Neither model done nor an unrelated successful read is enough. */
export function checkPdfPageGoal(goal: PdfPageGoal, fingerprint: string | undefined,
  results: readonly {request:ActionRequest;result:ActionResult}[], visibleContentIds: readonly string[]) {
  for(const {request,result} of [...results].reverse()){
    if(request.capability!==DOCUMENT_PAGES||request.arguments.path!==goal.path||request.arguments.firstPage!==goal.firstPage
      ||request.arguments.lastPage!==goal.lastPage||request.arguments.prefixChars!==goal.prefixChars||result.status!=='success'||!result.executed)continue
    const encoded=result.evidence?.find(e=>e.ref?.startsWith(PDF_PAGES_PREFIX))?.ref?.slice(PDF_PAGES_PREFIX.length)
    let receipt:PdfPagesReceipt|undefined
    try{receipt=readPdfPagesReceipt(JSON.parse(encoded??''))}catch{continue}
    if(!receipt||!fingerprint||receipt.inputFingerprint!==fingerprint||receipt.firstPage!==goal.firstPage||receipt.lastPage!==goal.lastPage
      ||receipt.reader!==(request.arguments.reader??'pdfplumber')||receipt.prefixChars!==(goal.prefixChars??null)
      ||!receipt.pages.every(p=>p.includedChars>0&&p.includedChars===Math.min(p.totalChars,goal.prefixChars??p.totalChars)))continue
    const item=result.turnContent?.find(c=>c.capability===DOCUMENT_PAGES&&c.sourceFingerprint===fingerprint&&visibleContentIds.includes(c.contentId))
    if(item)return{achieved:true,contentIds:[item.contentId]}
  }
  return{achieved:false,contentIds:[] as string[]}
}
