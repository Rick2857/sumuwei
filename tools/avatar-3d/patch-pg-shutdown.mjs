// Temporary integration overlay. The shared migration checkout is never edited.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = resolve(process.argv[2]);
const out = resolve(root, `../shutdown-overlay-${Date.now()}`); mkdirSync(out, { recursive: true });
const files = ['src/main.ts', 'src/infrastructure/persistence/runtime-shutdown.ts'];
const changes = [];
for (const file of files) {
  const path = resolve(root, file), original = readFileSync(path, 'utf8'), newline = original.includes('\r\n') ? '\r\n' : '\n';
  let text = original.replaceAll('\r\n', '\n');
  if (file === 'src/main.ts') {
    const start = text.indexOf('      /*\n       * WP3 / `D05`：释放');
    const end = text.indexOf('      if (productionOpen === undefined) return', start);
    if (start < 0 || end < 0) throw new Error('Unrecognized qualification cleanup anchor');
    text = text.slice(0, start) + text.slice(end);
    text = text.replace('        onInvalidated: (reason) => {', "        onInvalidated: (reason) => {\n          if (reason === 'client_released') return // Normal shutdown, not a lost session.");
    text = text.replace('  closeDatabaseConnection,', '  closeDatabaseConnection,\n  beforeDatabaseClose,');
    text = text.replace('      singleCoreQualification = qualification', `      singleCoreQualification = qualification
      beforeDatabaseClose(runtime, async () => {
        // ChatSession.close() also closes the adapter. All close paths must release this client.
        stopAfterQualificationLoss = undefined
        await qualification.release()
        logger.info('[qualification] 收尾：服务停止后、关连接池前已释放资格连接')
      })`);
  } else {
    const anchor = 'export async function closeDatabaseConnection(runtime: unknown): Promise<void> {';
    if (!text.includes(anchor)) throw new Error('Unrecognized runtime shutdown anchor');
    text = text.replace(anchor, `const closePreparations = new WeakMap<object, () => Promise<void>>()

/** Return dedicated clients before any caller asks the adapter to end its pool. */
export function beforeDatabaseClose(runtime: object, prepare: () => Promise<void>): void {
  closePreparations.set(runtime, prepare)
}

${anchor}`);
    text = text.replace('  let firstError: unknown\n  for (const close of closers)', `  let firstError: unknown
  let preparationError: unknown
  const prepare = closePreparations.get(runtime as object)
  closePreparations.delete(runtime as object)
  try { await prepare?.() } catch (error) { preparationError = error }
  for (const close of closers)`);
    text = text.replace(`      await close()
      return
    } catch (error) {
      firstError ??= error
    }
  }
  throw firstError`, `      await close()
    } catch (error) {
      firstError ??= error
      continue
    }
    if (preparationError !== undefined) throw preparationError
    return
  }
  throw firstError`);
  }
  text = text.replaceAll('\n', newline);
  const before = resolve(out, file.endsWith('main.ts') ? 'main.before.ts' : 'shutdown.before.ts');
  writeFileSync(before, original); writeFileSync(path, text);
  const diff = spawnSync('git', ['diff', '--no-index', '--', before, path], { encoding: 'utf8' });
  if (diff.status !== 1) throw new Error('Overlay must produce a concrete diff');
  writeFileSync(resolve(out, file.endsWith('main.ts') ? 'main.patch' : 'shutdown.patch'), diff.stdout);
  changes.push({ file, before: createHash('sha256').update(original).digest('hex'), after: createHash('sha256').update(text).digest('hex') });
}
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify({ reason: 'qualification client held until after pool.end: shutdown deadlock', changes }, null, 2));
console.log(JSON.stringify(changes));
