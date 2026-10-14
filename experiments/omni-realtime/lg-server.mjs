import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { startLG } from './lg-process.mjs';

loadEnvFile(fileURLToPath(new URL('.env.local', import.meta.url)));
const app = await startServer({ live: true, coreFactory: options => startLG(options) });
console.log(`OMNI_LG_READY url=http://127.0.0.1:${app.port} database=isolated-postgres voice=Liora-Mira`);
const stop = async () => {
  const result = await app.close();
  console.log(`OMNI_LG_CLOSED code=${result?.code} signal=${result?.signal}`);
};
process.once('SIGINT', stop); process.once('SIGTERM', stop);
