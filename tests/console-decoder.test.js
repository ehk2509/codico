'use strict';
// Windows command output in the console's OEM code page is decoded, not shown as "ex�cutable".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const esbuild = require('esbuild');

function load() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codico-dec-')), 'consoleDecoder.js');
  esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'consoleDecoder.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  return require(out);
}
const { ConsoleDecoder, decodeOem } = load();

test('OEM code page 850 output (French cmd.exe) is decoded', () => {
  // "un programme exécutable" and "Rép(s)" as cmd.exe writes them in code page 850
  const bytes = Buffer.from([0x65, 0x78, 0x82, 0x63, 0x75, 0x74, 0x61, 0x62, 0x6c, 0x65, 0x20, 0x52, 0x82, 0x70]);
  assert.equal(new ConsoleDecoder(850).write(bytes), 'exécutable Rép');
  assert.equal(decodeOem(Buffer.from([0x80, 0x87, 0x8a]), 437), 'Ççè');
});

test('UTF-8 output stays UTF-8, even when a character is split across chunks', () => {
  const decoder = new ConsoleDecoder(850);
  const bytes = Buffer.from('café ✓ ok', 'utf8');
  const split = bytes.indexOf(0xc3) + 1; // inside "é"
  const check = bytes.indexOf(0xe2) + 1; // inside "✓"
  const text = decoder.write(bytes.subarray(0, split)) + decoder.write(bytes.subarray(split, check)) + decoder.write(bytes.subarray(check)) + decoder.end();
  assert.equal(text, 'café ✓ ok');
});

test('a chunk mixing nothing but ASCII is unchanged', () => {
  assert.equal(new ConsoleDecoder(850).write(Buffer.from('v26.13.0\r\n')), 'v26.13.0\r\n');
});
