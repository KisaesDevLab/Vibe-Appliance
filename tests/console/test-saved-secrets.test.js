// tests/console/test-saved-secrets.test.js
//
// The Settings page never sends a stored secret back to the browser: a
// saved key renders as an EMPTY password box ("Currently set. Type to
// replace; leave blank to keep."). The Test button posts the form as it
// stands, so after a key was saved its field reached the test endpoint
// blank and the endpoint answered "<KEY> required" — for a key that was
// saved and valid. withSavedSecrets() fills a blank secret from
// appliance.env; a value typed into the form still wins.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', '..', 'console', 'server.js'), 'utf8');

function loadHelper(savedEnv, registry) {
  const start = SERVER.indexOf('const DESTINATION_KEY_RE');
  const fn = SERVER.indexOf('function withSavedSecrets(');
  assert.ok(start !== -1 && fn > start, 'withSavedSecrets not found in console/server.js');
  const body = SERVER.slice(start, SERVER.indexOf('\n}', fn) + 2);
  // eslint-disable-next-line no-new-func
  return new Function('parseEnvFile', 'path', 'ENV_DIR', 'SETTINGS_REGISTRY',
    `${body}; return withSavedSecrets;`)(
    () => savedEnv, path, '/opt/vibe/env', { allKeys: new Map(Object.entries(registry)) });
}

const REGISTRY = {
  SMTP_HOST:       { secret: false },
  SMTP_PASSWORD:   { secret: true },
  LLM_ENDPOINT:    { secret: false },
  LLM_API_KEY:     { secret: true },
  EMAIL_PROVIDER:  { secret: false },
  EMAIL_FROM:      { secret: false },
  EMAILIT_API_KEY: { secret: true },
  RESEND_API_KEY:  { secret: true },
  'vibe-recap::SOME_SECRET': { secret: true },
};

test('a saved secret left blank in the form is filled from appliance.env', () => {
  const fill = loadHelper({ EMAILIT_API_KEY: 'em_saved', EMAIL_FROM: 'saved@firm.com' }, REGISTRY);
  const b = fill({ EMAIL_PROVIDER: 'emailit', EMAIL_FROM: 'noreply@firm.com', EMAILIT_API_KEY: '' });
  assert.equal(b.EMAILIT_API_KEY, 'em_saved');
  assert.equal(b.EMAIL_FROM, 'noreply@firm.com', 'non-secret form values are never replaced');
});

test('a value typed into the form wins over the saved one', () => {
  const fill = loadHelper({ EMAILIT_API_KEY: 'em_saved' }, REGISTRY);
  assert.equal(fill({ EMAILIT_API_KEY: 'em_typed' }).EMAILIT_API_KEY, 'em_typed');
});

test('nothing saved and nothing typed stays blank, so the endpoint still reports it missing', () => {
  const fill = loadHelper({}, REGISTRY);
  assert.equal(fill({ EMAIL_PROVIDER: 'emailit', EMAILIT_API_KEY: '' }).EMAILIT_API_KEY, '');
});

test('only appliance-scope secrets are filled', () => {
  const fill = loadHelper({ 'vibe-recap::SOME_SECRET': 'x', EMAIL_FROM: 'saved@firm.com' }, REGISTRY);
  const b = fill({});
  assert.equal(b['vibe-recap::SOME_SECRET'], undefined);
  assert.equal(b.EMAIL_FROM, undefined, 'a non-secret key is not filled in');
});

test('a saved secret is never sent to a destination the request chose', () => {
  // Several tests take their destination from the form. Filling in the
  // stored key for a request that points somewhere else would hand that
  // key to any host the caller names.
  const saved = { LLM_ENDPOINT: 'https://llm.internal.example', LLM_API_KEY: 'sk-saved',
                  SMTP_HOST: 'smtp.firm.com', SMTP_PASSWORD: 'smtp-saved' };
  const fill = loadHelper(saved, REGISTRY);

  assert.equal(fill({ LLM_ENDPOINT: 'https://attacker.example', LLM_API_KEY: '' }).LLM_API_KEY, '',
    'a different endpoint gets no saved key');
  assert.equal(fill({ SMTP_HOST: 'evil.example', SMTP_PASSWORD: '' }).SMTP_PASSWORD, '');

  // The saved destination (as the Test button on an unedited form sends
  // it) still gets the saved key.
  assert.equal(fill({ LLM_ENDPOINT: 'https://llm.internal.example', LLM_API_KEY: '' }).LLM_API_KEY, 'sk-saved');
  assert.equal(fill({ SMTP_HOST: ' smtp.firm.com ', SMTP_PASSWORD: '' }).SMTP_PASSWORD, 'smtp-saved');
});

test('every form-driven test endpoint reads its body through withSavedSecrets', () => {
  for (const name of ['email', 'sms', 'backup', 'dns', 'ddns', 'llm']) {
    const at = SERVER.indexOf(`app.post('/api/v1/admin/test/${name}'`);
    assert.ok(at !== -1, `test/${name} route not found`);
    assert.match(SERVER.slice(at, at + 400), /const b = withSavedSecrets\(req\.body\);/,
      `test/${name} must fall back to saved secrets`);
  }
});
