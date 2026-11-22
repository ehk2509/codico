#!/usr/bin/env node
'use strict';
const path = require('node:path');
try {
  const { main } = require(path.join(__dirname, '..', 'dist', 'standalone.js'));
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write('codico: ' + (error?.stack || String(error)) + '\n');
    process.exitCode = 1;
  });
} catch (error) {
  process.stderr.write('codico: missing standalone bundle. Reinstall @codico/cli.\n' + error + '\n');
  process.exitCode = 1;
}
