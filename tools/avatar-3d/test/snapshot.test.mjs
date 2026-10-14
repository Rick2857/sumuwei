import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshotRuntime } from '../snapshot-runtime.mjs';

test('freeze is code-only and refuses overlaps or evidence overwrite', () => {
  const root = mkdtempSync(join(tmpdir(), 'lg-avatar3d-snapshot-')), source = join(root, 'source'), target = join(root, 'frozen');
  mkdirSync(source);
  try {
    for (const dir of ['src', 'scripts', 'evals', 'resources', 'docs', 'data']) mkdirSync(join(source, dir));
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', '.gitignore']) writeFileSync(join(source, file), '{}');
    writeFileSync(join(source, 'src/main.ts'), 'fixture code'); writeFileSync(join(source, '.env'), 'PRIVATE_FIXTURE=excluded');
    writeFileSync(join(source, 'data/fixture'), 'database fixture');
    assert.throws(() => snapshotRuntime(source, join(source, 'src/copy')), /overlap/);
    assert.throws(() => snapshotRuntime(source, root), /overlap/);
    const result = snapshotRuntime(source, target);
    assert.equal(result.fileCount, 6); assert.equal(result.hashes['src/main.ts'].length, 64);
    assert.ok(existsSync(join(target, 'src/main.ts'))); assert.ok(existsSync(join(target, 'avatar3d-core.mjs')));
    assert.equal(existsSync(join(target, '.env')), false); assert.equal(existsSync(join(target, 'data')), false);
    assert.throws(() => snapshotRuntime(source, target), /overwrite/);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true });
  }
});
