// Le versioni devono coincidere in tutti i punti: version.json (letto dal sito), app.js, sw.js, firmware.
import { readFileSync } from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
const v = JSON.parse(readFileSync(root + 'app/version.json', 'utf8'));
const app = readFileSync(root + 'app/js/app.js', 'utf8');
const sw = readFileSync(root + 'app/sw.js', 'utf8');
const fw = readFileSync(root + 'mosaicus_firmware.ino', 'utf8');
const checks = [
  ['app.js APP_VERSION', app.match(/APP_VERSION = '([^']+)'/)?.[1], v.app],
  ['app.js FIRMWARE_VERSION', app.match(/FIRMWARE_VERSION = '([^']+)'/)?.[1], v.firmware],
  ['sw.js CACHE', sw.match(/CACHE = 'mosaicus-v([^']+)'/)?.[1], v.app],
  ['firmware FW_VERSION', fw.match(/FW_VERSION = "([^"]+)"/)?.[1], v.firmware],
  ['app/LICENSE.txt identico a LICENSE', readFileSync(root + 'app/LICENSE.txt', 'utf8') === readFileSync(root + 'LICENSE', 'utf8'), true],
];
let bad = 0;
for (const [what, got, want] of checks) { const ok = got === want; if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${got} (atteso ${want})`); }
process.exit(bad ? 1 : 0);
