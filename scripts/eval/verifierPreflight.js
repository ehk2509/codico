const fs = require('node:fs');
const path = require('node:path');

function referencedOutModules(source) {
  const found = new Set();
  const patterns = [
    /require\(\s*['"]\.\.\/out\/([^'"]+\.js)['"]\s*\)/g,
    /from\s+['"]\.\.\/out\/([^'"]+\.js)['"]/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      found.add(match[1]);
    }
  }

  return [...found];
}

function missingVerifierOutModules(source, workspace) {
  return referencedOutModules(source).filter(modulePath => {
    const sourceBase = path.join(workspace, 'src', modulePath.replace(/\.js$/, ''));
    return ![
      sourceBase + '.ts',
      sourceBase + '.tsx',
      sourceBase + '.js',
      path.join(workspace, 'out', modulePath),
    ].some(candidate => fs.existsSync(candidate));
  });
}

module.exports = { referencedOutModules, missingVerifierOutModules };
