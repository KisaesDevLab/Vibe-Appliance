// tests/console/admin-actions.test.js — console/lib/admin-actions.js and
// every manifest's adminActions.
//
// These buttons run commands inside an app's container from the browser
// (rule 4 click-to-execute). What must hold:
//   * the command is the manifest's argv; a value is substituted only for
//     a whole "{name}" element, as ONE argv element, never spliced into a
//     longer string;
//   * every value is required, validated, and cannot be read as an option
//     ("-..."), carry a line break, or be an undeclared parameter;
//   * each shipped declaration is internally consistent.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const A = require('../../console/lib/admin-actions');

const MANIFESTS_DIR = path.join(__dirname, '..', '..', 'console', 'manifests');

const RESET = {
  id: 'reset-staff', label: 'Reset', service: 'vibe-files-portal',
  command: ['node_modules/.bin/tsx', 'src/scripts/staff-setup.ts', 'reset', '{email}'],
  params: [{ name: 'email', label: "Staff member's email", validate: 'email' }],
  output: 'secret',
};

test('a valid value becomes exactly one argv element', () => {
  const v = A.validateParams(RESET, { email: '  pat@firm.example ' });
  assert.equal(v.ok, true);
  assert.deepEqual(A.dockerArgv(RESET, v.values), [
    'exec', 'vibe-files-portal', 'node_modules/.bin/tsx', 'src/scripts/staff-setup.ts', 'reset', 'pat@firm.example',
  ]);
});

test('shell syntax in a value stays inert data (there is no shell, and it is one argv element)', () => {
  const action = { ...RESET, params: [{ name: 'email', label: 'x', validate: 'regex:^.+$' }] };
  const v = A.validateParams(action, { email: 'a; rm -rf / $(id) `id` && x' });
  assert.equal(v.ok, true);
  const argv = A.dockerArgv(action, v.values);
  assert.equal(argv.length, 6);
  assert.equal(argv[5], 'a; rm -rf / $(id) `id` && x');
});

test('a value that could be read as an option is refused', () => {
  const v = A.validateParams({ ...RESET, params: [{ name: 'email', label: 'Email', validate: 'regex:^.+$' }] },
    { email: '--admin' });
  assert.equal(v.ok, false);
  assert.match(v.problems.join(), /may not start with "-"/);
});

test('missing, invalid, multi-line and undeclared values are refused', () => {
  assert.equal(A.validateParams(RESET, {}).ok, false);
  assert.equal(A.validateParams(RESET, { email: 'not-an-email' }).ok, false);
  assert.equal(A.validateParams(RESET, { email: 'a@b.example\nreset' }).ok, false);
  const extra = A.validateParams(RESET, { email: 'a@b.example', admin: '--admin' });
  assert.equal(extra.ok, false);
  assert.match(extra.problems.join(), /unknown parameter: admin/);
  assert.equal(A.validateParams(RESET, { email: 'x'.repeat(250) + '@b.example' }).ok, false);
  assert.equal(A.validateParams(RESET, null).ok, false);
});

test('an action without parameters takes none', () => {
  const link = { id: 'setup-link', label: 'Link', service: 's', command: ['tsx', 'staff-setup.ts', 'link'] };
  assert.deepEqual(A.validateParams(link, {}), { ok: true, values: {} });
  assert.equal(A.validateParams(link, { x: '1' }).ok, false);
  assert.deepEqual(A.dockerArgv(link, {}), ['exec', 's', 'tsx', 'staff-setup.ts', 'link']);
});

test('only whole "{name}" elements are substituted', () => {
  const bad = { id: 'x', label: 'x', service: 's', command: ['tool', '--to={email}'],
    params: [{ name: 'email', label: 'e' }] };
  const problems = A.declarationProblems(bad);
  assert.ok(problems.some((p) => /not a whole/.test(p)), problems.join());
  assert.ok(problems.some((p) => /never uses it/.test(p)), problems.join());
  assert.ok(A.declarationProblems({ id: 'y', label: 'y', service: 's', command: ['tool', '{nope}'] })
    .some((p) => /not a declared parameter/.test(p)));
  assert.ok(A.declarationProblems({ id: 'z', label: 'z', service: 's', command: ['{prog}'],
    params: [{ name: 'prog', label: 'p' }] }).some((p) => /program itself/.test(p)));
});

test('the browser never receives the command line', () => {
  const pub = A.publicActions({ adminActions: [RESET] });
  assert.equal(pub.length, 1);
  assert.equal(pub[0].command, undefined);
  assert.equal(pub[0].output, 'secret');
});

test('a command the image does not have yet is named in plain words', () => {
  // Vibe Portal :latest before 0.2.0 has tsx but no test-email.ts: Node
  // exits 1 with ERR_MODULE_NOT_FOUND (checked against 783b3fd).
  const node = "node:internal/modules/esm/resolve:272\n    throw new ERR_MODULE_NOT_FOUND(\n" +
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/src/scripts/test-email.ts' imported from /app/";
  const testEmail = { id: 't', command: ['node_modules/.bin/tsx', 'src/scripts/test-email.ts', '{address}'] };
  assert.match(A.missingCommandHint(1, node, testEmail), /does not have this command/);
  assert.match(A.missingCommandHint(127, '', testEmail), /does not have this command/);
  assert.match(A.missingCommandHint(126, '', testEmail), /does not have this command/);
  // The command's own failure is not a missing command...
  assert.equal(A.missingCommandHint(1, 'The SMTP host name was not found. Check its spelling.', testEmail), null);
  assert.equal(A.missingCommandHint(1, 'No staff account with that email.', testEmail), null);
  // ...nor is a module missing INSIDE the script (a dependency, not the command).
  assert.equal(A.missingCommandHint(1, "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'nodemailer'", testEmail), null);
});

test('a secret result is the link alone; other stdout text becomes a note', () => {
  assert.deepEqual(A.splitSecret('https://files.example.test/staff/setup#t=abc\n'),
    { secret: 'https://files.example.test/staff/setup#t=abc', note: '' });
  assert.deepEqual(A.splitSecret('Open this:\nhttps://x.example/s#t=1'),
    { secret: 'https://x.example/s#t=1', note: 'Open this:' });
  // No URL, or several: the whole output is the secret, unchanged.
  assert.deepEqual(A.splitSecret('TOKEN-123'), { secret: 'TOKEN-123', note: '' });
  assert.equal(A.splitSecret('https://a.example https://b.example').secret, 'https://a.example https://b.example');
});

test('timeouts are clamped to 5..300 seconds', () => {
  assert.equal(A.timeoutMs({}), 60000);
  assert.equal(A.timeoutMs({ timeoutSeconds: 1 }), 5000);
  assert.equal(A.timeoutMs({ timeoutSeconds: 999 }), 300000);
});

test('every shipped adminActions declaration is consistent and runs in its own app', () => {
  for (const file of fs.readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) {
    const m = JSON.parse(fs.readFileSync(path.join(MANIFESTS_DIR, file), 'utf8'));
    const ids = new Set();
    for (const a of m.adminActions || []) {
      assert.deepEqual(A.declarationProblems(a), [], `${file}: ${a.id}`);
      assert.ok(!ids.has(a.id), `${file}: duplicate action id ${a.id}`);
      ids.add(a.id);
      // The container must be one of this app's own: its overlay names it.
      const overlay = fs.readFileSync(path.join(__dirname, '..', '..', 'apps', `${m.slug}.yml`), 'utf8');
      assert.match(overlay, new RegExp(`container_name:\\s*${a.service.replace(/[.]/g, '\\.')}\\s*$`, 'm'),
        `${file}: ${a.id} runs in ${a.service}, which apps/${m.slug}.yml does not define`);
    }
  }
});

// The portal itself still makes the person an admin when no other admin has
// a finished account (its lock-out guard, said in the button's help text);
// what the button can never do is pass --admin to make someone an admin
// while other admins exist.
test('Vibe Portal: no button passes --admin (forcing admin stays copy-paste)', () => {
  const m = JSON.parse(fs.readFileSync(path.join(MANIFESTS_DIR, 'vibe-files-portal.json'), 'utf8'));
  for (const a of m.adminActions) assert.ok(!a.command.includes('--admin'), a.id);
  const secret = m.adminActions.filter((a) => a.output === 'secret').map((a) => a.id).sort();
  assert.deepEqual(secret, ['reset-staff', 'setup-link']);
});
