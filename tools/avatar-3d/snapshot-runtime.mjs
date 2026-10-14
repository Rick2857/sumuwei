// Freeze code only. No .env, database, model, Git history, or production artifacts enter the snapshot.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, sep } from 'node:path';

export function snapshotRuntime(source, destination) {
  source = resolve(source); destination = resolve(destination);
  if (destination === source || source.startsWith(destination + sep) || destination.startsWith(source + sep)) throw new Error('Snapshot and runtime source must not overlap');
  if (existsSync(destination)) throw new Error('Use a new snapshot directory; never overwrite prior evidence');
  mkdirSync(destination, { recursive: true });
  const hashes = {};
  const copy = path => {
    const from = join(source, path), to = join(destination, path);
    const bytes = readFileSync(from);
    mkdirSync(resolve(to, '..'), { recursive: true }); writeFileSync(to, bytes);
    hashes[path.replaceAll('\\', '/')] = createHash('sha256').update(bytes).digest('hex');
  };
  const walk = folder => {
    for (const entry of readdirSync(join(source, folder), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Runtime source symlinks are not copied');
      const file = join(folder, entry.name);
      if (entry.isDirectory()) walk(file); else copy(file);
    }
  };
  for (const dir of ['src', 'scripts', 'evals', 'resources', 'docs']) walk(dir);
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', '.gitignore']) copy(file);
  const drift = Object.entries(hashes).filter(([file, hash]) => createHash('sha256').update(readFileSync(join(source, file))).digest('hex') !== hash);
  if (drift.length) throw new Error(`Runtime changed while copying (${drift.length} paths); refusing mixed source snapshot`);
  writeFileSync(join(destination, 'avatar3d-core.mjs'), `
const {isolateDatabase}=await import('./src/dev/sandbox.ts');
isolateDatabase('avatar3d-pg', {postgres:{url:process.env.POSTGRES_URL}});
const {allowKernelMigration}=await import('./src/db/index.ts');
allowKernelMigration();
process.argv=[process.argv[0],process.argv[1],'--coexist'];
await import('./src/main.ts');
`);
  return { source, destination, fileCount: Object.keys(hashes).length,
    sha256: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), hashes };
}
