#!/bin/bash
# 部署**打过补丁**的服务器版 main.ts（不是本机文件）。
# 关键纪律（上一轮事故的教训）：
#   ① 备份必须成功，否则**中止**（失败关闭）
#   ② 部署对象是"服务器当前文件 + 我的小补丁"，不是本机整体文件
#   ③ 替换前核验：所有相对 import 都能在服务器上解析
set -u
REPO=/opt/project-lg
STAMP=$(date +%Y%m%dT%H%M%S)
BK="/var/backups/thinhost-$STAMP"
STAGED=/tmp/thinhost-stage/main.patched.ts

echo "=== ① 备份（失败即中止）==="
mkdir -p "$BK/src/infrastructure/runtime" || { echo "ABORT: 备份目录建不出来"; exit 10; }
cp "$REPO/src/main.ts" "$BK/src/main.ts" || { echo "ABORT: main.ts 备份失败"; exit 11; }
cp "$REPO/src/db/index.ts" "$BK/src/index.ts" || { echo "ABORT: db/index.ts 备份失败"; exit 12; }
sha256sum "$REPO/src/main.ts" "$REPO/src/db/index.ts" > "$BK/sha256.txt" || { echo "ABORT: 指纹失败"; exit 13; }
cat "$BK/sha256.txt"
echo "backup OK: $BK"

echo
echo "=== ② 核验待部署文件没有缺失依赖 ==="
cat > /tmp/check-imp3.mjs <<'EOF'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
const file = process.argv[2]
const srcRoot = '/opt/project-lg/src'
const src = readFileSync(file, 'utf8')
const re = /from\s+'(\.[^']+)'/g
const missing = new Set()
let m
while ((m = re.exec(src)) !== null) {
  if (!existsSync(resolve(srcRoot, m[1]))) missing.add(m[1])
}
console.log(JSON.stringify({ missingCount: missing.size, missing: [...missing] }))
process.exit(missing.size === 0 ? 0 : 1)
EOF
/usr/bin/node /tmp/check-imp3.mjs "$STAGED" || { echo "ABORT: 待部署文件有缺失依赖"; exit 20; }
echo "import check OK"

echo
echo "=== ②b 语法校验（esbuild transform）—— 失败即中止 ==="
# ⚠️ 上一轮把"插入了新的 const runtime、却没删旧的"部署上去了，
#    esbuild 直接报 `The symbol "runtime" has already been declared`。
#    这一步就是把它挡在部署之前。
cat > /tmp/syntax-check.mjs <<'EOF'
import { readFileSync } from 'node:fs'
import { transform } from '/opt/project-lg/node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js'
const file = process.argv[2]
try {
  await transform(readFileSync(file, 'utf8'), { loader: 'ts', format: 'esm' })
  console.log('SYNTAX OK')
  process.exit(0)
} catch (e) {
  const msg = (e && e.errors && e.errors[0] && e.errors[0].text) || (e && e.message) || String(e)
  console.error('SYNTAX FAIL: ' + msg)
  process.exit(1)
}
EOF
/usr/bin/node /tmp/syntax-check.mjs "$STAGED" || { echo "ABORT: 待部署文件语法不通过"; exit 21; }

echo
echo "=== ②c 装配闭合静态检查：不得有 `if (thinHostEnabled()) { … return thin }` ==="
# ⚠️ 必须**排除注释行**：补丁里的说明文字正好写着这个形态
#    （`第一版写成 \`if (thinHostEnabled()) { … return thin }\``），
#    用朴素 grep 会把自己判成失败。
cat > /tmp/early-return-check.mjs <<'EOF'
import { readFileSync } from 'node:fs'
const src = readFileSync(process.argv[2], 'utf8')
// 只看非注释行：去掉行首的 * 或 // 之后才判定
const codeLines = src.split(/\r?\n/).filter((l) => {
  const t = l.trim()
  return t !== '' && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
})
const bad = codeLines.filter((l) => /if\s*\(\s*thinHostEnabled\(\)\s*\)\s*\{/.test(l))
if (bad.length > 0) {
  console.error('EARLY-RETURN FORM FOUND:\n' + bad.join('\n'))
  process.exit(1)
}
console.log('no early-return form in code lines: OK')
EOF
/usr/bin/node /tmp/early-return-check.mjs "$STAGED" || { echo "ABORT: 仍存在提前 return 形态"; exit 22; }

echo
echo "=== ③ 原子替换 ==="
cp "$STAGED" "$REPO/src/main.ts.new" || exit 30
chown --reference="$REPO/src/db/index.ts" "$REPO/src/main.ts.new" 2>/dev/null || chown aiagent:aiagent "$REPO/src/main.ts.new"
mv "$REPO/src/main.ts.new" "$REPO/src/main.ts"
sha256sum "$REPO/src/main.ts"
echo "lines=$(wc -l < "$REPO/src/main.ts")"
echo "patch present: $(grep -c 'thinHostEnabled' "$REPO/src/main.ts")"

echo
echo "=== ④ 重启并观察 ==="
systemctl restart lg-qq.service
sleep 25
systemctl is-active lg-qq.service
systemctl show lg-qq.service -p NRestarts 2>/dev/null
pgrep -af 'project-lg/src/main.ts' | head -1
echo "--- errors ---"
journalctl -u lg-qq.service --since "-30sec" --no-pager 2>/dev/null | grep -icE 'ERR_MODULE|FATAL' | sed 's/^/fatal error count: /'
