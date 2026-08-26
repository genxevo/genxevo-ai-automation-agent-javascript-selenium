import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  AGENT_DATA_DIRECTORY,
  PathBoundary,
  PathBoundaryError,
  PathIntent,
  canonicalise,
  checkStructure,
  isResolvedPath,
} from '../src/core/security/pathBoundary.js';
import { ErrorCode } from '../src/core/contract/errorCodes.js';
import { boundaryFor, tempWorkspace, writeFile } from './helpers/fixtures.js';

test('construction: a boundary with no usable root REFUSES TO EXIST', () => {
  // GenXEvo never falls back to "the current directory". An unconfigured
  // boundary is a refusal, not a default.
  assert.throws(() => new PathBoundary([]), PathBoundaryError);
  assert.throws(() => new PathBoundary(['   ', '']), PathBoundaryError);
});

test('construction: duplicate roots collapse', () => {
  const root = tempWorkspace();
  assert.equal(new PathBoundary([root, root, `${root}${path.sep}`]).roots.length, 1);
});

test('traversal is refused in every shape', () => {
  const root = tempWorkspace();
  const boundary = boundaryFor(root);
  for (const candidate of [
    '../secret.txt',
    '../../secret.txt',
    'a/../../secret.txt',
    './../../secret.txt',
    'a/b/../../../secret.txt',
  ]) {
    const result = boundary.resolve(candidate);
    assert.equal(result.ok, false, candidate);
    assert.equal(result.error.code, ErrorCode.PATH_OUTSIDE_WORKSPACE, candidate);
  }
});

test('an absolute path outside the workspace is refused', () => {
  const boundary = boundaryFor(tempWorkspace());
  const result = boundary.resolve(path.join(tempWorkspace(), 'elsewhere.txt'));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ErrorCode.PATH_OUTSIDE_WORKSPACE);
});

test('a SIBLING sharing the root prefix is not contained', () => {
  // `C:\work-secrets` is not inside `C:\work`. A string prefix check would say
  // it is; part-wise comparison via path.relative says it is not.
  const root = tempWorkspace();
  const sibling = `${root}-secrets`;
  fs.mkdirSync(sibling);
  const result = boundaryFor(root).resolve(sibling);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ErrorCode.PATH_OUTSIDE_WORKSPACE);
});

test('a SYMLINK pointing out of the workspace is refused', () => {
  // This is the case the C# sibling cannot catch: Path.GetFullPath is lexical
  // and does not resolve links, so the escape passes containment and reads
  // outside the workspace on I/O. fs.realpathSync.native resolves it.
  const root = tempWorkspace();
  const outside = tempWorkspace();
  writeFile(outside, 'secret.txt', 'top secret');
  fs.symlinkSync(outside, path.join(root, 'escape'), 'dir');

  const boundary = boundaryFor(root);
  assert.equal(boundary.resolve('escape').ok, false);
  const viaLink = boundary.resolve('escape/secret.txt');
  assert.equal(viaLink.ok, false);
  assert.equal(viaLink.error.code, ErrorCode.PATH_OUTSIDE_WORKSPACE);
});

test('a symlink STAYING INSIDE the workspace is allowed', () => {
  const root = tempWorkspace();
  writeFile(root, 'src/a.js', 'x');
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'link'), 'dir');
  const result = boundaryFor(root).resolve('link/a.js');
  assert.equal(result.ok, true);
  assert.equal(result.path.relativePath, 'src/a.js');
});

test('structural refusals happen BEFORE any filesystem call, on every platform', () => {
  // The Windows-only rules are pure functions taking an explicit flag, so
  // Windows attack shapes are asserted from a Linux runner too. No product in
  // this family has ever run on Windows; asserting them only there would mean
  // never asserting them at all.
  const refusedOnWindows = [
    ['\\\\server\\share\\x', 'UNC'],
    ['//server/share/x', 'UNC forward-slash'],
    ['\\\\?\\C:\\x', 'extended-length prefix'],
    ['\\\\.\\PhysicalDrive0', 'device path'],
    ['file.txt:hidden', 'alternate data stream'],
    ['C:\\project\\file.txt:hidden', 'alternate data stream on an ABSOLUTE path'],
    ['C:foo', 'drive-relative'],
  ];
  for (const [candidate, label] of refusedOnWindows) {
    assert.notEqual(checkStructure(candidate, { windows: true }), null, label);
  }
  assert.equal(checkStructure('C:\\project\\file.txt', { windows: true }), null);
  assert.equal(checkStructure('src/a.js', { windows: true }), null);
});

test('a drive letter is not mistaken for an alternate data stream', () => {
  assert.equal(checkStructure('C:\\', { windows: true }), null);
  assert.equal(checkStructure('C:/project/a.js', { windows: true }), null);
});

test('a colon is an ordinary character on POSIX', () => {
  assert.equal(checkStructure('weird:name.js', { windows: false }), null);
});

test('empty input and a null byte are refused', () => {
  const boundary = boundaryFor(tempWorkspace());
  for (const candidate of ['', '   ', null, undefined]) {
    const result = boundary.resolve(candidate);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, ErrorCode.PATH_MALFORMED);
  }
  assert.equal(boundary.resolve('a\u0000b').error.code, ErrorCode.PATH_MALFORMED);
});

test('a denied file inside the workspace is STILL refused, and the refusal names the pattern', () => {
  const root = tempWorkspace();
  writeFile(root, '.npmrc', '//registry.npmjs.org/:_authToken=npm_x');
  const result = boundaryFor(root).resolve('.npmrc');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ErrorCode.PATH_DENIED);
  assert.match(result.error.detail, /pattern='\*\*\/\.npmrc'/);
});

test('the JavaScript-specific credential files are all denied', () => {
  const root = tempWorkspace();
  const denied = [
    '.npmrc',
    'packages/app/.npmrc',
    '.yarnrc.yml',
    '.pnpmfile.cjs',
    '.env',
    '.env.production',
    'config.local.json',
    'settings.local.json',
    'certs/server.pem',
    'certs/server.key',
    'secrets.json',
    '.docker/config.json',
    '.vercel/project.json',
  ];
  const boundary = boundaryFor(root);
  for (const relative of denied) {
    writeFile(root, relative, 'x');
    const result = boundary.resolve(relative);
    assert.equal(result.ok, false, relative);
    assert.equal(result.error.code, ErrorCode.PATH_DENIED, relative);
  }
});

test('an ordinary project file is not denied', () => {
  const root = tempWorkspace();
  for (const relative of ['package.json', 'test/login.test.js', 'wdio.conf.js', '.nvmrc']) {
    writeFile(root, relative, 'x');
    assert.equal(boundaryFor(root).resolve(relative).ok, true, relative);
  }
});

test('a capability may not WRITE into the agent directory, but may READ it', () => {
  const root = tempWorkspace();
  const boundary = boundaryFor(root);
  const write = boundary.resolve(`${AGENT_DATA_DIRECTORY}/runs/x`, PathIntent.WRITE);
  assert.equal(write.ok, false);
  assert.equal(write.error.code, ErrorCode.PATH_DENIED);
  assert.equal(boundary.resolve(`${AGENT_DATA_DIRECTORY}/runs/x`, PathIntent.READ).ok, true);
});

test('a refusal NEVER echoes the resolved absolute path', () => {
  const root = tempWorkspace();
  const refusal = boundaryFor(root).resolve('../../etc/passwd');
  assert.equal(JSON.stringify(refusal).includes(root), false);
  // The candidate the caller supplied is echoed, because they already know it.
  assert.match(refusal.error.detail, /requested='\.\.\/\.\.\/etc\/passwd'/);
});

test('an accepted path exposes only the relative form, with forward slashes', () => {
  const root = tempWorkspace();
  writeFile(root, 'suite/checks/login.test.js', 'x');
  const resolved = boundaryFor(root).resolve('suite/checks/login.test.js');
  assert.equal(resolved.path.relativePath, 'suite/checks/login.test.js');
  assert.equal(String(resolved.path.relativePath).includes('\\'), false);
  assert.ok(isResolvedPath(resolved.path));
});

test('a ResolvedPath cannot be forged outside the boundary module', () => {
  // JavaScript cannot give the compile-time guarantee C# and Java get. What it
  // can give is a brand only PathBoundary sets, and a check every I/O caller
  // makes. The documentation says exactly that rather than claiming more.
  assert.equal(
    isResolvedPath({ absolutePath: '/etc/passwd', relativePath: 'x', root: '/' }),
    false,
  );
});

test('toRelative falls back to a bare name for a path outside every root', () => {
  const boundary = boundaryFor(tempWorkspace());
  assert.equal(boundary.toRelative('/etc/passwd'), 'passwd');
  assert.equal(boundary.toRelative(''), '');
});

test('a relative path resolves against the FIRST ROOT, never the process directory', () => {
  const root = tempWorkspace();
  writeFile(root, 'a.js', 'x');
  const boundary = boundaryFor(root);
  const before = process.cwd();
  try {
    process.chdir(tempWorkspace());
    const resolved = boundary.resolve('a.js');
    assert.equal(resolved.ok, true);
    assert.equal(resolved.path.relativePath, 'a.js');
  } finally {
    process.chdir(before);
  }
});

test('the root itself resolves to dot', () => {
  const root = tempWorkspace();
  assert.equal(boundaryFor(root).resolve('.').path.relativePath, '.');
});

test('a path that does not exist yet still resolves', () => {
  // A write intent legitimately names a file that is not there, and so does a
  // read of a file the agent expects to be created. realpath throws ENOENT, so
  // the deepest EXISTING ancestor is canonicalised and the rest appended - which
  // still resolves every link that could actually be traversed.
  const root = tempWorkspace();
  const resolved = boundaryFor(root).resolve('reports/new/output.json');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.path.relativePath, 'reports/new/output.json');
});

test('a not-yet-existing path UNDER A SYMLINK still cannot escape', () => {
  const root = tempWorkspace();
  const outside = tempWorkspace();
  fs.symlinkSync(outside, path.join(root, 'escape'), 'dir');
  assert.equal(boundaryFor(root).resolve('escape/not/created/yet.json').ok, false);
});

test('a second approved root is honoured', () => {
  const first = tempWorkspace();
  const second = tempWorkspace();
  writeFile(second, 'b.js', 'x');
  const boundary = new PathBoundary([first, second]);
  const resolved = boundary.resolve(path.join(second, 'b.js'));
  assert.equal(resolved.ok, true);
  assert.equal(resolved.path.root, second);
});

test('canonicalise strips a trailing separator without eating a drive root', () => {
  const root = tempWorkspace();
  assert.equal(canonicalise(`${root}/`), root);

  // THE SECOND ASSERTION USED TO BE `canonicalise('/') === '/'`, AND IT WAS THE
  // TEST THAT WAS WRONG, not the implementation. It failed on Windows with
  // actual `E:\`, expected `/`.
  //
  // `canonicalise` begins with `path.resolve`, which is platform-dependent by
  // definition. On POSIX `/` is the filesystem root and resolves to itself. On
  // Windows `/` is a ROOTED BUT DRIVE-RELATIVE path: it names the root of
  // whichever drive the process happens to be on, so it resolves to `E:\` here
  // and to `C:\` on another machine. Hard-coding a POSIX literal asserted the
  // platform rather than the invariant, which is the same mistake this module's
  // own header warns about when it explains why the Windows structural rules are
  // pure functions taking an explicit flag.
  //
  // The invariant this test is named for is: A FILESYSTEM ROOT CANONICALISES TO
  // ITSELF. `stripTrailingSeparator` must not turn `/` into the empty string, and
  // must not turn `E:\` into `E:` - which is a real hazard, because `E:` is
  // drive-relative and would silently start resolving against a per-drive current
  // directory. Asking the platform for its own notion of a root asserts exactly
  // that, and on POSIX it evaluates to the identical `canonicalise('/') === '/'`
  // the line above always made.
  const filesystemRoot = path.parse(root).root;
  assert.equal(canonicalise(filesystemRoot), filesystemRoot);
  assert.notEqual(canonicalise(filesystemRoot), '');
});
