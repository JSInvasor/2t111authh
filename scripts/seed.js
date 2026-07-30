'use strict';

// Seeds a sample script + a few keys so you can test the system end to end.
// Run once with:  npm run seed

const config = require('../src/config');
require('../src/db');
const scripts = require('../src/services/scripts');
const keys = require('../src/services/keys');

const sampleSource = [
  'print("[2t1auth] Protected script loaded successfully!")',
  'print("Your key is valid and this device is authorized.")',
  'print("Replace this sample with your real script source via the API.")',
].join('\n');

const script = scripts.createScript({
  name: 'Sample Script',
  source: sampleSource,
  version: '1.0.0',
  hwid_lock: 1,
});

const created = keys.createKeys(script.id, { count: 3, note: 'seed' });

console.log('\n=== 2t1auth seed complete ===\n');
console.log('Script id :', script.id, `(${script.name})`);
console.log('Loader URL:', `${config.baseUrl}/loader/${script.id}.lua`);
console.log('\nKeys:');
created.forEach((k) => console.log('  ', k.value));
console.log('\n--- Loader snippet (paste into your executor) ---\n');
console.log(`script_key = "${created[0].value}";`);
console.log(`loadstring(game:HttpGet("${config.baseUrl}/loader/${script.id}.lua"))()`);
console.log('');
