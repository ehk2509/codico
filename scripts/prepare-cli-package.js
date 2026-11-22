'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'dist', 'standalone.js');
const destination = path.join(root, 'packages', 'cli', 'dist', 'standalone.js');
if (!fs.existsSync(source)) {
  process.stderr.write('Standalone bundle missing. Run npm run compile before packaging.\n');
  process.exit(1);
}
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(source, destination);
process.stdout.write('Prepared standalone CLI package.\n');
