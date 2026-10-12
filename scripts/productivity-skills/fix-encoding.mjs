/**
 * 一次性修复：把被 PowerShell `Set-Content -Encoding utf8` 写坏的编码修回来。
 *
 * ⚠️ 这是 AGENTS.md §7 那条纪律的一次**真实踩坑**：PowerShell 5.1 的
 *    `Set-Content -Encoding utf8` 会**加上 BOM**（`EF BB BF`），而本仓库的
 *    源文件是 **UTF-8 无 BOM + LF**。BOM 会让字节级指纹漂移，也让
 *    "这个文件被谁改过"变得难以回答。
 *
 * 用法：`node scripts/productivity-skills/fix-encoding.mjs <file> [<file>...]`
 * 幂等：没有 BOM / 没有 CRLF 时一个字节都不写。
 */

import { readFileSync, writeFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (files.length === 0) {
  process.stderr.write('用法：node fix-encoding.mjs <file> [<file>...]\n')
  process.exit(2)
}

for (const file of files) {
  const raw = readFileSync(file)
  const hadBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
  const body = hadBom ? raw.subarray(3) : raw
  const text = body.toString('utf8')
  const normalized = text.replace(/\r\n/g, '\n')
  const changed = hadBom || normalized !== text
  if (changed) writeFileSync(file, normalized, 'utf8')
  process.stdout.write(
    `${file}  BOM=${hadBom ? '去掉' : '无'}  CRLF=${normalized !== text ? '改成 LF' : '无'}  ${
      changed ? '已写回' : '未改动'
    }\n`
  )
}
