import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const url = 'https://raw.githubusercontent.com/pixiv/three-vrm/ff42fae4fcee1fcbca2cd262c7f5f8cbddeaf5ab/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm';
const sha256 = '12c2b97e95e700783a6a550dc0eee2d7880aeedccef9ae67bc4c5a2f0f2631a2';
const destination = new URL('./public/models/sample.vrm', import.meta.url);
let bytes = await readFile(destination).catch(() => null);
if (!bytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Sample download failed: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
}
if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Sample SHA-256 mismatch; refusing asset');
await mkdir(new URL('./public/models/', import.meta.url), { recursive: true });
await writeFile(destination, bytes);
console.log('Verified pixiv sample; VRM Public License 1.0. This is not the Su Muwei character model.');
