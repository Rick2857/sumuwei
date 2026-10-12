/**
 * M5.1.1 —— **K-23 Authoritative Recorder Boundary Analyzer**（**唯一**一套判据实现）
 *
 * 背景（K-33）：WP3 的 K-23 结构性证明②原本写成"`recordedBy` 只出现在契约里"
 * （即"`src/` 里除 `contracts/attribution.ts` 外任何出现都算违规"）。它在 WP3.1 当时成立，
 * 但后来的读回映射 / DTO / Query 面**合法地**需要读这个槽位 ⇒ 那个判据不再等价于
 * "没有第二个 writer"，而且它把只读引用当成了写能力。
 *
 * 这个文件把 K-23 的命题重新写成**能力判据**（用户 WP8-C2 裁定）：
 *
 *   旧：`no source file outside attribution.ts may mention recordedBy`
 *   新：`no caller-controlled production path may provide values to
 *        conversation_events.recorded_by_* authoritative columns`
 *
 * 它**不**用"文件名豁免"实现这件事：分类依据是 AST 上的**能力** ——
 * 这个文件能不能在一个**权威 mutation 边界**上影响绑定到那三个物理列的值。
 *
 * 被两个门共同消费（避免第二次 drift）：
 *   · `scripts/verify-m5.1.1-wp3-backfill.ts`（wp3 门：证明① + 证明②）
 *   · `scripts/verify-m5.1.1-wp8c2-k33.ts`（C2 专项门：三类 control + 全量边界报告）
 *
 * 语义**没有被改动**（K-23 / R-20 原文）：
 *   CANONICAL_LEDGER_RECORDER = Known(SYSTEM, "kernel")
 *   recordedBy = "谁物理写下权威 ledger row"（不是 actor / initiator / contentOriginator /
 *                executor / authority）
 *   TRUSTED_LEDGER_WRITERS = 只有已经明确登记的 authoritative writer
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as ts from 'typescript'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface MutationSite {
  file: string
  line: number
  verb: 'insert' | 'update' | 'delete' | 'replace'
  /** 规范化后的 SQL 片段前 120 字符（只作证据） */
  sqlHead: string
  /** 该语句**经本地常量展开后**是否触达 recorded_by_* 三列（能力判据，不靠文件名） */
  bindsRecordedByColumns: boolean
  /** 展开时触达的标识符（证据） */
  reachedIdentifiers: string[]
  /** 该语句的模板 span 里，是否有表达式引用了函数参数且该语句字面量含 recorded_by_* */
  recordedByComesFromParameter: boolean
}

/** 剥掉 `as const` / 类型断言 / 括号 —— 否则 `{ … } as const` 读不到对象字面量 */
function unwrapExpression(e: ts.Expression): ts.Expression {
  let cur = e
  for (;;) {
    if (ts.isAsExpression(cur) || ts.isTypeAssertionExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isSatisfiesExpression(cur)) {
      cur = cur.expression
      continue
    }
    return cur
  }
}

/** 本地常量 → 初始化表达式（用于把 `${attributionValues}` 这类引用展开到真正的字面量） */
function localConstInitializers(sf: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>()
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) out.set(n.name.text, n.initializer)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** 收集子树里所有**模板/字符串字面量**的文本（含 TemplateHead/Middle/Tail —— 只收 string literal 会漏） */
function literalTexts(node: ts.Node): string[] {
  const out: string[] = []
  const walk = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text)
    ts.forEachChild(n, walk)
  }
  walk(node)
  return out
}

/**
 * 从某个节点出发，展开**本文件内的局部常量引用**（深度受限），返回触达的标识符与文本。
 * 这是"这个 mutation 语句到底写不写那三列"的能力判据 —— 不依赖任何文件名或期望常量。
 */
function expandLocally(sf: ts.SourceFile, consts: Map<string, ts.Expression>, start: ts.Node): { identifiers: Set<string>; texts: string[] } {
  const identifiers = new Set<string>()
  const texts: string[] = []
  const seen = new Set<string>()
  const walk = (n: ts.Node, depth: number): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) texts.push(n.text)
    if (ts.isIdentifier(n)) {
      identifiers.add(n.text)
      if (depth > 0) {
        const init = consts.get(n.text)
        if (init !== undefined && !seen.has(n.text)) {
          seen.add(n.text)
          walk(init, depth - 1)
        }
      }
    }
    ts.forEachChild(n, (c) => walk(c, depth))
  }
  walk(start, 4)
  void sf
  return { identifiers, texts }
}

export interface ValueProvider {
  file: string
  line: number
  symbol: string
  /** ENVELOPE_FROM_TRUSTED_CONTEXT / CANONICAL_VALUE_CONSTRUCTION / READ_DECODE / UNKNOWN */
  capability: string
  detail: string
}

export interface ReferenceClassification {
  file: string
  occurrences: number
  /** AUTHORITATIVE_WRITER / VALUE_PROVIDER / TRUSTED_CONSTRUCTION_CALLER / READ_ONLY_REFERENCE */
  classification: string
  /** READ_ONLY_REFERENCE 的机械理由（能力规则，不是文件名） */
  reason: string
  /** 真正的能力信号（用于审计） */
  signals: string[]
}

export interface RecorderBoundaryReport {
  srcRoot: string
  filesScanned: number
  /** 唯一权威 mutation 面（自动发现，不靠 EXPECTED_FILE 常量） */
  mutationSites: MutationSite[]
  authoritativeWriterFiles: string[]
  /** 物理三列 + 它们在契约里的权威映射 */
  recordedByColumns: { kind: string; id: string; unknownReason: string }
  recordedByColumnsCovered: boolean
  /** 值提供者：从 mutation 面回溯到受信构造 */
  valueProviders: ValueProvider[]
  /** `ConversationEvent.attribution` 的封装生产者（必须恰好一处：createConversationEvent） */
  envelopeProducers: { file: string; line: number; symbol: string }[]
  /** 从受信上下文派生槽位的位置 */
  slotsFromTrustedContext: { file: string; line: number }[]
  /** 受信上下文构造点（生产 ingress） */
  trustedContextCallSites: { file: string; line: number }[]
  /** 规范化 recorder 常量与已登记 writer */
  canonicalRecorder: { kind: string; id: string; declaredAt: string }
  trustedLedgerWriters: { writerId: string; kind: string; id: string }[]
  /** 每一条"构造出一个 recordedBy 值"的位置（必须只用 canonical 常量） */
  recordedByValueConstructions: { file: string; line: number; usesCanonicalConstant: boolean; snippet: string }[]
  /** 写链入口的参数类型（自动发现）——用于"公共输入面里有没有 recordedBy"的正/负控 */
  writeChainEntryParamTypes: { file: string; fn: string; param: string; typeName: string; recordedByMembers: string[]; viaTrustedCarrier: boolean }[]
  /** 写链上的输入面里有 recordedBy 成员的类型（内部封装/受信上下文是合法的） */
  writeChainInputTypesWithRecordedBy: { file: string; typeName: string; isInternalEnvelope: boolean; member: string }[]
  /** `TrustedAttributionContext` 的**产出点**（自动发现；必须恰好一处 = 受信构造器） */
  trustedContextProducers: { file: string; line: number; snippet: string }[]
  /** 核心判据：调用方可控的值提供者（必须为空） */
  callerControlledProviders: { file: string; line: number; detail: string }[]
  /** 引用分类（能力驱动；没有文件名豁免表） */
  references: ReferenceClassification[]
  readerFilesWithRecordedBy: string[]
  unexplainedReferences: { file: string; occurrence: string }[]
  /** 计数（用于"不得空测量"） */
  counts: {
    mutationSites: number
    authoritativeWriterFiles: number
    valueProviders: number
    envelopeProducers: number
    recordedByValueConstructions: number
    readerFilesWithRecordedBy: number
    callerControlledProviders: number
    unexplainedReferences: number
  }
}

// ---------------------------------------------------------------------------
// AST 小工具
// ---------------------------------------------------------------------------

function collectSourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p)
    }
  }
  walk(root)
  return out.sort()
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

/** tagged template 的静态文本（含各 span 的 literal，中间的表达式记作 ${…}） */
function templateText(node: ts.TaggedTemplateExpression): string {
  const t = node.template
  if (ts.isNoSubstitutionTemplateLiteral(t)) return t.text
  let out = t.head.text
  for (const span of t.templateSpans) out += ' ${…} ' + span.literal.text
  return out
}

function normalizeSql(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function calleeName(node: ts.CallExpression): string | null {
  const e = node.expression
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return null
}

function objectLiteralProperties(node: ts.Expression | undefined): { name: string; value: ts.Expression; node: ts.PropertyAssignment }[] {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return []
  const out: { name: string; value: ts.Expression; node: ts.PropertyAssignment }[] = []
  for (const p of node.properties) {
    if (ts.isPropertyAssignment(p)) {
      const n = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null
      if (n !== null) out.push({ name: n, value: p.initializer, node: p })
    }
  }
  return out
}

/** 取某个赋值节点的源码文本（截断，作证据用） */
function snippet(sf: ts.SourceFile, node: ts.Node, max = 160): string {
  const t = node.getText(sf).replace(/\s+/g, ' ')
  return t.length > max ? t.slice(0, max) + '…' : t
}

/** 节点子树里是否出现某个标识符（名字匹配） */
function subtreeHasIdentifier(node: ts.Node, predicate: (name: string) => boolean): boolean {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isIdentifier(n) && predicate(n.text)) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

/** 节点子树里是否调用某个函数名 */
function subtreeCalls(node: ts.Node, names: readonly string[]): boolean {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(n)) {
      const c = calleeName(n)
      if (c !== null && names.includes(c)) {
        found = true
        return
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

/** 收集函数参数名（用于"值来自调用方"判定） */
function parameterNames(node: ts.FunctionLikeDeclaration): Set<string> {
  const out = new Set<string>()
  for (const p of node.parameters) {
    if (ts.isIdentifier(p.name)) out.add(p.name.text)
    else if (ts.isObjectBindingPattern(p.name)) {
      for (const el of p.name.elements) if (ts.isIdentifier(el.name)) out.add(el.name.text)
    }
  }
  return out
}

interface FileAst {
  path: string
  rel: string
  text: string
  sf: ts.SourceFile
}

function parseAll(root: string): FileAst[] {
  return collectSourceFiles(root).map((p) => {
    const text = readFileSync(p, 'utf8')
    return { path: p, rel: relative(process.cwd(), p).split('\\').join('/'), text, sf: ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) }
  })
}

// ---------------------------------------------------------------------------
// 主分析
// ---------------------------------------------------------------------------

const ENVELOPE_BUILDERS = ['attributionSlotsOfContext', 'conversationAttributionEnvelopeOf']
const VALUE_CONSTRUCTORS = ['attributionKnown', 'attributionUnknown', 'attributionAbsent', 'attributionKnownPrincipal']
const TRUSTED_CONTEXT_BUILDER = 'buildTrustedAttributionContext'
const WRITE_CHAIN_ENTRY = 'appendConversationEvent'
const MUTATION_RE = /\b(insert into|update|delete from|replace into)\s+conversation_events\b/

export function analyzeRecorderBoundary(options: { srcRoot: string }): RecorderBoundaryReport {
  const files = parseAll(options.srcRoot)

  // ---- 预扫：类型声明 → 成员（含成员的类型文本，用于沿类型引用下钻） ----
  const typeMembers = new Map<string, { file: string; members: { name: string; line: number; typeText: string }[] }>()
  for (const f of files) {
    const collect = (n: ts.Node): void => {
      const propOf = (m: ts.TypeElement): { name: string; line: number; typeText: string } | null => {
        if (!ts.isPropertySignature(m) || m.name === undefined) return null
        const nm = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? (m.name as ts.Identifier | ts.StringLiteral).text : ''
        return { name: nm, line: lineOf(f.sf, m), typeText: m.type === undefined ? '' : m.type.getText(f.sf) }
      }
      if (ts.isInterfaceDeclaration(n)) {
        typeMembers.set(n.name.text, { file: f.rel, members: n.members.map(propOf).filter((x): x is { name: string; line: number; typeText: string } => x !== null) })
      }
      if (ts.isTypeAliasDeclaration(n) && ts.isTypeLiteralNode(n.type)) {
        typeMembers.set(n.name.text, { file: f.rel, members: n.type.members.map(propOf).filter((x): x is { name: string; line: number; typeText: string } => x !== null) })
      }
      ts.forEachChild(n, collect)
    }
    collect(f.sf)
  }
  /**
   * 沿"成员的类型文本里出现的具名类型引用"下钻，找出这个类型**能否**携带 recordedBy。
   * 能力判据：能不能把 recordedBy 带到权威写入面的参数上（而不是文件名叫什么）。
   */
  const recordedByMembersDeep = (typeName: string, depth = 4, seen = new Set<string>()): string[] => {
    if (depth <= 0 || seen.has(typeName)) return []
    seen.add(typeName)
    const t = typeMembers.get(typeName)
    if (t === undefined) return []
    const out: string[] = []
    for (const m of t.members) {
      if (/recorded_?by/i.test(m.name)) out.push(`${typeName}.${m.name}`)
      const refs = [...m.typeText.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)].map((x) => x[1] as string)
      for (const ref of refs) {
        if (ref === typeName) continue
        for (const sub of recordedByMembersDeep(ref, depth - 1, seen)) out.push(`${typeName}.${m.name} -> ${sub}`)
      }
    }
    return [...new Set(out)]
  }
  const writeChainEntryParamTypes: { file: string; fn: string; param: string; typeName: string; recordedByMembers: string[]; viaTrustedCarrier: boolean }[] = []
  const trustedContextProducers: { file: string; line: number; snippet: string }[] = []
  /** 写链入口：命名在表里的函数，或函数体里调用了权威写入点 */
  const ENTRY_NAMES = new Set(['appendConversationEvent', 'createConversationEvent', 'appendWith', 'appendUserStatement', 'writeConversationEvent'])

  const mutationSites: MutationSite[] = []
  const envelopeProducers: { file: string; line: number; symbol: string }[] = []
  const slotsFromTrustedContext: { file: string; line: number }[] = []
  const trustedContextCallSites: { file: string; line: number }[] = []
  const recordedByValueConstructions: { file: string; line: number; usesCanonicalConstant: boolean; snippet: string }[] = []
  const writeChainInputTypesWithRecordedBy: { file: string; typeName: string; isInternalEnvelope: boolean; member: string }[] = []
  const callerControlledProviders: { file: string; line: number; detail: string }[] = []
  const references: ReferenceClassification[] = []
  const unexplainedReferences: { file: string; occurrence: string }[] = []

  let canonicalRecorder = { kind: '', id: '', declaredAt: '' }
  let trustedLedgerWriters: { writerId: string; kind: string; id: string }[] = []
  let recordedByColumns = { kind: '', id: '', unknownReason: '' }

  for (const f of files) {
    const occurrences: number[] = []
    const signals = new Set<string>()
    const consts = localConstInitializers(f.sf)

    const visit = (node: ts.Node, enclosingFn: ts.FunctionLikeDeclaration | null): void => {
      const fn = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ? node : enclosingFn

      // --- 规范化 recorder 常量 + 已登记 writer 注册表（契约里声明一次） ---
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        if (node.name.text === 'CANONICAL_LEDGER_RECORDER' && node.initializer !== undefined) {
          const init = unwrapExpression(node.initializer)
          if (ts.isObjectLiteralExpression(init)) {
            const props = objectLiteralProperties(init)
            const kind = props.find((p) => p.name === 'kind')?.value
            const id = props.find((p) => p.name === 'id')?.value
            canonicalRecorder = {
              kind: kind !== undefined && ts.isStringLiteral(kind) ? kind.text : '',
              id: id !== undefined && ts.isStringLiteral(id) ? id.text : '',
              declaredAt: `${f.rel}:${lineOf(f.sf, node)}`,
            }
          }
        }
        if (node.name.text === 'TRUSTED_LEDGER_WRITERS' && node.initializer !== undefined) {
          const init = unwrapExpression(node.initializer)
          if (ts.isArrayLiteralExpression(init)) {
            for (const el of init.elements) {
              if (!ts.isObjectLiteralExpression(el)) continue
              const props = objectLiteralProperties(el)
              const writerId = props.find((p) => p.name === 'writerId')?.value
              const principalRaw = props.find((p) => p.name === 'principal')?.value
              // principal 可能是**标识符引用**（`principal: CANONICAL_LEDGER_RECORDER`）⇒ 顺着本地常量解析
              let principalExpr: ts.Expression | undefined = principalRaw
              if (principalExpr !== undefined && ts.isIdentifier(principalExpr)) {
                const target = consts.get(principalExpr.text)
                principalExpr = target === undefined ? undefined : unwrapExpression(target)
              } else if (principalExpr !== undefined) {
                principalExpr = unwrapExpression(principalExpr)
              }
              const pr = principalExpr !== undefined && ts.isObjectLiteralExpression(principalExpr) ? objectLiteralProperties(principalExpr) : []
              const pk = pr.find((p) => p.name === 'kind')?.value
              const pi = pr.find((p) => p.name === 'id')?.value
              trustedLedgerWriters.push({
                writerId: writerId !== undefined && ts.isStringLiteral(writerId) ? writerId.text : '',
                kind: pk !== undefined && ts.isStringLiteral(pk) ? pk.text : '',
                id: pi !== undefined && ts.isStringLiteral(pi) ? pi.text : '',
              })
            }
          }
        }
        // --- 契约里的 recordedBy 物理列映射 ---
        if (node.name.text === 'ATTRIBUTION_SLOT_COLUMNS' && node.initializer !== undefined && ts.isObjectLiteralExpression(node.initializer)) {
          for (const p of objectLiteralProperties(node.initializer)) {
            if (p.name !== 'recordedBy' || !ts.isObjectLiteralExpression(p.value)) continue
            const cols = objectLiteralProperties(p.value)
            const get = (n: string): string => {
              const v = cols.find((c) => c.name === n)?.value
              return v !== undefined && ts.isStringLiteral(v) ? v.text : ''
            }
            recordedByColumns = { kind: get('kind'), id: get('id'), unknownReason: get('unknownReason') }
          }
        }
      }

      // --- mutation site：`sql\`insert into conversation_events …\`` 等（AST + 本地常量展开） ---
      if (ts.isTaggedTemplateExpression(node)) {
        const sqlText = normalizeSql(templateText(node))
        const m = MUTATION_RE.exec(sqlText)
        if (m !== null) {
          const expanded = expandLocally(f.sf, consts, node)
          const reachedText = expanded.texts.join(' ').toLowerCase()
          const mentionsSlotColumnMap = ['ATTRIBUTION_SLOT_COLUMNS', 'attributionSlotEntries', 'ATTRIBUTION_SLOT_ENTRIES'].some((n) => expanded.identifiers.has(n))
          const mentionsRecordedByLiteral = /recorded_by_(kind|id|unknown_reason)/.test(sqlText) || /recorded_by_/.test(reachedText)
          // 值来自调用方：该语句字面量含 recorded_by_*，且模板 span 的表达式引用了函数参数
          const params = fn === null ? new Set<string>() : parameterNames(fn)
          const spanExpressions: string[] = []
          if (ts.isTemplateExpression(node.template)) for (const span of node.template.templateSpans) spanExpressions.push(snippet(f.sf, span.expression, 300))
          const recordedByComesFromParameter =
            mentionsRecordedByLiteral && spanExpressions.some((e) => [...params].some((p) => new RegExp(`\\b${p}\\b`).test(e)))
          mutationSites.push({
            file: f.rel,
            line: lineOf(f.sf, node),
            verb: m[1].startsWith('insert') ? 'insert' : m[1].startsWith('update') ? 'update' : m[1].startsWith('delete') ? 'delete' : 'replace',
            sqlHead: sqlText.slice(0, 120),
            bindsRecordedByColumns: mentionsSlotColumnMap || mentionsRecordedByLiteral,
            reachedIdentifiers: [...expanded.identifiers].filter((n) => /attribution|recorded|slot/i.test(n)).sort(),
            recordedByComesFromParameter,
          })
        }
      }

      // --- envelope producer：从受信上下文构造 attribution.slots ---
      if (ts.isPropertyAssignment(node)) {
        const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null
        if (name === 'attribution' && subtreeCalls(node.initializer, ENVELOPE_BUILDERS)) {
          envelopeProducers.push({ file: f.rel, line: lineOf(f.sf, node), symbol: snippet(f.sf, node.initializer, 80) })
        }
        if (name === 'attribution' && subtreeHasIdentifier(node.initializer, (n) => n === WRITE_CHAIN_ENTRY)) {
          // 罕见形态；登记为证据即可
          signals.add('attribution-from-write-chain-call')
        }
      }

      // --- 从受信上下文派生槽位 ---
      if (ts.isCallExpression(node)) {
        const c = calleeName(node)
        if (c !== null && ENVELOPE_BUILDERS.includes(c)) {
          slotsFromTrustedContext.push({ file: f.rel, line: lineOf(f.sf, node) })
        }
        if (c === TRUSTED_CONTEXT_BUILDER) {
          trustedContextCallSites.push({ file: f.rel, line: lineOf(f.sf, node) })
        }
      }

      // --- recordedBy 的出现（引用）与"值构造" ---
      if (ts.isPropertyAssignment(node)) {
        const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null
        if (name === 'recordedBy') {
          occurrences.push(lineOf(f.sf, node))
          const constructsValue = subtreeCalls(node.initializer, VALUE_CONSTRUCTORS) || subtreeHasIdentifier(node.initializer, (n) => n === 'CANONICAL_LEDGER_RECORDER')
          if (constructsValue) {
            const usesCanonical = subtreeHasIdentifier(node.initializer, (n) => n === 'CANONICAL_LEDGER_RECORDER')
            recordedByValueConstructions.push({ file: f.rel, line: lineOf(f.sf, node), usesCanonicalConstant: usesCanonical, snippet: snippet(f.sf, node, 120) })
            signals.add('value-construction')
          } else {
            signals.add('pass-through-read')
          }
        }
      }
      if (ts.isPropertySignature(node) && node.name !== undefined) {
        const nm = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null
        if (nm === 'recordedBy') {
          occurrences.push(lineOf(f.sf, node))
          signals.add('type-member')
        }
      }
      if (ts.isStringLiteral(node) && node.text === 'recordedBy') {
        occurrences.push(lineOf(f.sf, node))
        signals.add('string-literal')
      }

      ts.forEachChild(node, (child) => visit(child, fn))
    }
    visit(f.sf, null)

    // --- 写链入口的参数类型：能力判据（公共输入面能不能提供 recordedBy） ---
    const visitEntries = (node: ts.Node): void => {
      const isFn = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      if (isFn && node.name !== undefined && ts.isIdentifier(node.name)) {
        const fnName = node.name.text
        const bodyText = node.body === undefined ? '' : node.body.getText(f.sf)
        const isWriteChain = ENTRY_NAMES.has(fnName) || bodyText.includes(`${WRITE_CHAIN_ENTRY}(`)
        if (isWriteChain) {
          for (const p of node.parameters) {
            const paramName = ts.isIdentifier(p.name) ? p.name.text : '(destructured)'
            let typeName = '(untyped)'
            const members: string[] = []
            if (p.type !== undefined) {
              if (ts.isTypeReferenceNode(p.type) && ts.isIdentifier(p.type.typeName)) {
                typeName = p.type.typeName.text
                members.push(...recordedByMembersDeep(typeName))
              } else if (ts.isTypeLiteralNode(p.type)) {
                typeName = '(inline)'
                for (const m of p.type.members) if (ts.isPropertySignature(m) && m.name !== undefined) members.push(ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? (m.name as ts.Identifier | ts.StringLiteral).text : '')
              }
            }
            const rbm = members.filter((m) => /recorded_?by/i.test(m))
            const viaTrustedCarrier = rbm.length > 0 && rbm.every((m) => /trustedAttribution/.test(m))
            writeChainEntryParamTypes.push({ file: f.rel, fn: fnName, param: paramName, typeName, recordedByMembers: rbm, viaTrustedCarrier })
            for (const m of rbm) {
              const isInternalEnvelope = /ConversationEvent|Envelope|TrustedAttributionContext|AttributionValue|AttributionSlots/.test(typeName) || /trustedAttribution/.test(m)
              writeChainInputTypesWithRecordedBy.push({ file: f.rel, typeName: `${fnName}(${paramName}: ${typeName})`, isInternalEnvelope, member: m })
            }
          }
        }
      }
      // `TrustedAttributionContext` 的产出点（带显式类型标注的初始化 / 断言）
      if (ts.isVariableDeclaration(node) && node.type !== undefined && node.type.getText(f.sf).includes('TrustedAttributionContext')) {
        trustedContextProducers.push({ file: f.rel, line: lineOf(f.sf, node), snippet: snippet(f.sf, node, 90) })
      }
      if (ts.isAsExpression(node) && node.type.getText(f.sf).includes('TrustedAttributionContext')) {
        trustedContextProducers.push({ file: f.rel, line: lineOf(f.sf, node), snippet: snippet(f.sf, node, 90) })
      }
      ts.forEachChild(node, visitEntries)
    }
    visitEntries(f.sf)

    // --- 调用方可控：mutation site 的 recordedBy 值来自函数参数 ---
    for (const site of mutationSites.filter((s) => s.file === f.rel)) {
      if (site.recordedByComesFromParameter) {
        callerControlledProviders.push({ file: site.file, line: site.line, detail: 'mutation 语句里 recordedBy 的值表达式引用了函数参数' })
      }
    }

    // --- 分类（能力驱动；没有文件名豁免表） ---
    if (occurrences.length > 0) {
      const isWriter = mutationSites.some((s) => s.file === f.rel)
      const isValueProvider = recordedByValueConstructions.some((v) => v.file === f.rel) || envelopeProducers.some((e) => e.file === f.rel)
      const isTrustedCaller = trustedContextCallSites.some((c) => c.file === f.rel)
      let classification = 'READ_ONLY_REFERENCE'
      let reason = ''
      const sig = [...signals].sort()
      if (isWriter) {
        classification = 'AUTHORITATIVE_WRITER'
        reason = 'contains the authoritative conversation_events mutation site'
      } else if (isValueProvider) {
        classification = 'VALUE_PROVIDER'
        reason = 'constructs a recordedBy value and/or builds the attribution envelope from a trusted context'
      } else if (isTrustedCaller) {
        classification = 'TRUSTED_CONSTRUCTION_CALLER'
        reason = 'calls the trusted attribution builder (feeds evidence, sets no recordedBy value itself)'
      } else {
        const onlyType = sig.every((s) => s === 'type-member' || s === 'string-literal')
        if (onlyType) reason = 'type/literal-only reference (cannot influence a bound value)'
        else if (sig.includes('pass-through-read')) reason = 'pass-through read of an already-stored value (no value construction, no mutation site, not on the trusted construction chain)'
        else if (sig.includes('recorded_by_column_mapping')) reason = 'column mapping only'
        else {
          reason = 'UNEXPLAINED'
          for (const l of occurrences) unexplainedReferences.push({ file: f.rel, occurrence: `line ${l} (signals: ${sig.join(',') || 'none'})` })
        }
      }
      references.push({ file: f.rel, occurrences: occurrences.length, classification, reason, signals: sig })
    }
  }

  const authoritativeWriterFiles = [...new Set(mutationSites.filter((s) => s.verb === 'insert').map((s) => s.file))].sort()
  const recordedByColumnsCovered =
    recordedByColumns.kind === 'recorded_by_kind' &&
    recordedByColumns.id === 'recorded_by_id' &&
    recordedByColumns.unknownReason === 'recorded_by_unknown_reason' &&
    mutationSites.some((s) => s.bindsRecordedByColumns)

  const valueProviders: ValueProvider[] = [
    ...envelopeProducers.map((e) => ({ file: e.file, line: e.line, symbol: e.symbol, capability: 'ENVELOPE_FROM_TRUSTED_CONTEXT', detail: '从受信上下文派生 attribution.slots（记下的是谁写的，不是谁做的）' })),
    ...recordedByValueConstructions.map((v) => ({ file: v.file, line: v.line, symbol: v.snippet, capability: 'CANONICAL_VALUE_CONSTRUCTION', detail: v.usesCanonicalConstant ? '使用 CANONICAL_LEDGER_RECORDER 常量' : '**没有**使用 canonical 常量' })),
    ...references.filter((r) => r.classification === 'READ_ONLY_REFERENCE').map((r) => ({ file: r.file, line: 0, symbol: r.reason, capability: 'READ_DECODE', detail: r.reason })),
  ]

  const report: RecorderBoundaryReport = {
    srcRoot: options.srcRoot,
    filesScanned: files.length,
    mutationSites,
    authoritativeWriterFiles,
    recordedByColumns,
    recordedByColumnsCovered,
    valueProviders,
    envelopeProducers,
    slotsFromTrustedContext,
    trustedContextCallSites,
    canonicalRecorder,
    trustedLedgerWriters,
    recordedByValueConstructions,
    writeChainEntryParamTypes,
    writeChainInputTypesWithRecordedBy,
    trustedContextProducers,
    callerControlledProviders,
    references,
    readerFilesWithRecordedBy: references.filter((r) => r.classification === 'READ_ONLY_REFERENCE').map((r) => r.file).sort(),
    unexplainedReferences,
    counts: {
      mutationSites: mutationSites.length,
      authoritativeWriterFiles: authoritativeWriterFiles.length,
      valueProviders: valueProviders.length,
      envelopeProducers: envelopeProducers.length,
      recordedByValueConstructions: recordedByValueConstructions.length,
      readerFilesWithRecordedBy: references.filter((r) => r.classification === 'READ_ONLY_REFERENCE').length,
      callerControlledProviders: callerControlledProviders.length,
      unexplainedReferences: unexplainedReferences.length,
    },
  }
  return report
}
