import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ActionFailureError, actionFailure } from '../../../kernel/action/errors.ts'
import type { CapabilityAdapter } from '../../../kernel/action/executor-port.ts'
import { DOCUMENT_PAGES, PDF_PAGES_VERSION, PDF_PAGES_PREFIX, PDF_PAGE_READERS, PDF_PAGE_LIMITS, validPdfPageRange, readPdfPagesReceipt, type PdfPageReader } from '../../../kernel/contracts/document-pages.ts'
import { createDocumentReadAdapter, runConverter, DEFAULT_DOC_PYTHON, type DocumentReadOptions } from './document-read.ts'

export async function runPdfPages(input: { bytes:Buffer;reader:PdfPageReader;firstPage:number;lastPage:number;prefixChars:number|null;pythonPath:string;timeoutMs:number }) {
  const {reader,firstPage,lastPage,prefixChars}=input
  return await runConverter({pythonPath:input.pythonPath,timeoutMs:input.timeoutMs,format:'pdf',
    runnerPath:fileURLToPath(new URL('../../../../scripts/utility-skills/pdf-pages-runner.py',import.meta.url)),
    bytes:Buffer.concat([Buffer.from(JSON.stringify({reader,firstPage,lastPage,prefixChars})+'\n'),input.bytes])})
}
export function createDocumentPagesAdapter(options:DocumentReadOptions & {readPages?:typeof runPdfPages}):CapabilityAdapter {
  return{capabilityId:DOCUMENT_PAGES,async execute(input){
    const {path,firstPage,lastPage,prefixChars,expectedInputFingerprint}=input.args,reader=(input.args.reader??'pdfplumber') as PdfPageReader
    if(input.operation!=='read'||typeof path!=='string'||!validPdfPageRange(firstPage,lastPage)||!PDF_PAGE_READERS.includes(reader)
      ||Object.keys(input.args).some(k=>!['path','firstPage','lastPage','prefixChars','reader','expectedInputFingerprint'].includes(k))
      ||(prefixChars!==undefined&&(!Number.isSafeInteger(prefixChars)||Number(prefixChars)<1||Number(prefixChars)>PDF_PAGE_LIMITS.chars))
      ||(expectedInputFingerprint!==undefined&&(typeof expectedInputFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(expectedInputFingerprint))))
      throw new ActionFailureError(actionFailure('validation_failed','PDF 页范围或前缀不在有界参数内'))
    let receipt:ReturnType<typeof readPdfPagesReceipt>,total=0,complete=false
    const delegate=createDocumentReadAdapter({...options,async convert(request){
      if(request.format!=='pdf')throw new ActionFailureError(actionFailure('unsupported','页读取只支持 PDF'))
      const fingerprint=createHash('sha256').update(request.bytes).digest('hex')
      if(expectedInputFingerprint!==undefined&&expectedInputFingerprint!==fingerprint)
        throw new ActionFailureError(actionFailure('validation_failed','PDF 已变化，旧页目标绑定不可沿用',{profileBinding:'source_changed'}))
      const raw=await(options.readPages??runPdfPages)({...request,reader,firstPage:Number(firstPage),lastPage:Number(lastPage),prefixChars:prefixChars===undefined?null:Number(prefixChars),pythonPath:options.pythonPath??DEFAULT_DOC_PYTHON})
      if(!raw.ok||raw.timedOut)return raw
      if(raw.exitCode!==undefined&&raw.exitCode!==0)throw new ActionFailureError(actionFailure('execution_failed','页读取进程没有正常退出'))
      let pages: {page:number;text:string;totalChars:number}[]
      try{pages=JSON.parse(raw.markdown??'')}catch{throw new ActionFailureError(actionFailure('execution_failed','非法页读取回执'))}
      if(!Array.isArray(pages)||pages.some(p=>!p||Object.keys(p).sort().join(',')!=='page,text,totalChars'||typeof p.text!=='string'))
        throw new ActionFailureError(actionFailure('execution_failed','非法页读取回执'))
      receipt=readPdfPagesReceipt({protocol:PDF_PAGES_VERSION,inputFingerprint:fingerprint,reader,firstPage,lastPage,prefixChars:prefixChars??null,
        pages:pages.map(p=>({page:p.page,totalChars:p.totalChars,includedChars:p.text.length}))})
      if(!receipt)throw new ActionFailureError(actionFailure('execution_failed','页回执范围无法核对'))
      if(pages.every(p=>!p.text.trim()))throw new ActionFailureError(actionFailure('target_not_found','所选页没有可提取正文；本轮不接 OCR'))
      const header=(page:number)=>`[PDF physical page ${page}]\n`
      const text=pages.map(p=>header(p.page)+p.text).join('\n\n')
      total=pages.reduce((n,p)=>n+header(p.page).length+p.totalChars,0)+(pages.length-1)*2
      complete=receipt.pages.every(p=>p.includedChars>0&&p.includedChars===Math.min(p.totalChars,Number(prefixChars??p.totalChars)))
      return{ok:true,timedOut:false,markdown:text}
    }})
    const outcome=await delegate.execute({...input,args:{path}})
    return{effect:{...outcome.effect!,detail:'有界 PDF 页正文'},evidence:[{kind:'adapter',detail:'页范围和字符计数；无正文',ref:PDF_PAGES_PREFIX+JSON.stringify(receipt)}],
      turnContent:outcome.turnContent?.map(item=>({...item,capability:DOCUMENT_PAGES,resourceRef:`${item.resourceRef}#pdf-pages=${firstPage}-${lastPage}`,
        scope:{totalChars:total,includedChars:item.text.length,truncated:item.text.length<total},
        facts:[`物理页：${firstPage}–${lastPage}；${reader} / ${PDF_PAGES_VERSION}`,`每页前缀：${prefixChars??'未指定'}；总正文上限 ${PDF_PAGE_LIMITS.chars} 字符`,
          `输入 SHA-256：${receipt!.inputFingerprint}`],structure:[`物理页 ${firstPage}–${lastPage}`]})),
      ...(!complete?{partial:{completed:receipt!.pages.filter(p=>p.includedChars>0&&p.includedChars===Math.min(p.totalChars,Number(prefixChars??p.totalChars))).length,total:receipt!.pages.length,detail:'未覆盖完整请求范围，不能据此宣布完成'}}:{}),
    }
  }}
}
