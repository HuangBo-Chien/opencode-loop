import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as journalText from '../src/journal-text.mjs';
import { EMBEDDING_SPACE, EMBEDDING_SPACE_DIGEST } from '../src/embeddings.mjs';
import {
  JOURNAL_EMBEDDING_SCHEMA_VERSION,
  JOURNAL_SCHEMA_VERSION,
  JOURNAL_SEARCH_MAX_BYTES,
  createJournalStore,
  stableJournalId,
} from '../src/journal-store.mjs';
import GraphPlugin from '../src/index.mjs';

const { captureRequest, sanitizeJournalText } = journalText;
const EXPECTED_MAX_INDEXED_TEXT_CHARS = 12_000;
const EXPECTED_MAX_AUTHORED_BODY_INPUT_CHARS = 32_000;

const JOURNAL_OPTIONS = Object.freeze({
  enabled: true,
  includeUserRequest: true,
  semanticSearch: true,
  maxUserRequestChars: 8000,
});

async function roots(t) {
  const root = await mkdtemp(join(tmpdir(), 'loop-journal-'));
  const worktree = join(root, 'project');
  const globalDirectory = join(root, 'global-entries');
  await mkdir(worktree, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, worktree, globalDirectory };
}

async function requireDirectoryLinkSupport(t, root) {
  const target = join(root, 'link-probe-target');
  const link = join(root, 'link-probe');
  await mkdir(target);
  try {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EACCES', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EPERM', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`directory symlink/junction creation unavailable on ${process.platform}: ${error.code} ${error.message}`);
      return false;
    }
    throw error;
  }
  await unlink(link);
  return true;
}

async function withPatchedFs(method, replacement, operation) {
  const original = fsPromises[method];
  fsPromises[method] = replacement(original);
  syncBuiltinESMExports();
  try {
    return await operation();
  } finally {
    fsPromises[method] = original;
    syncBuiltinESMExports();
  }
}

function growOnRetainedRead(handle, grow, observation) {
  let grown = false;
  async function growOnce() {
    if (grown) return;
    grown = true;
    await grow();
  }
  return {
    stat: handle.stat.bind(handle),
    async read(...args) {
      await growOnce();
      const result = await handle.read(...args);
      observation.readCalls += 1;
      observation.bytesRead += result.bytesRead;
      observation.maxBufferBytes = Math.max(observation.maxBufferBytes, args[0].byteLength);
      return result;
    },
    async readFile(...args) {
      await growOnce();
      const result = await handle.readFile(...args);
      observation.readFileCalls += 1;
      observation.bytesRead += typeof result === 'string' ? Buffer.byteLength(result) : result.byteLength;
      return result;
    },
    close: handle.close.bind(handle),
  };
}

function entry(overrides = {}) {
  const scope = overrides.scope ?? 'project';
  const kind = overrides.kind ?? (scope === 'global' ? 'promoted-insight' : 'insight');
  const title = overrides.title ?? 'Validated journal entry';
  const body = overrides.body ?? 'First paragraph.\n\nSecond paragraph.';
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    id: overrides.id ?? stableJournalId(scope, kind, title, body),
    scope,
    kind,
    title,
    createdAt: overrides.createdAt ?? '2026-09-10T12:00:00.000Z',
    tags: overrides.tags ?? ['runner', 'memory'],
    sourceIds: overrides.sourceIds ?? ['run:root'],
    metadata: overrides.metadata ?? { nested: { safe: true }, runId: 'root' },
    body,
  };
}

function serializedEntry(value) {
  const { body, ...frontmatter } = value;
  return `---\n${JSON.stringify(frontmatter)}\n---\n${body}`;
}

async function assertUnsafeGlobalDirectory(store, expected) {
  const operations = [
    ['write', () => store.write('global', expected)],
    ['read', () => store.read('global', expected.id)],
    ['list', () => store.list('global')],
    ['status', () => store.status()],
  ];
  for (const [name, operation] of operations) {
    await assert.rejects(operation, (error) => {
      assert.equal(error?.code, 'GLOBAL_JOURNAL_UNSAFE_PATH', `${name} error code`);
      assert.match(error?.message ?? '', /real directory/i, `${name} error message`);
      return true;
    }, name);
  }
}

test('sanitizeJournalText normalizes CRLF, trims outer whitespace, and reports exact truncation', () => {
  assert.deepEqual(
    sanitizeJournalText(' \r\nFirst line\r\nSecond line\r\n ', 100),
    { text: 'First line\nSecond line', truncated: false, redactions: 0 },
  );
  assert.deepEqual(
    sanitizeJournalText(' 12345\r\n67890 ', 8),
    { text: '12345\n67', truncated: true, redactions: 0 },
  );

  for (const input of [null, undefined, 7, {}, []]) {
    assert.throws(() => sanitizeJournalText(input, 10), TypeError);
  }
  for (const limit of [0, 32001, 1.5, '10', null]) {
    assert.throws(() => sanitizeJournalText('text', limit), TypeError);
  }
});

test('sanitizeJournalText never splits astral characters at raw or final truncation boundaries', () => {
  const finalBoundary = sanitizeJournalText('a😀b', 2);
  assert.deepEqual(finalBoundary, { text: 'a', truncated: true, redactions: 0 });
  assert.equal(finalBoundary.text.isWellFormed(), true);

  const limit = 8;
  const rawCap = limit + 4096;
  const rawBoundary = sanitizeJournalText(`${' '.repeat(rawCap - 1)}😀tail`, limit);
  assert.deepEqual(rawBoundary, { text: '', truncated: true, redactions: 0 });
  assert.equal(rawBoundary.text.isWellFormed(), true);
});

test('sanitizeJournalText rejects ill-formed Unicode before sanitizing or slicing', () => {
  for (const input of ['bad\uD800', '\uDC00bad', `${'x'.repeat(5000)}\uD800`]) {
    assert.throws(
      () => sanitizeJournalText(input, 32),
      { name: 'TypeError', message: /well-formed Unicode/i },
    );
  }
});

test('captureRequest never retains half an astral character at its bounded part edge', () => {
  const limit = 8;
  const rawCap = limit + 4096;
  const captured = captureRequest([
    { type: 'text', text: `${' '.repeat(rawCap - 1)}😀tail` },
  ], { ...JOURNAL_OPTIONS, maxUserRequestChars: limit });

  assert.equal(captured, null);
});

test('journal text exports the shared indexed-text boundary', () => {
  assert.equal(journalText.MAX_INDEXED_TEXT_CHARS, EXPECTED_MAX_INDEXED_TEXT_CHARS);
  assert.equal(journalText.MAX_AUTHORED_BODY_INPUT_CHARS, EXPECTED_MAX_AUTHORED_BODY_INPUT_CHARS);
});

test('sanitizeJournalText bounds raw input before normalization and redaction', () => {
  const result = sanitizeJournalText(`token=${'x'.repeat(50_000)}\nsecret=distant-value`, 32);

  assert.deepEqual(result, {
    text: 'token=[REDACTED]',
    truncated: true,
    redactions: 1,
  });
  assert.ok(result.text.length <= 32);
});

test('sanitizeJournalText redacts common credentials and counts replacements', () => {
  const secrets = [
    'bearer-secret-123',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123',
    'sk-liveSecret123',
    'ghp_abcdefghijklmnopqrstuvwxyz',
    'github_pat_abcDEF0123456789',
    'xoxb-123456789-secretvalue',
    'xoxp-987654321-secretvalue',
    'alpha beta',
    'bravo',
    'charlie',
    'delta',
    'echo',
  ];
  const input = [
    `Authorization: Bearer ${secrets[0]}`,
    `jwt: ${secrets[1]}`,
    `openai: ${secrets[2]}`,
    `github: ${secrets[3]}`,
    `fine-grained: ${secrets[4]}`,
    `slack-bot: ${secrets[5]}`,
    `slack-user: ${secrets[6]}`,
    `apiKey = "${secrets[7]}"`,
    `API_KEY: ${secrets[8]}`,
    `token=${secrets[9]}`,
    `Secret: '${secrets[10]}'`,
    `password = ${secrets[11]}`,
  ].join('\r\n');

  const result = sanitizeJournalText(input, 4000);
  assert.equal(result.redactions, secrets.length);
  assert.equal((result.text.match(/\[REDACTED\]/g) ?? []).length, secrets.length);
  for (const secret of secrets) assert.equal(result.text.includes(secret), false, `leaked ${secret}`);
  assert.equal(result.truncated, false);
});

test('sanitizeJournalText redacts compact JWTs and complete scheme-bearing assignments', () => {
  const result = sanitizeJournalText([
    'compact JWT eyJ9.e30.sig',
    'token=Bearer supersecret',
    'ordinary dotted value abc.def.ghi',
    'short near miss eyJ9.e3.sig',
    'tokenCount=public value',
  ].join('\n'), 1000);

  assert.deepEqual(result, {
    text: [
      'compact JWT [REDACTED]',
      'token=[REDACTED]',
      'ordinary dotted value abc.def.ghi',
      'short near miss eyJ9.e3.sig',
      'tokenCount=public value',
    ].join('\n'),
    truncated: false,
    redactions: 2,
  });
});

test('captureRequest redacts a JWT payload segment that crosses the bounded raw tail', () => {
  const payload = 'a'.repeat(12_500);
  const unread = {};
  let reads = 0;
  Object.defineProperty(unread, 'type', {
    get() {
      reads += 1;
      throw new Error('part beyond the bounded raw cap must not be read');
    },
  });

  const result = captureRequest([
    { type: 'text', text: `JWT eyJhbGciOiJIUzI1NiJ9.${payload}.signature` },
    unread,
  ], JOURNAL_OPTIONS);

  assert.deepEqual(result, {
    text: 'JWT [REDACTED]',
    truncated: true,
    redactions: 1,
  });
  assert.equal(reads, 0);
});

test('captureRequest redacts a truncated JWT when the bounded raw tail ends on a separator', () => {
  const limit = 32;
  const rawCap = limit + 4096;
  const prefix = 'JWT ';
  const header = 'eyJ9';
  const payload = 'a'.repeat(rawCap - prefix.length - header.length - 2);
  const unread = {};
  let reads = 0;
  Object.defineProperty(unread, 'type', {
    get() {
      reads += 1;
      throw new Error('part beyond the bounded raw cap must not be read');
    },
  });

  const result = captureRequest([
    { type: 'text', text: `${prefix}${header}.${payload}.signature` },
    unread,
  ], { ...JOURNAL_OPTIONS, maxUserRequestChars: limit });

  assert.deepEqual(result, {
    text: 'JWT [REDACTED]',
    truncated: true,
    redactions: 1,
  });
  assert.equal(reads, 0);
});

test('captureRequest redacts prefixed tokens cut within the bounded raw tail', () => {
  const limit = 32;
  const rawCap = limit + 4096;
  const prefixes = ['sk-', 'ghp_', 'github_pat_', 'xoxa-', 'xoxb-', 'xoxp-', 'xoxr-', 'xoxs-'];

  for (const prefix of prefixes) {
    const capturedToken = `${prefix}abc`;
    const unread = {};
    let reads = 0;
    Object.defineProperty(unread, 'type', {
      get() {
        reads += 1;
        throw new Error('part beyond the bounded raw cap must not be read');
      },
    });

    const result = captureRequest([
      { type: 'text', text: `${' '.repeat(rawCap - capturedToken.length)}${capturedToken}defghijkl` },
      unread,
    ], { ...JOURNAL_OPTIONS, maxUserRequestChars: limit });

    assert.deepEqual(result, {
      text: '[REDACTED]',
      truncated: true,
      redactions: 1,
    }, prefix);
    assert.equal(reads, 0, prefix);
  }
});

test('sanitizeJournalText treats only a complete assignment marker as already redacted', () => {
  const result = sanitizeJournalText([
    'token=[REDACTED]',
    'clientSecret = "[REDACTED]"   ',
    "password = ' [REDACTED] '",
    'token=[REDACTED]-actual-secret',
    'SECRET_KEY="[REDACTED]-actual-secret"',
  ].join('\n'), 1000);

  assert.deepEqual(result, {
    text: [
      'token=[REDACTED]',
      'clientSecret = "[REDACTED]"   ',
      "password = ' [REDACTED] '",
      'token=[REDACTED]',
      'SECRET_KEY="[REDACTED]"',
    ].join('\n'),
    truncated: false,
    redactions: 2,
  });
  assert.equal(result.text.includes('actual-secret'), false);
});

test('sanitizeJournalText redacts prefixed environment assignments without matching prose', () => {
  const result = sanitizeJournalText([
    'DB_PASSWORD=db-pass-value',
    'client_secret: "client secret value"',
    'OpenAI_Api_Key = openai-key-value',
    'access_token:\taccess-token-value',
    'Rotate DB_PASSWORD after deployment.',
    'CLIENT_SECRET documentation is internal.',
    'The OPENAI_API_KEY name is conventional.',
    'ACCESS_TOKEN policy is unchanged.',
  ].join('\n'), 1000);

  assert.deepEqual(result, {
    text: [
      'DB_PASSWORD=[REDACTED]',
      'client_secret: "[REDACTED]"',
      'OpenAI_Api_Key = [REDACTED]',
      'access_token:\t[REDACTED]',
      'Rotate DB_PASSWORD after deployment.',
      'CLIENT_SECRET documentation is internal.',
      'The OPENAI_API_KEY name is conventional.',
      'ACCESS_TOKEN policy is unchanged.',
    ].join('\n'),
    truncated: false,
    redactions: 4,
  });
});

test('sanitizeJournalText redacts suffixed assignment keys with mixed prefixes only when assigned', () => {
  const result = sanitizeJournalText([
    'clientSecret=client-value',
    'accessToken: "access value"',
    'openaiApiKey = openai-value',
    'x-api-key:\tx-key-value',
    'clientSecret documentation remains visible.',
    'Rotate accessToken after deployment.',
    'The openaiApiKey name is conventional.',
    'Send the x-api-key header.',
  ].join('\n'), 1000);

  assert.deepEqual(result, {
    text: [
      'clientSecret=[REDACTED]',
      'accessToken: "[REDACTED]"',
      'openaiApiKey = [REDACTED]',
      'x-api-key:\t[REDACTED]',
      'clientSecret documentation remains visible.',
      'Rotate accessToken after deployment.',
      'The openaiApiKey name is conventional.',
      'Send the x-api-key header.',
    ].join('\n'),
    truncated: false,
    redactions: 4,
  });
});

test('sanitizeJournalText classifies whole secret-key segments without substring false positives', () => {
  const result = sanitizeJournalText([
    String.raw`SECRET_KEY="alpha\"beta"`,
    'AWS_SECRET_ACCESS_KEY=bravo',
    'sessionPasswordHint: charlie delta',
    'refreshTokenExpiresAt=echo',
    'third_party_apikey_value: "foxtrot golf"',
    'service_api_key_version = hotel',
    'secretary=public secretary',
    'monkey=public monkey',
    'keyboard=public keyboard',
    'apiaryKey=public apiary',
  ].join('\n'), 2000);

  assert.deepEqual(result, {
    text: [
      'SECRET_KEY="[REDACTED]"',
      'AWS_SECRET_ACCESS_KEY=[REDACTED]',
      'sessionPasswordHint: charlie delta',
      'refreshTokenExpiresAt=echo',
      'third_party_apikey_value: "foxtrot golf"',
      'service_api_key_version = hotel',
      'secretary=public secretary',
      'monkey=public monkey',
      'keyboard=public keyboard',
      'apiaryKey=public apiary',
    ].join('\n'),
    truncated: false,
    redactions: 2,
  });
});

test('sanitizeJournalText excludes metadata-suffixed keys while retaining credential keys', () => {
  const metadata = [
    'password_policy=strong',
    'token_count=3',
    'secret_length=32',
    'access_token_ttl=3600',
    'password_enabled=true',
    'secret_required=false',
    'token_type=bearer',
    'password_name=login',
    'secret_hint=rotate',
    'token_label=primary',
  ];
  const credentials = [
    'PASSWORD=alpha',
    'clientSecret=bravo',
    'SECRET_KEY=charlie',
    'AWS_SECRET_ACCESS_KEY=delta',
    'ACCESS_TOKEN=echo',
  ];

  assert.deepEqual(sanitizeJournalText([...metadata, ...credentials].join('\n'), 2000), {
    text: [...metadata, ...credentials.map((line) => `${line.slice(0, line.indexOf('=') + 1)}[REDACTED]`)].join('\n'),
    truncated: false,
    redactions: credentials.length,
  });
});

test('sanitizeJournalText redacts camel secretKey while preserving camel secret metadata', () => {
  assert.deepEqual(sanitizeJournalText([
    'secretKey=alpha',
    'secretCount=2',
    'secretPolicy=rotate',
  ].join('\n'), 1000), {
    text: [
      'secretKey=[REDACTED]',
      'secretCount=2',
      'secretPolicy=rotate',
    ].join('\n'),
    truncated: false,
    redactions: 1,
  });
});

test('sanitizeJournalText ignores non-assignment operators and bare TypeScript annotations', () => {
  const types = ['string', 'number', 'boolean', 'unknown', 'any', 'never', 'object', 'symbol', 'bigint', 'void', 'undefined', 'null'];
  const operators = [
    'token == candidate',
    'clientSecret === candidate',
    'accessToken => handler',
  ];
  const annotations = types.flatMap((type) => [
    `clientSecret: ${type};`,
    `accessToken: ${type}[];`,
  ]);
  const input = [
    ...operators,
    ...annotations,
    String.raw`clientSecret: "alpha\"beta";`,
    'AWS_SECRET_ACCESS_KEY=aws-secret-value',
  ];

  assert.deepEqual(sanitizeJournalText(input.join('\n'), 4000), {
    text: [
      ...operators,
      ...annotations,
      'clientSecret: "[REDACTED]";',
      'AWS_SECRET_ACCESS_KEY=[REDACTED]',
    ].join('\n'),
    truncated: false,
    redactions: 2,
  });
});

test('sanitizeJournalText skips bounded TypeScript unions, generics, arrays, and qualified names', () => {
  const annotations = [
    'clientSecret: string | undefined;',
    'accessToken: Promise<string>;',
    'PASSWORD: Auth.Credential[];',
    'SECRET_KEY: Promise<Auth.Credential[]> | undefined;',
  ];

  assert.deepEqual(sanitizeJournalText([
    ...annotations,
    'PASSWORD=alpha',
    'clientSecret=bravo',
    'SECRET_KEY=charlie',
    'AWS_SECRET_ACCESS_KEY=delta',
    'ACCESS_TOKEN=echo',
  ].join('\n'), 2000), {
    text: [
      ...annotations,
      'PASSWORD=[REDACTED]',
      'clientSecret=[REDACTED]',
      'SECRET_KEY=[REDACTED]',
      'AWS_SECRET_ACCESS_KEY=[REDACTED]',
      'ACCESS_TOKEN=[REDACTED]',
    ].join('\n'),
    truncated: false,
    redactions: 5,
  });
});

test('sanitizeJournalText redacts capitalized bare credential values after colons', () => {
  const assignments = [
    'API_KEY: ABCDEFGHIJKLMNOP',
    'password: Hunter2',
    'token: SecretValue',
  ];
  const annotations = [
    'refreshToken: string;',
    'refreshToken: Promise<string>;',
    'refreshToken: Auth.Credential;',
    'refreshToken: Credential | undefined;',
    'refreshToken: z.string()',
  ];

  assert.deepEqual(sanitizeJournalText([...assignments, ...annotations].join('\n'), 2000), {
    text: [
      'API_KEY: [REDACTED]',
      'password: [REDACTED]',
      'token: [REDACTED]',
      ...annotations,
    ].join('\n'),
    truncated: false,
    redactions: assignments.length,
  });
});

test('sanitizeJournalText redacts bounded line-level assignments and escaped quoted values', () => {
  const result = sanitizeJournalText([
    'password: alpha beta',
    'API key: alpha-beta, visible=comma',
    String.raw`clientSecret: "alpha\"beta"; visible=semicolon`,
    'token: gamma delta} visible=brace',
    'secret: epsilon zeta] visible=bracket',
    'Rotate API key after deployment.',
  ].join('\n'), 1000);

  assert.deepEqual(result, {
    text: [
      'password: [REDACTED]',
      'API key: [REDACTED], visible=comma',
      'clientSecret: "[REDACTED]"; visible=semicolon',
      'token: [REDACTED]} visible=brace',
      'secret: [REDACTED]] visible=bracket',
      'Rotate API key after deployment.',
    ].join('\n'),
    truncated: false,
    redactions: 5,
  });
});

test('sanitizeJournalText distinguishes empty assignments from punctuation-prefixed values', () => {
  assert.deepEqual(sanitizeJournalText([
    'PASSWORD=,actual-secret',
    'PASSWORD=;actual-secret',
    'PASSWORD=}actual-secret',
    'PASSWORD=]actual-secret',
    'PASSWORD=',
  ].join('\n'), 1000), {
    text: [
      'PASSWORD=[REDACTED]',
      'PASSWORD=[REDACTED]',
      'PASSWORD=[REDACTED]',
      'PASSWORD=[REDACTED]',
      'PASSWORD=',
    ].join('\n'),
    truncated: false,
    redactions: 4,
  });
});

test('sanitizeJournalText redacts literal secretAccessKey values but preserves code references', () => {
  assert.deepEqual(sanitizeJournalText([
    'secretAccessKey=actual-secret-value',
    'const token = response.token;',
    'password=process.env.PASSWORD',
    'clientSecret: z.string()',
    'password: alpha beta',
    'clientSecret="response.token"',
    'token=Bearer literal-bearer-token',
    'token=eyJ9.e30.signature',
    'apiKey=sk-actual-token',
  ].join('\n'), 2000), {
    text: [
      'secretAccessKey=[REDACTED]',
      'const token = response.token;',
      'password=process.env.PASSWORD',
      'clientSecret: z.string()',
      'password: [REDACTED]',
      'clientSecret="[REDACTED]"',
      'token=[REDACTED]',
      'token=[REDACTED]',
      'apiKey=[REDACTED]',
    ].join('\n'),
    truncated: false,
    redactions: 6,
  });
});

test('sanitizeJournalText redacts ambiguous dotted credentials but preserves explicit code contexts', () => {
  assert.deepEqual(sanitizeJournalText([
    'DB_PASSWORD=alpha.beta',
    'API_KEY=live.key-123',
    'token=response.token',
    'password=process.env.PASSWORD',
    'clientSecret: z.string()',
    'const password = () => response.password;',
    'clientSecret: string;',
  ].join('\n'), 2000), {
    text: [
      'DB_PASSWORD=[REDACTED]',
      'API_KEY=[REDACTED]',
      'token=[REDACTED]',
      'password=process.env.PASSWORD',
      'clientSecret: z.string()',
      'const password = () => response.password;',
      'clientSecret: string;',
    ].join('\n'),
    truncated: false,
    redactions: 3,
  });
});

test('captureRequest joins only nonempty text parts and never inspects attachments', () => {
  const attachment = { type: 'file', filename: 'secret.bin', data: Buffer.from('attachment bytes') };
  Object.defineProperty(attachment, 'text', {
    get() { throw new Error('attachment text must not be inspected'); },
  });
  const parts = [
    attachment,
    { type: 'text', text: 'First line' },
    { type: 'text', text: '   ' },
    { type: 'image', text: 'ignored image description' },
    { type: 'text', text: 'Second\r\nline' },
    { type: 'text', text: 42 },
  ];

  assert.deepEqual(captureRequest(parts, JOURNAL_OPTIONS), {
    text: 'First line\n\nSecond\nline',
    truncated: false,
    redactions: 0,
  });
  assert.equal(captureRequest(parts, { ...JOURNAL_OPTIONS, enabled: false }), null);
  assert.equal(captureRequest(parts, { ...JOURNAL_OPTIONS, includeUserRequest: false }), null);
  assert.equal(captureRequest({}, JOURNAL_OPTIONS), null);
  assert.equal(captureRequest([{ type: 'text', text: ' \r\n ' }], JOURNAL_OPTIONS), null);
});

test('captureRequest inspects at most 256 parts and marks an omitted tail after text as truncated', () => {
  let tailReads = 0;
  const unreadTail = {};
  Object.defineProperty(unreadTail, 'type', {
    get() {
      tailReads += 1;
      throw new Error('part beyond the inspection ceiling must not be read');
    },
  });
  const parts = [
    { type: 'text', text: 'Bounded request' },
    ...Array.from({ length: 255 }, () => ({ type: 'file' })),
    unreadTail,
  ];

  assert.deepEqual(captureRequest(parts, JOURNAL_OPTIONS), {
    text: 'Bounded request',
    truncated: true,
    redactions: 0,
  });
  assert.equal(tailReads, 0);
});

test('captureRequest stops reading parts after an oversized text part establishes truncation', () => {
  const unread = { type: 'text' };
  let reads = 0;
  Object.defineProperty(unread, 'text', {
    get() {
      reads += 1;
      throw new Error('text beyond the bounded raw cap must not be read');
    },
  });

  const result = captureRequest([
    { type: 'text', text: `token=${'x'.repeat(50_000)}` },
    unread,
  ], { ...JOURNAL_OPTIONS, maxUserRequestChars: 32 });

  assert.deepEqual(result, {
    text: 'token=[REDACTED]',
    truncated: true,
    redactions: 1,
  });
  assert.equal(reads, 0);
  assert.ok(result.text.length <= 32);
});

test('captureRequest stops before reading the next part when accumulated text reaches the raw cap', () => {
  const limit = 32;
  const rawCap = limit + 4096;
  const unread = {};
  Object.defineProperties(unread, {
    type: {
      get() { throw new Error('type beyond the bounded raw cap must not be read'); },
    },
    text: {
      get() { throw new Error('text beyond the bounded raw cap must not be read'); },
    },
  });

  const result = captureRequest([
    { type: 'text', text: `token=${'x'.repeat(rawCap - 'token='.length)}` },
    unread,
  ], { ...JOURNAL_OPTIONS, maxUserRequestChars: limit });

  assert.deepEqual(result, {
    text: 'token=[REDACTED]',
    truncated: true,
    redactions: 1,
  });
});

test('captureRequest stops before reading the next part when whitespace exhausts the inspection budget', () => {
  const limit = 32;
  const rawCap = limit + 4096;
  let reads = 0;
  const unread = {};
  Object.defineProperty(unread, 'type', {
    get() {
      reads += 1;
      throw new Error('part after bounded whitespace must not be read');
    },
  });

  assert.equal(captureRequest([
    { type: 'text', text: ' '.repeat(rawCap) },
    unread,
  ], { ...JOURNAL_OPTIONS, maxUserRequestChars: limit }), null);
  assert.equal(reads, 0);
});

test('captureRequest bounds each text part before trimming it', () => {
  const limit = 32;
  const trimLengths = [];
  const originalTrim = String.prototype.trim;
  String.prototype.trim = function boundedTrimProbe() {
    trimLengths.push(this.length);
    return Reflect.apply(originalTrim, this, []);
  };

  let result;
  try {
    result = captureRequest([
      { type: 'text', text: `payload-${'x'.repeat(50_000)}` },
    ], { ...JOURNAL_OPTIONS, maxUserRequestChars: limit });
  } finally {
    String.prototype.trim = originalTrim;
  }

  assert.ok(trimLengths.every((length) => length <= limit + 4096), `unbounded trim lengths: ${trimLengths.join(', ')}`);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= limit);
});

test('captureRequest returns null when its bounded sanitized text is empty', () => {
  assert.equal(captureRequest([
    { type: 'text', text: `${' '.repeat(50_000)}text beyond the capture bound` },
  ], { ...JOURNAL_OPTIONS, maxUserRequestChars: 32 }), null);
});

test('chat hook stores dotted credentials redacted in the first request', async (t) => {
  const { worktree } = await roots(t);
  const hooks = await GraphPlugin({ worktree });
  const sessionID = 'root-dotted-secrets';

  await hooks['chat.message'](
    { sessionID, agent: 'graph-orchestrator' },
    { parts: [{ type: 'text', text: 'DB_PASSWORD=alpha.beta\nAPI_KEY=live.key-123' }] },
  );
  await hooks['chat.message'](
    { sessionID, agent: 'graph-orchestrator' },
    { parts: [{ type: 'text', text: 'API_KEY=later.secret' }] },
  );

  const persisted = JSON.parse(await readFile(join(worktree, '.opencode-loop', 'runs', `${sessionID}.json`), 'utf8'));
  assert.equal(persisted.request.text, 'DB_PASSWORD=[REDACTED]\nAPI_KEY=[REDACTED]');
  assert.equal(persisted.request.redactions, 2);
  assert.equal(persisted.request.truncated, false);
  assert.equal(persisted.requestCaptureCompleted, true);
});

test('stableJournalId returns deterministic lowercase SHA-256 identifiers', () => {
  const id = stableJournalId('project', 'run-summary', 'root');
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(id, stableJournalId('project', 'run-summary', 'root'));
  assert.notEqual(id, stableJournalId('global', 'run-summary', 'root'));
});

test('journal store round trips Markdown with one JSON frontmatter object', async (t) => {
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const expected = entry({ kind: 'run-summary', body: 'Summary body.\n\n---\nA body delimiter remains text.' });

  const result = await store.write('project', expected);
  assert.equal(result.created, true);
  assert.deepEqual(result.entry, expected);
  assert.deepEqual(await store.read('project', expected.id), expected);
  assert.equal(await store.exists('project', expected.id), true);
  assert.equal(await store.exists('project', stableJournalId('missing')), false);

  const target = join(worktree, '.opencode-loop', 'journal', 'entries', `${expected.id}.md`);
  const raw = await readFile(target, 'utf8');
  assert.match(raw, /^---\n\{[^\n]+\}\n---\n/);
  const delimiter = raw.indexOf('\n---\n', 4);
  const frontmatter = JSON.parse(raw.slice(4, delimiter));
  assert.equal(Object.hasOwn(frontmatter, 'body'), false);
  assert.deepEqual({ ...frontmatter, body: raw.slice(delimiter + 5) }, expected);
  if (process.platform !== 'win32') assert.equal((await lstat(target)).mode & 0o777, 0o600);
});

test('journal store round trips legacy entries above the new indexed-text write boundary', async (t) => {
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const expected = entry({
    title: 'Legacy external entry',
    body: 'l'.repeat(journalText.MAX_INDEXED_TEXT_CHARS + 1),
  });

  assert.ok(`${expected.title}\n\n${expected.body}`.length > journalText.MAX_INDEXED_TEXT_CHARS);
  assert.equal((await store.write('project', expected)).created, true);
  assert.deepEqual(await store.read('project', expected.id), expected);
});

test('project and global journals are isolated and enforce their allowed kinds', async (t) => {
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const id = stableJournalId('shared-entry');
  const projectEntry = entry({ id, scope: 'project', kind: 'insight', body: 'Project-only detail.' });
  const globalEntry = entry({ id, scope: 'global', kind: 'promoted-insight', body: 'Sanitized global detail.' });

  await store.write('project', projectEntry);
  await store.write('global', globalEntry);
  assert.deepEqual(await store.read('project', id), projectEntry);
  assert.deepEqual(await store.read('global', id), globalEntry);
  assert.deepEqual(await store.list('project'), [projectEntry]);
  assert.deepEqual(await store.list('global'), [globalEntry]);

  await assert.rejects(() => store.write('project', entry({ scope: 'project', kind: 'promoted-insight' })), TypeError);
  await assert.rejects(() => store.write('global', entry({ scope: 'global', kind: 'insight' })), TypeError);
});

test('bounded journal listing iterates without readdir while ordinary listing remains unbounded', async (t) => {
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const entries = Array.from({ length: 3 }, (_, index) => entry({
    title: `Bounded candidate ${index}`,
    createdAt: `2026-09-10T12:00:0${index}.000Z`,
  }));
  await Promise.all(entries.map((candidate) => store.write('project', candidate)));

  const bounded = await withPatchedFs(
    'readdir',
    () => async () => { throw new Error('bounded listing must use directory iteration'); },
    () => store.listBounded('project', { maxCandidates: 2, maxBytes: 2 * 1024 * 1024 }),
  );

  assert.equal(bounded.entries.length, 2);
  assert.equal(bounded.corrupt, 0);
  assert.deepEqual(bounded.candidates, {
    inspected: 2,
    considered: 2,
    loaded: 2,
    bytes: bounded.candidates.bytes,
    truncated: true,
  });
  assert.ok(bounded.candidates.bytes > 0);
  assert.ok(bounded.candidates.bytes <= 2 * 1024 * 1024);
  assert.equal(Object.isFrozen(bounded), true);
  assert.equal(Object.isFrozen(bounded.entries), true);
  assert.equal(Object.isFrozen(bounded.candidates), true);
  assert.equal((await store.list('project')).length, 3);
  assert.equal((await store.status()).project.entries, 3);
});

test('bounded journal listing charges same-inode growth and stops before its aggregate byte budget is exceeded', async (t) => {
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const entries = [
    entry({ title: 'Growing bounded candidate alpha', body: 'alpha' }),
    entry({ title: 'Growing bounded candidate bravo', body: 'bravo' }),
    entry({ title: 'Growing bounded candidate charlie', body: 'charlie' }),
  ];
  await Promise.all(entries.map((candidate) => store.write('project', candidate)));
  const entriesDirectory = join(worktree, '.opencode-loop', 'journal', 'entries');
  const targets = new Set(entries.map((candidate) => join(entriesDirectory, `${candidate.id}.md`)));
  const before = new Map(await Promise.all([...targets].map(async (target) => [target, await lstat(target)])));
  const grownEntryBytes = 800_000;
  const observation = { readCalls: 0, readFileCalls: 0, bytesRead: 0, maxBufferBytes: 0 };
  const grown = new Set();

  const bounded = await withPatchedFs('open', (originalOpen) => async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    const target = String(path);
    if (!targets.has(target)) return handle;
    return growOnRetainedRead(handle, async () => {
      const current = await lstat(target);
      await appendFile(target, 'x'.repeat(grownEntryBytes - current.size));
      grown.add(target);
    }, observation);
  }, () => store.listBounded('project'));

  assert.equal(grown.size, 3);
  for (const target of targets) {
    const after = await lstat(target);
    assert.equal(after.dev, before.get(target).dev, `${target} device changed`);
    assert.equal(after.ino, before.get(target).ino, `${target} inode changed`);
    assert.equal(after.size, grownEntryBytes);
  }
  assert.equal(observation.readFileCalls, 0, 'bounded reads must not use whole-handle readFile');
  assert.ok(observation.readCalls > 1);
  assert.ok(observation.maxBufferBytes <= 64 * 1024, `read buffer was ${observation.maxBufferBytes} bytes`);
  assert.equal(observation.bytesRead, JOURNAL_SEARCH_MAX_BYTES + 1);
  assert.equal(bounded.entries.length, 2);
  assert.equal(bounded.corrupt, 0);
  assert.deepEqual(bounded.candidates, {
    inspected: 3,
    considered: 3,
    loaded: 2,
    bytes: grownEntryBytes * 2,
    truncated: true,
  });
});

test('bounded journal listing caps inspection across 1000 non-Markdown and invalid-name files', async (t) => {
  const { JOURNAL_SEARCH_MAX_DIRENTS } = await import('../src/journal-store.mjs');
  const { worktree, globalDirectory } = await roots(t);
  const entriesDirectory = join(worktree, '.opencode-loop', 'journal', 'entries');
  await mkdir(entriesDirectory, { recursive: true });
  await Promise.all(Array.from({ length: 1000 }, (_, index) => writeFile(
    join(entriesDirectory, index < 32 ? `invalid-${index}.md` : `noise-${index}.txt`),
    'noise',
  )));
  const store = createJournalStore({ worktree, globalDirectory });
  let yielded = 0;

  const bounded = await withPatchedFs(
    'opendir',
    (originalOpendir) => async (...args) => {
      const handle = await originalOpendir(...args);
      return {
        close: handle.close.bind(handle),
        async *[Symbol.asyncIterator]() {
          for await (const item of handle) {
            yielded += 1;
            if (yielded > 256) throw new Error('bounded listing exceeded its dirent budget');
            yield item;
          }
        },
      };
    },
    () => store.listBounded('project'),
  );

  assert.equal(JOURNAL_SEARCH_MAX_DIRENTS, 256);
  assert.equal(yielded, JOURNAL_SEARCH_MAX_DIRENTS);
  assert.equal(bounded.candidates.inspected, JOURNAL_SEARCH_MAX_DIRENTS);
  assert.ok(bounded.candidates.considered <= 32);
  assert.equal(bounded.candidates.loaded, 0);
  assert.equal(bounded.candidates.bytes, 0);
  assert.equal(bounded.candidates.truncated, true);
  assert.deepEqual(bounded.entries, []);
});

test('zero candidate or byte budgets inspect no journal dirents', async (t) => {
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  await store.write('project', entry({ title: 'Must remain uninspected' }));
  let yielded = 0;

  await withPatchedFs(
    'opendir',
    (originalOpendir) => async (...args) => {
      const handle = await originalOpendir(...args);
      return {
        close: handle.close.bind(handle),
        async *[Symbol.asyncIterator]() {
          for await (const item of handle) {
            yielded += 1;
            throw new Error(`zero budget inspected ${item.name}`);
          }
        },
      };
    },
    async () => {
      for (const options of [
        { maxCandidates: 0, maxBytes: 2 * 1024 * 1024 },
        { maxCandidates: 64, maxBytes: 0 },
      ]) {
        const bounded = await store.listBounded('project', options);
        assert.deepEqual(bounded.candidates, {
          inspected: 0,
          considered: 0,
          loaded: 0,
          bytes: 0,
          truncated: true,
        });
        assert.deepEqual(bounded.entries, []);
      }
    },
  );

  assert.equal(yielded, 0);
});

test('a missing sidecar read tolerates another writer creating the validated index root', async (t) => {
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const expected = entry();
  await store.write('project', expected);
  const indexDirectory = join(worktree, '.opencode-loop', 'journal', 'index');
  const sidecarPath = join(indexDirectory, `${expected.id}.json`);
  let createdDuringMiss = false;

  const sidecar = await withPatchedFs(
    'lstat',
    (originalLstat) => async (path, ...args) => {
      try {
        return await originalLstat(path, ...args);
      } catch (error) {
        if (!createdDuringMiss && path === sidecarPath && error?.code === 'ENOENT') {
          createdDuringMiss = true;
          await mkdir(indexDirectory);
        }
        throw error;
      }
    },
    () => store.readEmbedding('project', expected.id),
  );

  assert.equal(createdDuringMiss, true);
  assert.equal(sidecar, null);
});

test('embedding sidecar reads reject same-inode growth past their strict byte limit with one-byte probing', async (t) => {
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const expected = entry({ title: 'Growing embedding sidecar' });
  await store.writeEmbedding('project', expected.id, {
    digest: expected.id,
    dimensions: 2,
    schemaVersion: JOURNAL_EMBEDDING_SCHEMA_VERSION,
    space: EMBEDDING_SPACE,
    spaceDigest: EMBEDDING_SPACE_DIGEST,
    vector: [1, 0],
  });
  const target = join(worktree, '.opencode-loop', 'journal', 'index', `${expected.id}.json`);
  const before = await lstat(target);
  const sidecarLimit = 262_144;
  const grownSidecarBytes = 1_000_000;
  const observation = { readCalls: 0, readFileCalls: 0, bytesRead: 0, maxBufferBytes: 0 };
  let grew = false;

  const sidecar = await withPatchedFs('open', (originalOpen) => async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (String(path) !== target) return handle;
    return growOnRetainedRead(handle, async () => {
      const current = await lstat(target);
      await appendFile(target, 'x'.repeat(grownSidecarBytes - current.size));
      grew = true;
    }, observation);
  }, () => store.readEmbedding('project', expected.id));

  const after = await lstat(target);
  assert.equal(grew, true);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, grownSidecarBytes);
  assert.equal(sidecar, null);
  assert.equal(observation.readFileCalls, 0, 'sidecar reads must not use whole-handle readFile');
  assert.ok(observation.readCalls > 1);
  assert.ok(observation.maxBufferBytes <= 64 * 1024, `read buffer was ${observation.maxBufferBytes} bytes`);
  assert.equal(observation.bytesRead, sidecarLimit + 1);
});

test('journal store rejects resolved equal or nested project and global entry roots at construction', async (t) => {
  const { worktree } = await roots(t);
  const projectDirectory = join(worktree, '.opencode-loop', 'journal', 'entries');
  const scenarios = [
    ['resolved equal roots', relative(process.cwd(), projectDirectory)],
    ['global root containing project root', join(projectDirectory, '..')],
    ['project root containing global root', join(projectDirectory, 'promoted')],
  ];

  for (const [label, globalDirectory] of scenarios) {
    assert.throws(
      () => createJournalStore({ worktree, globalDirectory }),
      { name: 'TypeError', message: /project and global journal entry roots must not overlap/i },
      label,
    );
  }
});

test('journal store compares project and global entry roots case-insensitively on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const { worktree } = await roots(t);
  const projectDirectory = join(worktree, '.opencode-loop', 'journal', 'entries');
  const differentlyCasedDirectory = projectDirectory.toUpperCase();
  assert.notEqual(differentlyCasedDirectory, projectDirectory);

  assert.throws(
    () => createJournalStore({ worktree, globalDirectory: differentlyCasedDirectory }),
    { name: 'TypeError', message: /project and global journal entry roots must not overlap/i },
  );
});

test('global preparation rejects canonical equality and nesting through a linked ancestor', async (t) => {
  const { root, worktree } = await roots(t);
  if (!await requireDirectoryLinkSupport(t, root)) return;
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const projectDirectory = join(worktree, '.opencode-loop', 'journal', 'entries');
  await mkdir(join(projectDirectory, 'promoted'), { recursive: true });
  const scenarios = [
    ['equal roots', join(worktree, '.opencode-loop', 'journal'), 'entries'],
    ['global root is an ancestor', join(worktree, '.opencode-loop'), 'journal'],
    ['global root is a descendant', projectDirectory, 'promoted'],
  ];

  for (const [label, linkedTarget, suffix] of scenarios) {
    await t.test(label, async () => {
      const caseRoot = join(root, label.replaceAll(' ', '-'));
      const linkedAncestor = join(caseRoot, 'global-parent-link');
      await mkdir(caseRoot);
      await symlink(linkedTarget, linkedAncestor, linkType);
      const globalDirectory = join(linkedAncestor, suffix);
      const store = createJournalStore({ worktree, globalDirectory });
      const expected = entry({ scope: 'global', title: `Rejected ${label}` });

      await assert.rejects(() => store.write('global', expected), (error) => {
        assert.equal(error?.code, 'GLOBAL_JOURNAL_UNSAFE_PATH');
        assert.match(error?.message ?? '', /overlap/i);
        return true;
      });
      await assert.rejects(lstat(join(globalDirectory, `${expected.id}.md`)), { code: 'ENOENT' });
    });
  }
});

test('global preparation rejects project-controlled links that alias the global entry root', async (t) => {
  const { root } = await roots(t);
  if (!await requireDirectoryLinkSupport(t, root)) return;
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const globalState = join(root, 'global-state');
  const globalJournal = join(globalState, 'journal');
  const globalDirectory = join(globalJournal, 'entries');
  await mkdir(globalDirectory, { recursive: true });
  const scenarios = [
    {
      label: 'state directory',
      arrange: async (worktree) => {
        await symlink(globalState, join(worktree, '.opencode-loop'), linkType);
      },
    },
    {
      label: 'journal directory',
      arrange: async (worktree) => {
        await mkdir(join(worktree, '.opencode-loop'));
        await symlink(globalJournal, join(worktree, '.opencode-loop', 'journal'), linkType);
      },
    },
    {
      label: 'entries directory',
      arrange: async (worktree) => {
        await mkdir(join(worktree, '.opencode-loop', 'journal'), { recursive: true });
        await symlink(globalDirectory, join(worktree, '.opencode-loop', 'journal', 'entries'), linkType);
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.label, async () => {
      const worktree = join(root, `project-${scenario.label.replaceAll(' ', '-')}`);
      await mkdir(worktree);
      await scenario.arrange(worktree);
      const store = createJournalStore({ worktree, globalDirectory });
      const expected = entry({ scope: 'global', title: `Rejected project ${scenario.label} alias` });

      await assert.rejects(() => store.write('global', expected), (error) => {
        assert.equal(error?.code, 'GLOBAL_JOURNAL_UNSAFE_PATH');
        assert.match(error?.message ?? '', /symbolic link|junction/i);
        return true;
      });
      await assert.rejects(lstat(join(globalDirectory, `${expected.id}.md`)), { code: 'ENOENT' });
    });
  }
});

test('project preparation rejects an existing global root canonically aliased into it', async (t) => {
  const { root, worktree } = await roots(t);
  if (!await requireDirectoryLinkSupport(t, root)) return;
  const projectDirectory = join(worktree, '.opencode-loop', 'journal', 'entries');
  const linkedAncestor = join(root, 'existing-global-parent-link');
  await mkdir(projectDirectory, { recursive: true });
  await symlink(
    join(worktree, '.opencode-loop', 'journal'),
    linkedAncestor,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const globalDirectory = join(linkedAncestor, 'entries');
  const store = createJournalStore({ worktree, globalDirectory });
  const expected = entry({ title: 'Rejected reciprocal overlap' });

  await assert.rejects(() => store.write('project', expected), (error) => {
    assert.equal(error?.code, 'PROJECT_JOURNAL_UNSAFE_PATH');
    assert.match(error?.message ?? '', /overlap/i);
    return true;
  });
  await assert.rejects(lstat(join(projectDirectory, `${expected.id}.md`)), { code: 'ENOENT' });
});

test('journal store permits ordinary disjoint temp and home entry roots', async (t) => {
  const { worktree, globalDirectory } = await roots(t);

  assert.doesNotThrow(() => createJournalStore({ worktree, globalDirectory }));
  assert.doesNotThrow(() => createJournalStore({ worktree }));
});

test('journal writes are idempotent and reject different content for an existing ID', async (t) => {
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const expected = entry();

  assert.equal((await store.write('project', expected)).created, true);
  assert.equal((await store.write('project', structuredClone(expected))).created, false);
  await assert.rejects(
    () => store.write('project', { ...expected, body: 'Conflicting content.' }),
    /already exists with different content/i,
  );
  assert.deepEqual(await store.read('project', expected.id), expected);
});

test('high-concurrency identical same-ID writes across store instances create exactly one entry', async (t) => {
  const { worktree, globalDirectory } = await roots(t);
  const stores = Array.from({ length: 8 }, () => createJournalStore({ worktree, globalDirectory }));
  const expected = entry({ title: 'Concurrent entry' });

  const results = await Promise.all(Array.from(
    { length: 128 },
    (_, index) => stores[index % stores.length].write('project', structuredClone(expected)),
  ));
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.ok(results.every((result) => result.created || result.created === false));
  assert.deepEqual(await stores[0].list('project'), [expected]);
});

test('high-concurrency different-body same-ID writes publish at most once and never change the winner', async (t) => {
  const { worktree, globalDirectory } = await roots(t);
  const stores = Array.from({ length: 8 }, () => createJournalStore({ worktree, globalDirectory }));
  const id = stableJournalId('mixed concurrent entry');
  const candidates = [
    entry({ id, title: 'Mixed concurrent entry', body: 'Candidate body alpha.' }),
    entry({ id, title: 'Mixed concurrent entry', body: 'Candidate body bravo.' }),
  ];
  const inputs = Array.from({ length: 128 }, (_, index) => structuredClone(candidates[index % candidates.length]));

  const results = await Promise.allSettled(inputs.map(
    (input, index) => stores[index % stores.length].write('project', input),
  ));
  const finalEntry = await stores[0].read('project', id);
  const created = results.filter((result) => result.status === 'fulfilled' && result.value.created);
  assert.ok(created.length <= 1, `observed ${created.length} created results`);
  assert.equal(created.length, 1);
  assert.ok(candidates.some((candidate) => candidate.body === finalEntry.body));

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === 'fulfilled') {
      assert.equal(inputs[index].body, finalEntry.body);
      assert.equal(result.value.entry.body, finalEntry.body);
      assert.equal(typeof result.value.created, 'boolean');
    } else {
      assert.notEqual(inputs[index].body, finalEntry.body);
      assert.match(result.reason?.message ?? '', /already exists with different content/i);
    }
  }

  const target = join(worktree, '.opencode-loop', 'journal', 'entries', `${id}.md`);
  const winningContent = await readFile(target, 'utf8');
  const replay = await Promise.allSettled(inputs.map(
    (input, index) => stores[index % stores.length].write('project', structuredClone(input)),
  ));
  assert.equal(replay.some((result) => result.status === 'fulfilled' && result.value.created), false);
  assert.equal(await readFile(target, 'utf8'), winningContent);
  assert.deepEqual(await stores[0].read('project', id), finalEntry);
});

test('corrupt entries are skipped and counted while direct reads fail', async (t) => {
  const { root, worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const valid = entry();
  await store.write('project', valid);
  const corruptId = stableJournalId('corrupt');
  const entriesDirectory = join(worktree, '.opencode-loop', 'journal', 'entries');
  await writeFile(join(entriesDirectory, `${corruptId}.md`), '---\nnot-json\n---\nunsafe body', { mode: 0o600 });

  assert.deepEqual(await store.list('project'), [valid]);
  await assert.rejects(() => store.read('project', corruptId));
  const status = await store.status();
  assert.deepEqual(status.project, { available: true, entries: 1, corrupt: 1 });
  assert.deepEqual(status.global, { available: true, entries: 0, corrupt: 0 });
  assert.equal(status.corruptionCount, 1);
  assert.equal(JSON.stringify(status).includes(root), false);
});

test('journal operations reject traversal and invalid entry data', async (t) => {
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const valid = entry();

  for (const id of [`../${valid.id}`, `${valid.id}/../other`, valid.id.toUpperCase(), 'entry.md']) {
    await assert.rejects(() => store.read('project', id), TypeError);
    await assert.rejects(() => store.exists('project', id), TypeError);
  }
  await assert.rejects(() => store.write('project', { ...valid, id: `../${valid.id}` }), TypeError);
  await assert.rejects(() => store.write('project', { ...valid, title: '' }), TypeError);
  await assert.rejects(() => store.write('project', { ...valid, tags: ['valid', ''] }), TypeError);
  await assert.rejects(() => store.write('project', { ...valid, metadata: new Date() }), TypeError);
  await assert.rejects(() => store.write('elsewhere', valid), TypeError);
});

test('journal store rejects backslashes and empty or dot slash segments', () => {
  const invalid = [
    'state\\nested',
    '.',
    '..',
    'state/',
    'state//nested',
    'state/./nested',
    'state/../nested',
  ];

  for (const stateDirectory of invalid) {
    assert.throws(
      () => createJournalStore({ worktree: 'project', stateDirectory }),
      TypeError,
      stateDirectory,
    );
  }
});

test('POSIX journal store rejects a literal-backslash state directory symlink', { skip: process.platform === 'win32' }, async (t) => {
  const { root, worktree, globalDirectory } = await roots(t);
  if (!await requireDirectoryLinkSupport(t, root)) return;
  const outside = join(root, 'outside');
  const stateDirectory = 'state\\redirect';
  await mkdir(outside);
  await symlink(outside, join(worktree, stateDirectory), 'dir');

  assert.throws(
    () => createJournalStore({ worktree, stateDirectory, globalDirectory }),
    TypeError,
  );
  await assert.rejects(
    readFile(join(outside, 'journal', 'entries', `${entry().id}.md`)),
    { code: 'ENOENT' },
  );
});

test('project journal rejects linked controlled directories before reads or writes escape', async (t) => {
  const { root, globalDirectory } = await roots(t);
  if (!await requireDirectoryLinkSupport(t, root)) return;
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const expected = entry();
  const scenarios = [
    {
      label: 'worktree',
      arrange: async (caseRoot, outside) => {
        const worktree = join(caseRoot, 'project-link');
        await symlink(outside, worktree, linkType);
        return { worktree, stateDirectory: '.opencode-loop', escaped: join(outside, '.opencode-loop', 'journal', 'entries', `${expected.id}.md`) };
      },
    },
    {
      label: 'stateDirectory segment',
      arrange: async (caseRoot, outside) => {
        const worktree = join(caseRoot, 'project');
        await mkdir(worktree);
        await symlink(outside, join(worktree, 'state'), linkType);
        return { worktree, stateDirectory: 'state/nested', escaped: join(outside, 'nested', 'journal', 'entries', `${expected.id}.md`) };
      },
    },
    {
      label: 'journal',
      arrange: async (caseRoot, outside) => {
        const worktree = join(caseRoot, 'project');
        await mkdir(join(worktree, '.opencode-loop'), { recursive: true });
        await symlink(outside, join(worktree, '.opencode-loop', 'journal'), linkType);
        return { worktree, stateDirectory: '.opencode-loop', escaped: join(outside, 'entries', `${expected.id}.md`) };
      },
    },
    {
      label: 'entries',
      arrange: async (caseRoot, outside) => {
        const worktree = join(caseRoot, 'project');
        await mkdir(join(worktree, '.opencode-loop', 'journal'), { recursive: true });
        await symlink(outside, join(worktree, '.opencode-loop', 'journal', 'entries'), linkType);
        return { worktree, stateDirectory: '.opencode-loop', escaped: join(outside, `${expected.id}.md`) };
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.label, async () => {
      const caseRoot = join(root, scenario.label.replaceAll(/[^A-Za-z]/g, '-'));
      const outside = join(caseRoot, 'outside');
      await mkdir(outside, { recursive: true });
      const { worktree, stateDirectory, escaped } = await scenario.arrange(caseRoot, outside);
      const store = createJournalStore({ worktree, stateDirectory, globalDirectory });
      const rejected = async (operation) => {
        try {
          await operation();
          return null;
        } catch (error) {
          return error;
        }
      };

      const errors = [
        await rejected(() => store.write('project', expected)),
        await rejected(() => store.read('project', expected.id)),
        await rejected(() => store.list('project')),
        await rejected(() => store.exists('project', expected.id)),
      ];
      const escapedExists = await readFile(escaped).then(() => true, (error) => {
        if (error?.code === 'ENOENT') return false;
        throw error;
      });

      assert.equal(escapedExists, false, `project write escaped through linked ${scenario.label}`);
      for (const error of errors) assert.equal(error?.code, 'PROJECT_JOURNAL_UNSAFE_PATH');
    });
  }
});

test('journal write revalidates controlled project roots immediately before hard-link publication', async (t) => {
  const { root, worktree, globalDirectory } = await roots(t);
  if (!await requireDirectoryLinkSupport(t, root)) return;
  await mkdir(globalDirectory, { recursive: true });
  const store = createJournalStore({ worktree, globalDirectory });
  const expected = entry({ title: 'Revalidate before publication' });
  const entriesDirectory = join(worktree, '.opencode-loop', 'journal', 'entries');
  let replaced = false;

  await withPatchedFs('open', (originalOpen) => async (path, ...args) => {
    if (!replaced && String(path).includes(`${expected.id}.md.tmp-`)) {
      replaced = true;
      await rm(entriesDirectory, { recursive: true, force: true });
      await symlink(globalDirectory, entriesDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return originalOpen(path, ...args);
  }, async () => {
    await assert.rejects(() => store.write('project', expected), (error) => {
      assert.equal(error?.code, 'PROJECT_JOURNAL_UNSAFE_PATH');
      return true;
    });
  });

  assert.equal(replaced, true);
  await assert.rejects(lstat(join(globalDirectory, `${expected.id}.md`)), { code: 'ENOENT' });
  const foreignFiles = await readdir(globalDirectory);
  assert.equal(foreignFiles.length, 1);
  assert.match(foreignFiles[0], new RegExp(`^${expected.id}\\.md\\.tmp-`));
  assert.equal(await readFile(join(globalDirectory, foreignFiles[0]), 'utf8'), '');
});

test('journal write rejects a replaced temporary path before writing entry content', async (t) => {
  const { root, worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const expected = entry({ title: 'Reject replaced temporary path', body: 'Sensitive journal body.' });
  const replacement = join(root, 'replacement-temporary');
  await writeFile(replacement, 'replacement file is not empty', { mode: 0o600 });
  let temporary;
  let identityChecked = false;
  let writeAttempted = false;

  await withPatchedFs('open', (originalOpen) => async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (!String(path).includes(`${expected.id}.md.tmp-`)) return handle;
    temporary = String(path);
    return {
      stat: handle.stat.bind(handle),
      writeFile: async (...writeArgs) => {
        writeAttempted = true;
        return handle.writeFile(...writeArgs);
      },
      close: handle.close.bind(handle),
    };
  }, async () => {
    await withPatchedFs('lstat', (originalLstat) => async (path, ...args) => {
      if (temporary !== undefined && String(path) === temporary) {
        identityChecked = true;
        return originalLstat(replacement, ...args);
      }
      return originalLstat(path, ...args);
    }, async () => {
      await assert.rejects(() => store.write('project', expected), (error) => {
        assert.equal(error?.code, 'PROJECT_JOURNAL_UNSAFE_PATH');
        assert.match(error?.message ?? '', /temporary|changed|identity/i);
        return true;
      });
    });
  });

  assert.notEqual(temporary, undefined);
  assert.equal(identityChecked, true);
  assert.equal(writeAttempted, false);
  await assert.rejects(lstat(join(worktree, '.opencode-loop', 'journal', 'entries', `${expected.id}.md`)), { code: 'ENOENT' });
});

test('journal read revalidates controlled project roots immediately before file reads', async (t) => {
  const { root, worktree, globalDirectory } = await roots(t);
  if (!await requireDirectoryLinkSupport(t, root)) return;
  const attackerWorktree = join(root, 'attacker-project');
  await mkdir(attackerWorktree);
  const expected = entry({ title: 'Revalidate before read' });
  const attacker = { ...expected, body: 'Attacker-controlled body.' };
  const store = createJournalStore({ worktree, globalDirectory });
  const attackerStore = createJournalStore({ worktree: attackerWorktree, globalDirectory });
  await store.write('project', expected);
  await attackerStore.write('project', attacker);
  const entriesDirectory = join(worktree, '.opencode-loop', 'journal', 'entries');
  const attackerEntries = join(attackerWorktree, '.opencode-loop', 'journal', 'entries');
  const target = join(entriesDirectory, `${expected.id}.md`);
  const displaced = join(worktree, '.opencode-loop', 'journal', 'displaced-entries');
  let replaced = false;

  await withPatchedFs('lstat', (originalLstat) => async (path, ...args) => {
    const info = await originalLstat(path, ...args);
    if (!replaced && String(path) === target) {
      replaced = true;
      await rename(entriesDirectory, displaced);
      await symlink(attackerEntries, entriesDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return info;
  }, async () => {
    await assert.rejects(() => store.read('project', expected.id), (error) => {
      assert.equal(error?.code, 'PROJECT_JOURNAL_UNSAFE_PATH');
      return true;
    });
  });

  assert.equal(replaced, true);
});

test('journal read rejects a different file opened after its initial lstat', async (t) => {
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const expected = entry({ title: 'Validate opened file identity' });
  const replacement = { ...expected, body: 'Replacement with a different size.' };
  await store.write('project', expected);
  const entriesDirectory = join(worktree, '.opencode-loop', 'journal', 'entries');
  const target = join(entriesDirectory, `${expected.id}.md`);
  const replacementPath = join(entriesDirectory, 'replacement-read.md');
  await writeFile(replacementPath, serializedEntry(replacement), { mode: 0o600 });
  let redirected = false;

  await withPatchedFs('open', (originalOpen) => async (path, ...args) => {
    if (!redirected && String(path) === target) {
      redirected = true;
      return originalOpen(replacementPath, ...args);
    }
    return originalOpen(path, ...args);
  }, async () => {
    await assert.rejects(() => store.read('project', expected.id), (error) => {
      assert.equal(error?.code, 'PROJECT_JOURNAL_UNSAFE_PATH');
      assert.match(error?.message ?? '', /changed|identity|opened/i);
      return true;
    });
  });

  assert.equal(redirected, true);
});

test('journal read uses its retained handle after pathname resolution changes', async (t) => {
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const expected = entry({ title: 'Retain validated read handle' });
  const replacement = { ...expected, body: 'Pathname replacement body.' };
  await store.write('project', expected);
  const entriesDirectory = join(worktree, '.opencode-loop', 'journal', 'entries');
  const target = join(entriesDirectory, `${expected.id}.md`);
  const replacementPath = join(entriesDirectory, 'replacement-after-open.md');
  await writeFile(replacementPath, serializedEntry(replacement), { mode: 0o600 });
  let opened = false;
  let pathnameRead = false;

  await withPatchedFs('open', (originalOpen) => async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (String(path) === target) opened = true;
    return handle;
  }, async () => {
    await withPatchedFs('readFile', (originalReadFile) => async (path, ...args) => {
      if (opened && String(path) === target) {
        pathnameRead = true;
        return originalReadFile(replacementPath, ...args);
      }
      return originalReadFile(path, ...args);
    }, async () => {
      assert.deepEqual(await store.read('project', expected.id), expected);
    });
  });

  assert.equal(opened, true);
  assert.equal(pathnameRead, false);
});

test('idempotent journal write rejects a different target opened after lstat', async (t) => {
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const expected = entry({ title: 'Validate existing target identity' });
  const replacement = { ...expected, body: 'Replacement collision body with a different size.' };
  await store.write('project', expected);
  const entriesDirectory = join(worktree, '.opencode-loop', 'journal', 'entries');
  const target = join(entriesDirectory, `${expected.id}.md`);
  const replacementPath = join(entriesDirectory, 'replacement-collision.md');
  await writeFile(replacementPath, serializedEntry(replacement), { mode: 0o600 });
  let redirected = false;

  await withPatchedFs('open', (originalOpen) => async (path, ...args) => {
    if (!redirected && String(path) === target) {
      redirected = true;
      return originalOpen(replacementPath, ...args);
    }
    return originalOpen(path, ...args);
  }, async () => {
    await assert.rejects(() => store.write('project', structuredClone(expected)), (error) => {
      assert.equal(error?.code, 'PROJECT_JOURNAL_UNSAFE_PATH');
      assert.match(error?.message ?? '', /changed|identity|opened/i);
      return true;
    });
  });

  assert.equal(redirected, true);
  assert.deepEqual(await store.read('project', expected.id), expected);
});

test('journal read verifies canonical containment after reading through a retained handle', async (t) => {
  const { root } = await roots(t);
  if (!await requireDirectoryLinkSupport(t, root)) return;
  const firstParent = join(root, 'first-global-parent');
  const secondParent = join(root, 'second-global-parent');
  const firstDirectory = join(firstParent, 'entries');
  const secondDirectory = join(secondParent, 'entries');
  await mkdir(firstDirectory, { recursive: true });
  await mkdir(secondDirectory, { recursive: true });
  const expected = entry({ scope: 'global', title: 'Verify after read' });
  const attacker = { ...expected, body: 'Replacement global body.' };
  await createJournalStore({ globalDirectory: firstDirectory }).write('global', expected);
  await createJournalStore({ globalDirectory: secondDirectory }).write('global', attacker);
  const linkedParent = join(root, 'linked-global-parent');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(firstParent, linkedParent, linkType);
  const globalDirectory = join(linkedParent, 'entries');
  const target = join(globalDirectory, `${expected.id}.md`);
  const store = createJournalStore({ globalDirectory });
  let replaced = false;

  await withPatchedFs('open', (originalOpen) => async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (String(path) !== target) return handle;
    return {
      stat: handle.stat.bind(handle),
      read: async (...readArgs) => {
        const result = await handle.read(...readArgs);
        if (!replaced) {
          replaced = true;
          await unlink(linkedParent);
          await symlink(secondParent, linkedParent, linkType);
        }
        return result;
      },
      close: handle.close.bind(handle),
    };
  }, async () => {
    await assert.rejects(() => store.read('global', expected.id), (error) => {
      assert.equal(error?.code, 'GLOBAL_JOURNAL_UNSAFE_PATH');
      return true;
    });
  });

  assert.equal(replaced, true);
});

test('journal write verifies canonical containment after hard-link publication', async (t) => {
  const { root } = await roots(t);
  if (!await requireDirectoryLinkSupport(t, root)) return;
  const firstParent = join(root, 'publication-parent');
  const secondParent = join(root, 'replacement-parent');
  await mkdir(join(firstParent, 'entries'), { recursive: true });
  await mkdir(join(secondParent, 'entries'), { recursive: true });
  const linkedParent = join(root, 'linked-publication-parent');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(firstParent, linkedParent, linkType);
  const globalDirectory = join(linkedParent, 'entries');
  const expected = entry({ scope: 'global', title: 'Verify after publication' });
  const store = createJournalStore({ globalDirectory });
  let replaced = false;

  await withPatchedFs('link', (originalLink) => async (...args) => {
    const result = await originalLink(...args);
    if (!replaced) {
      replaced = true;
      await unlink(linkedParent);
      await symlink(secondParent, linkedParent, linkType);
    }
    return result;
  }, async () => {
    await assert.rejects(() => store.write('global', expected), (error) => {
      assert.equal(error?.code, 'GLOBAL_JOURNAL_UNSAFE_PATH');
      return true;
    });
  });

  assert.equal(replaced, true);
});

test('global journal rejects a configured entry root that is not a directory', async (t) => {
  const { globalDirectory } = await roots(t);
  await writeFile(globalDirectory, 'not a directory');
  const store = createJournalStore({ globalDirectory });

  await assertUnsafeGlobalDirectory(store, entry({ scope: 'global' }));
  assert.equal(await readFile(globalDirectory, 'utf8'), 'not a directory');
});

test('global journal rejects a configured entry root symlink or junction without changing its target', async (t) => {
  const { root, globalDirectory } = await roots(t);
  if (!await requireDirectoryLinkSupport(t, root)) return;
  const target = join(root, 'global-target');
  await mkdir(target);
  const seedStore = createJournalStore({ globalDirectory: target });
  const seeded = entry({ scope: 'global', title: 'Existing target entry' });
  const candidate = entry({ scope: 'global', title: 'Must not escape through link' });
  await seedStore.write('global', seeded);
  await symlink(target, globalDirectory, process.platform === 'win32' ? 'junction' : 'dir');

  await assertUnsafeGlobalDirectory(createJournalStore({ globalDirectory }), candidate);
  assert.deepEqual(await seedStore.read('global', seeded.id), seeded);
  await assert.rejects(lstat(join(target, `${candidate.id}.md`)), { code: 'ENOENT' });
});

test('global journal permits a real configured entry root beneath a linked ancestor', async (t) => {
  const { root, worktree } = await roots(t);
  if (!await requireDirectoryLinkSupport(t, root)) return;
  const targetAncestor = join(root, 'global-parent');
  const linkedAncestor = join(root, 'global-parent-link');
  await mkdir(targetAncestor);
  await symlink(targetAncestor, linkedAncestor, process.platform === 'win32' ? 'junction' : 'dir');
  const globalDirectory = join(linkedAncestor, 'entries');
  const store = createJournalStore({ worktree, globalDirectory });
  const expected = entry({ scope: 'global', title: 'Linked ancestor remains valid' });

  assert.equal((await store.write('global', expected)).created, true);
  assert.deepEqual(await store.read('global', expected.id), expected);
  assert.deepEqual(await store.list('global'), [expected]);
  assert.deepEqual((await store.status()).global, { available: true, entries: 1, corrupt: 0 });
  await assert.rejects(lstat(join(worktree, '.opencode-loop')), { code: 'ENOENT' });
  const info = await lstat(globalDirectory);
  assert.equal(info.isDirectory(), true);
  assert.equal(info.isSymbolicLink(), false);
});

test('global journal remains usable without a worktree and project operations fail clearly', async (t) => {
  const { globalDirectory } = await roots(t);
  const store = createJournalStore({ globalDirectory });
  const globalEntry = entry({ scope: 'global', kind: 'promoted-insight' });
  const projectId = stableJournalId('project-entry');

  assert.equal((await store.write('global', globalEntry)).created, true);
  assert.deepEqual(await store.list('global'), [globalEntry]);
  await assert.rejects(() => store.list('project'), /worktree/i);
  await assert.rejects(() => store.read('project', projectId), /worktree/i);
  await assert.rejects(() => store.exists('project', projectId), /worktree/i);
  await assert.rejects(() => store.write('project', entry({ id: projectId })), /worktree/i);
  const status = await store.status();
  assert.deepEqual(status.project, { available: false, entries: 0, corrupt: 0 });
  assert.deepEqual(status.global, { available: true, entries: 1, corrupt: 0 });
});
