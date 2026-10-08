const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

function mockUri(fsPath) {
  return {
    fsPath,
    toString() { return 'file://' + fsPath; },
  };
}

const api = { name: 'api', uri: mockUri('/workspace/api') };
const web = { name: 'web', uri: mockUri('/workspace/web') };
const files = new Map([
  ['/workspace/api/.codicoignore', 'secrets/**\n'],
  ['/workspace/web/.copilotignore', 'legacy/**\n'],
  ['/workspace/web/.codicoignore', '!legacy/allowed.txt\nprivate/**\n'],
]);

const vscodeMock = {
  workspace: {
    workspaceFolders: [api, web],
    fs: {
      async readFile(uri) {
        if (!files.has(uri.fsPath)) {
          throw new Error('ENOENT');
        }
        return Buffer.from(files.get(uri.fsPath));
      },
    },
    getWorkspaceFolder(uri) {
      return [api, web].find(folder =>
        uri.fsPath === folder.uri.fsPath || uri.fsPath.startsWith(folder.uri.fsPath + '/')
      );
    },
  },
  Uri: {
    joinPath(base, ...segments) {
      return mockUri(path.posix.join(base.fsPath.replace(/\\/g, '/'), ...segments));
    },
  },
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeMock;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  filterAllowedWorkspaceUris,
  resolveWorkspaceToolPath,
} = require('../out/workspaceSecurity.js');

test.after(() => {
  Module._load = originalLoad;
});

test('workspace policy resolves explicit multi-root paths', async () => {
  const target = await resolveWorkspaceToolPath('web/src/index.ts');
  assert.equal(target.folder.name, 'web');
  assert.equal(target.relativePath, 'src/index.ts');
  assert.equal(target.uri.fsPath, '/workspace/web/src/index.ts');
});

test('workspace policy rejects traversal and .codicoignore paths', async () => {
  await assert.rejects(
    resolveWorkspaceToolPath('../outside.txt'),
    /Unsafe path rejected/,
  );
  await assert.rejects(
    resolveWorkspaceToolPath('api/secrets/token.txt'),
    /Path excluded by \.codicoignore/,
  );
});

test('.codicoignore can override compatible .copilotignore rules', async () => {
  await assert.rejects(
    resolveWorkspaceToolPath('web/legacy/blocked.txt'),
    /Path excluded by \.codicoignore/,
  );

  const allowed = await resolveWorkspaceToolPath('web/legacy/allowed.txt');
  assert.equal(allowed.relativePath, 'legacy/allowed.txt');
});

test('workspace URI filtering hides ignored files across roots', async () => {
  const result = await filterAllowedWorkspaceUris([
    mockUri('/workspace/api/secrets/key.env'),
    mockUri('/workspace/api/src/index.ts'),
    mockUri('/workspace/web/private/config.json'),
    mockUri('/workspace/web/src/app.ts'),
    mockUri('/outside/file.txt'),
  ]);

  assert.deepEqual(
    result.map(uri => uri.fsPath),
    ['/workspace/api/src/index.ts', '/workspace/web/src/app.ts'],
  );
});
