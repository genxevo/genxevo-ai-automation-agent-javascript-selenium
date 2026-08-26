import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';

import { runNpm } from './helpers/npm.js';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_ROOT = path.join(REPOSITORY_ROOT, 'src');
const CORE_ROOT = path.join(SOURCE_ROOT, 'core');
const MCP_ROOT = path.join(SOURCE_ROOT, 'mcp');

function sourceFiles(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Remove comments, leaving string literals intact.
 *
 * WHY THIS EXISTS. The first version of this scan was a bare
 * `/\bfrom\s*['"]([^'"]+)['"]/` over the raw file, and it reported three
 * offenders that do not exist: it matched the prose `tell 'no dependencies'
 * from 'the manifest did not parse'` inside a JSDoc block, and it matched the
 * regex source strings that `discovery/signals.js` builds. A scan that reports
 * imaginary violations is worse than no scan, because the first person to see
 * it fails learns to distrust it. So comments are stripped, and the specifier
 * patterns below are anchored at STATEMENT POSITION rather than floating.
 *
 * This is a character scanner, not a parser: it tracks only the five states a
 * JavaScript file can be in where a `//` or `/*` is not a comment.
 *
 * @param {string} text
 * @returns {string} The same text with comment bodies blanked, line count preserved.
 */
function stripComments(text) {
  let out = '';
  let state = 'code';
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    if (state === 'code') {
      if (character === '/' && next === '/') {
        state = 'line';
        index += 2;
        continue;
      }
      if (character === '/' && next === '*') {
        state = 'block';
        index += 2;
        continue;
      }
      if (character === "'" || character === '"' || character === '`') {
        state = character;
        out += character;
        index += 1;
        continue;
      }
      out += character;
      index += 1;
      continue;
    }
    if (state === 'line') {
      if (character === '\n') {
        state = 'code';
        out += character;
      }
      index += 1;
      continue;
    }
    if (state === 'block') {
      if (character === '*' && next === '/') {
        state = 'code';
        index += 2;
        continue;
      }
      // Newlines are kept so reported line numbers stay true to the file.
      if (character === '\n') out += character;
      index += 1;
      continue;
    }
    // Inside a string or template literal: copy through, honouring escapes.
    out += character;
    if (character === '\\') {
      out += text[index + 1] ?? '';
      index += 2;
      continue;
    }
    if (character === state) state = 'code';
    index += 1;
  }
  return out;
}

/**
 * Static and dynamic import specifiers, read by a source scan rather than a
 * compiler - which is honest about what it is, and the reason it is anchored.
 *
 * @param {string} text
 * @returns {string[]}
 */
function staticImports(text) {
  const code = stripComments(text);
  const specifiers = [];
  const patterns = [
    // `import ... from '...'` / `export ... from '...'`, statement position only.
    /^[ \t]{0,8}(?:import|export)\b[^;'"`]{0,400}\bfrom\s{0,4}['"]([^'"\n]+)['"]/gm,
    // A side-effect-only import: `import '...';`
    /^[ \t]{0,8}import\s{1,4}['"]([^'"\n]+)['"]/gm,
    // `await import('...')` - a dynamic import is still a dependency.
    /\bimport\s{0,4}\(\s{0,4}['"]([^'"\n]+)['"]/g,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(code)) !== null) specifiers.push(match[1]);
  }
  return specifiers;
}

test('the import scanner itself ignores comments and string literals', () => {
  // A test for the test. The scan above only earns trust if its own failure
  // modes - prose in a JSDoc block, a regex built from string fragments - are
  // demonstrated to be handled rather than assumed to be.
  const sample = [
    "import { a } from 'node:fs';",
    "import 'node:path';",
    "// import { evil } from 'malware';",
    "/** tell 'no dependencies' from 'the manifest did not parse' */",
    "const SPECIFIER = 'from ' + \"'\" + 'x';",
    "const later = await import('node:crypto');",
    "export { b } from './local.js';",
  ].join('\n');

  assert.deepEqual(staticImports(sample).sort(), [
    './local.js',
    'node:crypto',
    'node:fs',
    'node:path',
  ]);
});

/**
 * THE DEPENDENCY FIREWALL.
 *
 * In C# the firewall is a project reference; in Maven it would be the compile
 * classpath. NPM HAS NO PER-DIRECTORY DEPENDENCY SCOPING INSIDE ONE PACKAGE, so
 * in JavaScript this test is the ONLY thing enforcing it. Convention alone does
 * not survive contact with a deadline.
 *
 * `builtinModules` is JavaScript's answer to Python's `sys.stdlib_module_names`,
 * which the Java review called "Python-only introspection". It is not.
 */
test('src/core imports ONLY node: builtins and relative paths', () => {
  const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
  const offenders = {};

  for (const file of sourceFiles(CORE_ROOT)) {
    const external = staticImports(fs.readFileSync(file, 'utf8')).filter(
      (specifier) => !specifier.startsWith('.') && !builtins.has(specifier),
    );
    if (external.length > 0) offenders[path.relative(SOURCE_ROOT, file)] = external;
  }

  assert.deepEqual(offenders, {}, `core gained third-party imports: ${JSON.stringify(offenders)}`);
});

test('src/core NEVER imports the MCP SDK, directly or dynamically', () => {
  for (const file of sourceFiles(CORE_ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(
      text.includes('@modelcontextprotocol'),
      false,
      `${path.relative(SOURCE_ROOT, file)} mentions the SDK`,
    );
  }
});

test('the SDK appears ONLY inside src/mcp', () => {
  const users = sourceFiles(SOURCE_ROOT).filter((file) =>
    fs.readFileSync(file, 'utf8').includes('@modelcontextprotocol'),
  );
  assert.ok(users.length > 0, 'the adapter must actually use the SDK');
  for (const file of users) {
    assert.ok(file.startsWith(MCP_ROOT), path.relative(SOURCE_ROOT, file));
  }
});

test('src/core never imports src/mcp - the dependency runs one way only', () => {
  for (const file of sourceFiles(CORE_ROOT)) {
    for (const specifier of staticImports(fs.readFileSync(file, 'utf8'))) {
      assert.equal(specifier.includes('/mcp/'), false, path.relative(SOURCE_ROOT, file));
    }
  }
});

test('the package declares EXACTLY ONE runtime dependency', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies), ['@modelcontextprotocol/sdk']);
  assert.match(
    manifest.dependencies['@modelcontextprotocol/sdk'],
    /^\d+\.\d+\.\d+$/,
    'the SDK version is PINNED EXACTLY: 79 versions have shipped on a roughly monthly cadence, and an unpinned range is an unannounced change to the published contract',
  );
});

test('the TRANSITIVE dependency count is asserted, so a bump is a review event', () => {
  // The SDK brings a full HTTP stack into a server that only ever speaks stdio.
  // That is not a reason to reject it - hand-rolling JSON-RPC is the
  // "confident, plausible, wrong" failure this product exists to prevent - but a
  // future version that doubles the surface must be noticed rather than absorbed.
  const output = runNpm(['ls', '--omit=dev', '--all', '--json'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const seen = new Set();
  const walk = (node) => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      const key = `${name}@${child.version ?? '?'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      walk(child);
    }
  };
  walk(JSON.parse(output));

  assert.ok(seen.size > 0);
  // MEASURED at 34 for the pinned SDK version. The ceiling is deliberately close
  // to the measurement rather than comfortably above it: a ceiling with room for
  // the tree to quadruple is not a ceiling, it is a decoration. Raising this
  // number is a deliberate act that belongs in a pull request with a reason.
  assert.ok(
    seen.size <= 45,
    `the production dependency tree grew to ${seen.size} packages; review what the SDK now pulls in before raising this number`,
  );
});

/**
 * THE STDOUT DISCIPLINE.
 *
 * stdout belongs to the MCP JSON-RPC transport. This is layer two of three: the
 * runtime guard in `main.js` is primary (it is the only layer that can protect
 * against a stray write from inside `node_modules`), and a CI assertion is
 * layer three.
 */
test('exactly ONE line in the whole source tree touches process.stdout', () => {
  const references = [];
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const relative = path.relative(SOURCE_ROOT, file);
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (/(^|[^.\w])process\.stdout\b/.test(line) && !line.trimStart().startsWith('*')) {
          references.push(`${relative}:${index + 1}`);
        }
      });
  }
  assert.equal(
    references.length,
    1,
    `exactly one process.stdout reference is permitted - the guard itself - but found: ${JSON.stringify(references)}`,
  );
  // The FILE is the contract, not the line number: pinning a line makes every
  // comment edit a test failure, which trains people to update the expectation
  // without reading it. That is how a guard quietly moves somewhere useless.
  assert.match(references[0], /^mcp[\\/]main\.js:\d+$/, references[0]);
});

test('no source file calls console.log', () => {
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(
      /\bconsole\.(log|info|debug|table|dir)\s*\(/.test(text),
      false,
      path.relative(SOURCE_ROOT, file),
    );
  }
});

test('no source file contains a raw control character', () => {
  // A file that carries the bytes it exists to refuse is hazardous to edit and
  // easy to corrupt in transit. Tab and newline are the only ones permitted.
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      const permitted = code === 0x09 || code === 0x0a || code === 0x0d;
      assert.ok(
        code >= 0x20 || permitted,
        `${path.relative(SOURCE_ROOT, file)} contains control character 0x${code.toString(16)} at ${index}`,
      );
    }
  }
});

test('the package entry points exist and are what package.json says they are', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.type, 'module');
  assert.match(manifest.engines.node, /^>=22\.13/);

  const binary = path.join(REPOSITORY_ROOT, manifest.bin['genxevo-selenium-agent']);
  assert.ok(fs.existsSync(binary));
  assert.ok(
    fs.readFileSync(binary, 'utf8').startsWith('#!/usr/bin/env node'),
    'a bin entry without a shebang cannot be executed by npx',
  );
  assert.ok(fs.existsSync(path.join(REPOSITORY_ROOT, manifest.exports['.'])));
});

test('the published package ships the product and NOT the tests', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  for (const entry of ['src/', 'docs/', 'README.md', 'LICENSE']) {
    assert.ok(manifest.files.includes(entry), entry);
  }
  for (const entry of ['test/', 'test', '.github/', 'node_modules']) {
    assert.equal(manifest.files.includes(entry), false, entry);
  }
});

test('GenXEvo obeys its own deny-list: only the ROOT .npmrc is tracked', () => {
  // The product's own repository has to obey the reasoning behind its own
  // security control, and the ignore rule is anchored so it does.
  const ignore = fs.readFileSync(path.join(REPOSITORY_ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.npmrc$/m, '.npmrc must be ignored by default');
  assert.match(ignore, /^!\/\.npmrc$/m, 'and the ROOT one re-included by an anchored rule');

  const ours = fs.readFileSync(path.join(REPOSITORY_ROOT, '.npmrc'), 'utf8');
  assert.match(ours, /engine-strict=true/);
  assert.equal(
    /_authToken|_auth\b|_password/.test(ours),
    false,
    'our own .npmrc holds no credential',
  );
});

test('the .gitignore protects the artefacts this product itself produces', () => {
  const ignore = fs.readFileSync(path.join(REPOSITORY_ROOT, '.gitignore'), 'utf8');
  for (const pattern of [
    'node_modules/',
    'coverage/',
    '.genxevo/',
    'genxevo.config.json',
    '.mcp.json',
    '.env',
    '*.pem',
    'PHASE*-REPORT.md',
  ]) {
    assert.ok(ignore.includes(pattern), pattern);
  }
  // And does NOT sweep up the examples, which are part of the product.
  assert.equal(/^examples\//m.test(ignore), false);
  assert.equal(/^genxevo\.config\.example\.json$/m.test(ignore), false);
});
