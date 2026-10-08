const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const verifierSource = fs.readFileSync(
  path.join(__dirname, '..', 'eval', 'verifiers', 'streamResumeOverlapIntegrated.verifier.js'),
  'utf8',
);

function runVerifier({ moduleSource, streamSource, providerSource }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-overlap-verifier-'));
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });

  fs.writeFileSync(path.join(root, 'tests', 'verifier.test.js'), verifierSource);
  fs.writeFileSync(path.join(root, 'out', 'streamCompletion.js'), moduleSource);
  fs.writeFileSync(path.join(root, 'src', 'streamCompletion.ts'), streamSource);
  fs.writeFileSync(path.join(root, 'src', 'agentProvider.ts'), providerSource);

  const result = cp.spawnSync(process.execPath, ['--test', 'tests/verifier.test.js'], {
    cwd: root,
    encoding: 'utf8',
  });
  fs.rmSync(root, { recursive: true, force: true });
  return result;
}

const numericHelperModule = `
exports.computeSuffixOverlap = function computeSuffixOverlap(previous, continuation) {
  const max = Math.min(previous.length, continuation.length);
  for (let len = max; len > 0; len--) {
    if (previous.endsWith(continuation.slice(0, len))) return len;
  }
  return 0;
};
`;

test('overlap verifier accepts direct recovery integration', () => {
  const result = runVerifier({
    moduleSource: numericHelperModule,
    streamSource: `
      export function computeSuffixOverlap(previous: string, continuation: string): number {
        return 0;
      }
    `,
    providerSource: `
      function resumeStream(previous: string, continuation: string) {
        const overlap = computeSuffixOverlap(previous, continuation);
        return continuation.slice(overlap);
      }
    `,
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('overlap verifier accepts an exported recovery wrapper around the overlap helper', () => {
  const result = runVerifier({
    moduleSource: numericHelperModule,
    streamSource: `
      export function computeSuffixOverlap(previous: string, continuation: string): number {
        return 0;
      }
      export function processRecoveryChunk(previous: string, continuation: string): string {
        const overlap = computeSuffixOverlap(previous, continuation);
        return continuation.slice(overlap);
      }
    `,
    providerSource: `
      function resumeInterruptedStream(previous: string, continuation: string) {
        return processRecoveryChunk(previous, continuation);
      }
    `,
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('overlap verifier still rejects an overlap-substring helper with wrong semantics', () => {
  const result = runVerifier({
    moduleSource: `
      exports.computeOverlap = function computeOverlap(previous, continuation) {
        const max = Math.min(previous.length, continuation.length);
        for (let len = max; len > 0; len--) {
          const overlap = continuation.slice(0, len);
          if (previous.endsWith(overlap)) return overlap;
        }
        return '';
      };
    `,
    streamSource: `
      export function computeOverlap(previous: string, continuation: string): string {
        return '';
      }
    `,
    providerSource: `
      function resumeStream(previous: string, continuation: string) {
        const overlap = computeOverlap(previous, continuation);
        return continuation.slice(overlap.length);
      }
    `,
  });

  assert.notEqual(result.status, 0, 'wrong overlap-substring semantics must remain rejected');
});
