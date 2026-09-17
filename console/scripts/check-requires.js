#!/usr/bin/env node
// console/scripts/check-requires.js — build-time guard against the
// MODULE_NOT_FOUND crash-loop.
//
// Walks every server-side .js file in the console (top level + lib/ +
// scripts/), finds each relative require (specifier starting with ./ or
// ../) and resolves it from that file's directory with require.resolve().
// Nothing is executed, no port is bound, no sqlite is opened — this is
// resolution only, so it runs safely inside `docker build`.
//
// Also asserts the directories server.js scans at startup exist and are
// non-empty (manifests/, guides/, ui/), because a missing one degrades
// the admin panel silently rather than crashing.
//
// Exit 1 with a per-file list on any miss. Run by console/Dockerfile
// after the COPY and by the CI console job before the image build.
//
// Why this exists: commit ed117ab added identity.js and wired it into
// server.js but not into the Dockerfile's explicit COPY list. The image
// built fine and the container crash-looped at startup, which aborted
// bootstrap. A prose warning in the Dockerfile did not prevent that;
// this check does.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['.', 'lib', 'scripts'];
const REQUIRED_DIRS = ['manifests', 'guides', 'ui'];
const REQUIRE_RE = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;

const problems = [];

function jsFilesIn(rel) {
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(dir, f));
}

for (const rel of SCAN_DIRS) {
  for (const file of jsFilesIn(rel)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(REQUIRE_RE)) {
      const spec = m[1];
      try {
        require.resolve(spec, { paths: [path.dirname(file)] });
      } catch {
        problems.push(`${path.relative(ROOT, file)}: require('${spec}') does not resolve`);
      }
    }
  }
}

for (const rel of REQUIRED_DIRS) {
  const dir = path.join(ROOT, rel);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { /* missing */ }
  if (entries.length === 0) {
    problems.push(`${rel}/ is missing or empty (server.js scans it at startup)`);
  }
}

if (problems.length) {
  console.error('check-requires: the console would not start from this tree:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('fix: make sure the file is present in console/ and not excluded by console/.dockerignore');
  process.exit(1);
}
console.log(`check-requires: ok (${SCAN_DIRS.join(', ')} scanned; ${REQUIRED_DIRS.join(', ')} present)`);
