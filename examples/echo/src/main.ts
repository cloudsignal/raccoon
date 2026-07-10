import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDemo } from './echo.js';

const appDist = fileURLToPath(new URL('../../../packages/app/dist', import.meta.url));

if (!existsSync(appDist)) {
  console.error('App build not found. Run: npm run build:app');
  process.exit(1);
}

const demo = await startDemo({ staticDir: appDist, push: process.env.WEB_PUSH === '1' });
const { qr, payload } = await demo.pair('demo');

console.log(`\nRaccoon echo demo`);
console.log(`  app:  http://127.0.0.1:${demo.port}/`);
console.log(`  user: demo\n`);
console.log(qr);
console.log(`\nScan the QR from the app's setup screen (or paste the payload):\n${payload}\n`);
console.log('Send "/draft" in the chat to try the approval card. Ctrl+C to stop.');

process.on('SIGINT', () => { void demo.stop().then(() => process.exit(0)); });
