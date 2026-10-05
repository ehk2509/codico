const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMcpEnvironment } = require('../out/mcpEnvironment.js');

test('MCP children do not inherit arbitrary parent secrets', () => {
  const env = buildMcpEnvironment({}, {
    PATH: '/usr/bin',
    HOME: '/home/test',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    AWS_SECRET_ACCESS_KEY: 'secret',
    GITHUB_TOKEN: 'ghp_secret',
    OPENAI_API_KEY: 'sk-secret',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
  });

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/test');
  assert.equal(env.LC_ALL, 'C');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
});

test('explicit MCP env values are passed and may override safe defaults', () => {
  const env = buildMcpEnvironment(
    { GITHUB_TOKEN: 'explicit', PATH: '/custom/bin' },
    { PATH: '/usr/bin', GITHUB_TOKEN: 'inherited-secret' },
  );

  assert.equal(env.GITHUB_TOKEN, 'explicit');
  assert.equal(env.PATH, '/custom/bin');
});
