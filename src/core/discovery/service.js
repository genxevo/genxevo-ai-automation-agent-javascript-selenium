/**
 * Understanding an unfamiliar JavaScript automation project from evidence.
 *
 * THE RULES THIS SERVICE IS BUILT ON
 *
 * NOTHING IS ASSUMED FROM A NAME. A directory is not a test directory because it
 * is called `test`; it is a test directory because it contains files matching a
 * test-file shape or because the project's own runner configuration names it. A
 * directory is not a page-object directory because it is called `pages`; it is a
 * candidate because its modules import a browser automation library and are not
 * themselves test files. Every conclusion carries the signals that produced it
 * and an explicit confidence.
 *
 * NOTHING IN THE TARGET PROJECT IS EXECUTED, IMPORTED, EVALUATED OR INSTALLED.
 * See `signals.js` for why that rule bites harder in JavaScript than in Python.
 *
 * EVERY READ GOES THROUGH `boundedRead`, so the path boundary, the deny-list and
 * the secret redactor all have a live call site rather than being built, tested
 * and wired to nothing — which is what both sibling products ship today.
 *
 * `node_modules` IS NOT WALKED, and that is a deliberate divergence from
 * Python's ADR-017 reached by running Python's method rather than copying its
 * answer. See `security/denyList.js`. Two things are read out of it by DIRECT
 * PATH: `.package-lock.json`, and the `package.json` of a bounded allow-list of
 * notable packages — because DECLARED IS NOT INSTALLED, and the gap is where a
 * version mismatch masquerades as a test failure.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { WarningCode } from '../contract/warningCodes.js';
import { boundedRead, boundedReadJson } from '../security/boundedRead.js';
import { deepFreeze } from '../support/freeze.js';
import {
  AutomationFramework,
  Confidence,
  DirectoryKind,
  ModuleSystem,
  PackageManager,
  TestRunner,
} from './models.js';
import {
  AUTOMATION_DEPENDENCIES,
  AUTOMATION_IMPORTS,
  CI_FILE_NAMES,
  DEFAULT_TEST_FILE_PATTERN,
  LOCKFILES,
  NODE_PIN_FILES,
  NOTABLE_INSTALLED_PACKAGES,
  RUNNER_CONFIG_FILES,
  RUNNER_DEPENDENCIES,
  TEST_DATA_EXTENSIONS,
  importedPackages,
} from './signals.js';

/** Bounds on how much work one tool call may do. Every one is reported when it bites. */
export const MAX_SOURCE_FILES_READ = 400;
export const MAX_SOURCE_BYTES = 65_536;
export const MAX_FILES_PROBED_PER_DIRECTORY = 20;

const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/i;

export class ProjectDiscoveryService {
  #configuration;
  #boundary;
  #redactor;

  constructor({ configuration, boundary, redactor }) {
    this.#configuration = configuration;
    this.#boundary = boundary;
    this.#redactor = redactor;
  }

  /**
   * Scan the workspace and report what is actually there.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<{result: object, warnings: Array<object>, excerpt: object | null}>}
   */
  async discover(signal) {
    const state = new ScanState(this.#configuration, this.#boundary);

    for (const root of this.#boundary.roots) {
      try {
        await this.#walk(root, 0, state, signal);
      } catch (thrown) {
        if (thrown?.name === 'AbortError' || signal?.aborted) throw thrown;
        state.warn(
          WarningCode.DISCOVERY_ROOT_UNREADABLE,
          'A workspace root could not be fully scanned.',
          `root='${this.#boundary.toRelative(root)}' reason=${thrown?.code ?? thrown?.name ?? 'unknown'}`,
        );
      }
    }

    if (state.truncated) {
      state.warn(
        WarningCode.DISCOVERY_SCAN_LIMIT_REACHED,
        'The scan stopped early, so this inventory may be incomplete. Treat "not found" as "not looked at".',
        `limits: maxScanDepth=${this.#configuration.workspace.maxScanDepth}, maxScanEntries=${this.#configuration.workspace.maxScanEntries}`,
      );
    }

    this.#readInstalledState(state);

    const result = state.summarise();
    return { result, warnings: state.warnings, excerpt: state.excerpt };
  }

  async #walk(directory, depth, state, signal) {
    signal?.throwIfAborted();

    if (depth > this.#configuration.workspace.maxScanDepth) {
      state.truncated = true;
      return;
    }
    if (state.directoriesScanned >= this.#configuration.workspace.maxScanEntries) {
      state.truncated = true;
      return;
    }
    state.directoriesScanned += 1;

    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (thrown) {
      state.warn(
        WarningCode.DISCOVERY_DIRECTORY_UNREADABLE,
        'A directory was skipped because it could not be read.',
        `path='${this.#boundary.toRelative(directory)}' reason=${thrown?.code ?? 'unknown'}`,
      );
      return;
    }

    const files = entries.filter((entry) => entry.isFile());
    // A symlinked directory is never followed. The boundary would refuse an
    // escape anyway, but declining to walk it means the refusal never has to
    // happen and the scan cannot be sent in a loop.
    const subdirectories = entries.filter(
      (entry) => entry.isDirectory() && !entry.isSymbolicLink(),
    );
    state.filesSeen += files.length;

    await this.#inspectFiles(directory, files, state, signal);
    this.#classifyDirectory(directory, files, state, signal);

    const ignored = new Set(
      (this.#configuration.workspace.ignoredDirectories ?? []).map((name) => name.toLowerCase()),
    );
    for (const subdirectory of subdirectories) {
      signal?.throwIfAborted();
      if (ignored.has(subdirectory.name.toLowerCase())) continue;
      await this.#walk(path.join(directory, subdirectory.name), depth + 1, state, signal);
    }
  }

  async #inspectFiles(directory, files, state, signal) {
    for (const file of files) {
      signal?.throwIfAborted();
      const absolute = path.join(directory, file.name);
      const lowered = file.name.toLowerCase();

      if (lowered === 'package.json') {
        this.#readManifest(absolute, state);
      } else if (Object.hasOwn(LOCKFILES, lowered)) {
        state.addLockfile({
          path: this.#rel(absolute),
          kind: file.name,
          manager: LOCKFILES[lowered],
        });
      } else if (Object.hasOwn(RUNNER_CONFIG_FILES, lowered)) {
        this.#readRunnerConfig(absolute, file.name, RUNNER_CONFIG_FILES[lowered], state);
      } else if (NODE_PIN_FILES.includes(lowered)) {
        const read = boundedRead(this.#deps(), absolute, { maxBytes: 256 });
        if (read.ok) state.setNodePin(read.text.trim(), file.name);
      } else if (CI_FILE_NAMES.has(lowered)) {
        state.ciFiles.add(this.#rel(absolute));
      } else if (
        (lowered.endsWith('.yml') || lowered.endsWith('.yaml')) &&
        absolute.split(path.sep).includes('workflows')
      ) {
        state.ciFiles.add(this.#rel(absolute));
      }
    }
  }

  #readManifest(absolute, state) {
    const read = boundedReadJson(this.#deps(), absolute);
    const relative = this.#rel(absolute);

    if (!read.ok) {
      state.warn(
        WarningCode.DISCOVERY_MANIFEST_UNREADABLE,
        'A package.json was found but could not be read or parsed.',
        `path='${relative}' — do NOT read this as "no dependencies"`,
      );
      state.addManifest({ path: relative, parsed: false });
      return;
    }

    const raw = read.value ?? {};
    const dependencies = {
      ...(isObject(raw.dependencies) ? raw.dependencies : {}),
      ...(isObject(raw.devDependencies) ? raw.devDependencies : {}),
      ...(isObject(raw.optionalDependencies) ? raw.optionalDependencies : {}),
      ...(isObject(raw.peerDependencies) ? raw.peerDependencies : {}),
    };

    const manifest = {
      path: relative,
      parsed: true,
      name: typeof raw.name === 'string' ? raw.name : null,
      private: raw.private === true,
      type: typeof raw.type === 'string' ? raw.type : null,
      engines: isObject(raw.engines) ? raw.engines : null,
      packageManagerField: typeof raw.packageManager === 'string' ? raw.packageManager : null,
      workspaces: Array.isArray(raw.workspaces) ? raw.workspaces : null,
      scripts: isObject(raw.scripts) ? Object.keys(raw.scripts) : [],
      declaredDependencies: Object.keys(dependencies).sort(),
      depth: relative === 'package.json' ? 0 : relative.split('/').length - 1,
    };
    state.addManifest(manifest);

    // A `jest` key inside package.json is a runner configuration source, and it
    // is JSON, so unlike jest.config.js it can be read rather than merely noted.
    if (isObject(raw.jest)) {
      state.addRunnerConfig({
        path: relative,
        kind: 'package.json#jest',
        runner: TestRunner.JEST,
        parsed: true,
        testRoots: extractPaths(raw.jest.roots ?? raw.jest.testMatch),
      });
    }
    if (isObject(raw.mocha)) {
      state.addRunnerConfig({
        path: relative,
        kind: 'package.json#mocha',
        runner: TestRunner.MOCHA,
        parsed: true,
        testRoots: extractPaths(raw.mocha.spec),
      });
    }

    // `scripts` are RECORDED, never run, and the script bodies are not emitted:
    // a script line is a shell command and may carry a token.
    for (const [scriptName, body] of Object.entries(isObject(raw.scripts) ? raw.scripts : {})) {
      state.observeScript(scriptName, String(body));
    }
  }

  #readRunnerConfig(absolute, name, runner, state) {
    const relative = this.#rel(absolute);
    const isJson = name.toLowerCase().endsWith('.json') || name.toLowerCase().endsWith('.jsonc');

    if (!isJson) {
      // A `.js`/`.ts`/`.cjs`/`.mjs` runner configuration IS A PROGRAM. Its
      // presence is the evidence; its contents are not read as configuration and
      // it is never evaluated. Saying so plainly is more useful to an agent than
      // a half-parsed guess would be.
      state.addRunnerConfig({
        path: relative,
        kind: name,
        runner,
        parsed: false,
        testRoots: [],
        note: 'Recorded as present. This file is executable JavaScript and GenXEvo never evaluates it.',
      });
      return;
    }

    const read = boundedReadJson(this.#deps(), absolute);
    if (!read.ok) {
      state.addRunnerConfig({ path: relative, kind: name, runner, parsed: false, testRoots: [] });
      state.warn(
        WarningCode.DISCOVERY_MANIFEST_UNREADABLE,
        'A runner configuration file was found but could not be parsed.',
        `path='${relative}'`,
      );
      return;
    }
    const raw = read.value ?? {};
    state.addRunnerConfig({
      path: relative,
      kind: name,
      runner,
      parsed: true,
      testRoots: extractPaths(raw.spec ?? raw.roots ?? raw.testMatch ?? raw.specs),
    });
  }

  #classifyDirectory(directory, files, state, signal) {
    if (this.#boundary.roots.includes(directory)) return; // the root is not "a directory of" anything

    const relative = this.#rel(directory);
    const sourceFiles = files.filter((f) => SOURCE_EXTENSION.test(f.name));
    const testFiles = sourceFiles.filter((f) => DEFAULT_TEST_FILE_PATTERN.test(f.name));

    if (testFiles.length > 0) {
      state.addDirectory({
        kind: DirectoryKind.TESTS,
        path: relative,
        fileCount: files.length,
        signals: [
          `${testFiles.length} file(s) match a .test/.spec name shape`,
          ...(state.declaredTestRoots.has(relative)
            ? ["the project's own runner configuration names this directory"]
            : []),
        ],
        confidence: state.declaredTestRoots.has(relative) ? Confidence.HIGH : Confidence.MEDIUM,
      });
      state.testRoots.add(relative);
      return;
    }

    if (sourceFiles.length > 0 && state.sourceReads < MAX_SOURCE_FILES_READ) {
      let automationHits = 0;
      const frameworks = new Set();
      for (const file of sourceFiles.slice(0, MAX_FILES_PROBED_PER_DIRECTORY)) {
        signal?.throwIfAborted();
        const read = boundedRead(this.#deps(), path.join(directory, file.name), {
          maxBytes: MAX_SOURCE_BYTES,
        });
        state.sourceReads += 1;
        if (!read.ok) continue;
        for (const specifier of importedPackages(read.text)) {
          const framework = AUTOMATION_IMPORTS[specifier];
          if (framework) {
            automationHits += 1;
            frameworks.add(framework);
            state.automationFrameworks.add(framework);
            state.frameworkEvidence.add(`${framework} imported by a module in '${relative}'`);
            break;
          }
        }
      }
      if (automationHits > 0) {
        state.addDirectory({
          kind: DirectoryKind.PAGE_OBJECTS,
          path: relative,
          fileCount: files.length,
          signals: [
            `${automationHits} module(s) import ${[...frameworks].join(', ')} and none is named as a test file`,
          ],
          confidence: Confidence.MEDIUM,
        });
        state.pageObjectCandidates.add(relative);
        return;
      }
    }

    const dataFiles = files.filter((f) =>
      TEST_DATA_EXTENSIONS.has(path.extname(f.name).toLowerCase()),
    );
    if (dataFiles.length >= 2 && sourceFiles.length === 0) {
      state.addDirectory({
        kind: DirectoryKind.TEST_DATA,
        path: relative,
        fileCount: files.length,
        signals: [`${dataFiles.length} data file(s) and no JavaScript module`],
        confidence: Confidence.LOW,
      });
    }
  }

  /**
   * Read what is INSTALLED, by direct path, never by walking `node_modules`.
   *
   * `node_modules/.package-lock.json` is the JavaScript equivalent of Python's
   * `pyvenv.cfg`: one JSON file at a known path that states the resolved version
   * of everything actually on disk, for the cost of a single read.
   */
  #readInstalledState(state) {
    for (const root of this.#boundary.roots) {
      const installedLock = path.join(root, 'node_modules', '.package-lock.json');
      const read = boundedReadJson(this.#deps(), installedLock, { maxBytes: 4_194_304 });
      if (!read.ok) continue;

      const packages = isObject(read.value?.packages) ? read.value.packages : {};
      for (const name of NOTABLE_INSTALLED_PACKAGES) {
        const entry = packages[`node_modules/${name}`];
        if (entry && typeof entry.version === 'string') {
          state.installedNotable.set(name, entry.version);
        }
      }
      state.installedStateSource = this.#rel(installedLock);
      break;
    }
  }

  #deps() {
    return { boundary: this.#boundary, redactor: this.#redactor };
  }

  #rel(absolute) {
    return this.#boundary.toRelative(absolute);
  }
}

/** Mutable accumulator for one scan. Deliberately not part of the public surface. */
class ScanState {
  constructor(configuration, boundary) {
    this.configuration = configuration;
    this.boundary = boundary;
    this.manifests = [];
    this.lockfiles = [];
    this.runnerConfigs = [];
    this.directories = [];
    this.ciFiles = new Set();
    this.warnings = [];
    this.testRoots = new Set();
    this.declaredTestRoots = new Set();
    this.pageObjectCandidates = new Set();
    this.automationFrameworks = new Set();
    this.frameworkEvidence = new Set();
    this.runnerEvidence = new Set();
    this.installedNotable = new Map();
    this.installedStateSource = null;
    this.nodePin = null;
    this.nodePinSource = null;
    this.scriptRunners = new Set();
    this.scriptNames = new Set();
    this.directoriesScanned = 0;
    this.filesSeen = 0;
    this.sourceReads = 0;
    this.truncated = false;
    this.excerpt = null;
  }

  warn(code, message, detail) {
    if (!this.warnings.some((w) => w.code === code && w.detail === detail)) {
      this.warnings.push({ code, message, detail });
    }
  }

  addManifest(manifest) {
    this.manifests.push(manifest);
  }

  addLockfile(lockfile) {
    this.lockfiles.push(lockfile);
  }

  addRunnerConfig(config) {
    this.runnerConfigs.push(config);
    this.runnerEvidence.add(`${config.kind} is present`);
    for (const root of config.testRoots ?? []) this.declaredTestRoots.add(root);
  }

  addDirectory(directory) {
    this.directories.push(directory);
  }

  setNodePin(value, source) {
    if (!this.nodePin && value) {
      this.nodePin = value.replace(/^v/, '');
      this.nodePinSource = source;
    }
  }

  /**
   * Record that a script exists and what runner it invokes.
   *
   * The script BODY is never emitted. `"test": "playwright test"` is harmless
   * and `"test": "node deploy.js --token=$SECRET"` is equally valid JSON, so the
   * runner is extracted and the line is dropped.
   */
  observeScript(name, body) {
    this.scriptNames.add(name);
    const text = body.toLowerCase();
    if (/\bwdio\b/.test(text)) this.scriptRunners.add(TestRunner.WDIO);
    if (/\bmocha\b/.test(text)) this.scriptRunners.add(TestRunner.MOCHA);
    if (/\bjest\b/.test(text)) this.scriptRunners.add(TestRunner.JEST);
    if (/\bvitest\b/.test(text)) this.scriptRunners.add(TestRunner.VITEST);
    if (/node\s+--test\b/.test(text)) this.scriptRunners.add(TestRunner.NODE);
    if (/\bplaywright\s+test\b/.test(text))
      this.automationFrameworks.add(AutomationFramework.PLAYWRIGHT);
  }

  get rootManifest() {
    return this.manifests.filter((m) => m.parsed).sort((a, b) => a.depth - b.depth)[0] ?? null;
  }

  summarise() {
    const reasoning = [];
    const declared = new Set();
    for (const manifest of this.manifests) {
      for (const name of manifest.declaredDependencies ?? []) declared.add(name);
    }

    for (const [name, framework] of Object.entries(AUTOMATION_DEPENDENCIES)) {
      if (declared.has(name)) {
        this.automationFrameworks.add(framework);
        this.frameworkEvidence.add(`'${name}' is a declared dependency`);
      }
    }

    const packageManager = this.#decidePackageManager(reasoning);
    const runner = this.#decideRunner(reasoning, declared);
    const testRoots = this.#decideTestRoots(reasoning);
    const toolchain = this.#buildToolchain(reasoning);

    const frameworks = [...this.automationFrameworks].sort();
    const seleniumCompatible = frameworks.includes(AutomationFramework.SELENIUM);

    if (frameworks.length > 0 && !seleniumCompatible) {
      const message = `This build provides Selenium capabilities, but the project uses ${frameworks.join(', ')}.`;
      reasoning.push(`${message} Browser capabilities will not apply.`);
      this.warn(
        WarningCode.DISCOVERY_FRAMEWORK_MISMATCH,
        message,
        frameworks.includes(AutomationFramework.WEBDRIVERIO)
          ? 'WebdriverIO is not selenium-webdriver. It is a different product with a different API, and GenXEvo JavaScript Selenium does not drive it.'
          : 'Use the matching GenXEvo agent for that framework.',
      );
    } else if (frameworks.length === 0) {
      reasoning.push(
        'No browser automation library was found in any declared dependency, in the installed packages, or in the imports of any module read.',
      );
    }

    return deepFreeze({
      summary: {
        packageManager: packageManager.value,
        packageManagerConfidence: packageManager.confidence,
        moduleSystem: this.#moduleSystem(),
        runner: runner.value,
        runnerConfidence: runner.confidence,
        testRoots: [...testRoots.value].sort(),
        testRootConfidence: testRoots.confidence,
        automationFrameworks: frameworks,
        seleniumCompatible,
        pageObjectCandidates: [...this.pageObjectCandidates].sort(),
        reasoning,
      },
      toolchain,
      manifests: this.manifests,
      lockfiles: this.lockfiles,
      runnerConfigs: this.runnerConfigs,
      directories: this.directories,
      ciFiles: [...this.ciFiles].sort(),
      scan: {
        directoriesScanned: this.directoriesScanned,
        filesSeen: this.filesSeen,
        sourceFilesRead: this.sourceReads,
        truncated: this.truncated,
      },
    });
  }

  #moduleSystem() {
    const manifest = this.rootManifest;
    if (!manifest || manifest.type === null) return ModuleSystem.UNDECLARED;
    return manifest.type === 'module' ? ModuleSystem.ESM : ModuleSystem.COMMONJS;
  }

  #decidePackageManager(reasoning) {
    const configured = this.configuration.project.packageManager;
    if (configured !== 'auto') {
      reasoning.push(
        `The operator set project.packageManager='${configured}', which overrides discovery.`,
      );
      return { value: configured, confidence: Confidence.HIGH };
    }

    const fromLockfiles = [...new Set(this.lockfiles.map((l) => l.manager))];
    const field = this.rootManifest?.packageManagerField ?? null;
    const fromField = field ? field.split('@')[0] : null;

    if (fromLockfiles.length > 1) {
      const message = `More than one lockfile is present (${this.lockfiles.map((l) => l.kind).join(', ')}), so the project does not state one package manager.`;
      reasoning.push(message);
      this.warn(
        WarningCode.DISCOVERY_TOOLCHAIN_MISMATCH,
        message,
        "Set 'project.packageManager' to settle it. Installing with the wrong manager rewrites the other's tree.",
      );
      return { value: PackageManager.UNKNOWN, confidence: Confidence.LOW };
    }

    if (fromLockfiles.length === 1 && fromField && fromField !== fromLockfiles[0]) {
      const message = `package.json declares packageManager='${field}' but the lockfile on disk belongs to ${fromLockfiles[0]}.`;
      reasoning.push(message);
      this.warn(
        WarningCode.DISCOVERY_TOOLCHAIN_MISMATCH,
        message,
        'A packageManager field is only honoured when Corepack is enabled. Declared is not installed.',
      );
      return { value: fromLockfiles[0], confidence: Confidence.MEDIUM };
    }

    if (fromLockfiles.length === 1) {
      reasoning.push(
        `A ${this.lockfiles[0].kind} is present${fromField ? " and package.json's packageManager field agrees" : ''}.`,
      );
      return {
        value: fromLockfiles[0],
        confidence: fromField ? Confidence.HIGH : Confidence.MEDIUM,
      };
    }

    if (fromField) {
      reasoning.push(
        `No lockfile is present; package.json declares packageManager='${field}', which is a statement of intent rather than of fact.`,
      );
      return { value: fromField, confidence: Confidence.LOW };
    }

    reasoning.push(
      'No lockfile and no packageManager field, so the package manager cannot be established.',
    );
    return { value: PackageManager.UNKNOWN, confidence: Confidence.NONE };
  }

  #decideRunner(reasoning, declared) {
    const configured = this.configuration.project.runner;
    if (configured !== 'auto') {
      reasoning.push(`The operator set project.runner='${configured}', which overrides discovery.`);
      return { value: configured, confidence: Confidence.HIGH };
    }

    const fromDependencies = new Set();
    for (const [name, runner] of Object.entries(RUNNER_DEPENDENCIES)) {
      if (declared.has(name)) fromDependencies.add(runner);
    }
    const fromConfigs = new Set(this.runnerConfigs.map((c) => c.runner));
    const fromScripts = this.scriptRunners;

    // WebdriverIO wins over the framework it delegates to: a project with
    // @wdio/cli AND @wdio/mocha-framework is a WebdriverIO project, and telling
    // an agent "mocha" would have it construct an invocation that does nothing.
    const preferWdio =
      fromDependencies.has(TestRunner.WDIO) ||
      fromConfigs.has(TestRunner.WDIO) ||
      fromScripts.has(TestRunner.WDIO);
    if (preferWdio) {
      reasoning.push(
        'WebdriverIO is present, and it owns the test lifecycle even when it delegates assertions to Mocha or Jasmine.',
      );
      return { value: TestRunner.WDIO, confidence: Confidence.HIGH };
    }

    const agreeing = [...fromDependencies].filter(
      (runner) => fromConfigs.has(runner) || fromScripts.has(runner),
    );
    if (agreeing.length === 1) {
      reasoning.push(
        `'${agreeing[0]}' is both a declared dependency and named by the project's own configuration or scripts.`,
      );
      return { value: agreeing[0], confidence: Confidence.HIGH };
    }

    const candidates = new Set([...fromDependencies, ...fromConfigs, ...fromScripts]);
    if (candidates.size === 1) {
      const [only] = candidates;
      reasoning.push(`'${only}' was detected, but from only one kind of evidence.`);
      return { value: only, confidence: Confidence.MEDIUM };
    }
    if (candidates.size > 1) {
      const message = `More than one test runner is present (${[...candidates].join(', ')}).`;
      reasoning.push(`${message} GenXEvo will not choose between them.`);
      this.warn(
        WarningCode.DISCOVERY_TOOLCHAIN_MISMATCH,
        message,
        "Set 'project.runner' to settle it.",
      );
      return { value: TestRunner.UNKNOWN, confidence: Confidence.LOW };
    }

    reasoning.push(
      "Nothing in this project states which test runner it uses. GenXEvo reports 'unknown' rather than assuming one; set project.runner in the configuration to settle it.",
    );
    return { value: TestRunner.UNKNOWN, confidence: Confidence.NONE };
  }

  #decideTestRoots(reasoning) {
    const configured = this.configuration.project.testRoots ?? [];
    if (configured.length > 0) {
      reasoning.push('The operator set project.testRoots, which overrides discovery.');
      return { value: new Set(configured), confidence: Confidence.HIGH };
    }
    if (this.declaredTestRoots.size > 0) {
      reasoning.push(
        `The project's own runner configuration declares its test roots, which is authoritative: ${[...this.declaredTestRoots].join(', ')}.`,
      );
      return { value: this.declaredTestRoots, confidence: Confidence.HIGH };
    }
    if (this.testRoots.size > 0) {
      reasoning.push(
        `${this.testRoots.size} director(ies) contain files matching a .test/.spec name shape, so they were classified as test roots from their CONTENTS rather than from their names.`,
      );
      return { value: this.testRoots, confidence: Confidence.MEDIUM };
    }
    reasoning.push(
      'No directory contained files matching a test-file shape and no runner configuration declared one, so no test root could be established.',
    );
    return { value: new Set(), confidence: Confidence.NONE };
  }

  #buildToolchain(reasoning) {
    const manifest = this.rootManifest;
    const engines = manifest?.engines?.node ?? null;
    const installed = [...this.installedNotable.entries()]
      .map(([name, version]) => `${name}@${version}`)
      .sort();

    // DECLARED IS NOT INSTALLED. This is the gap that makes a version mismatch
    // look like a test failure, and it is wider in JavaScript than in any other
    // language in this family.
    const mismatches = [];
    for (const [name, installedVersion] of this.installedNotable) {
      const declaredRange = this.manifests
        .flatMap((m) => (m.declaredDependencies?.includes(name) ? [m.path] : []))
        .at(0);
      if (declaredRange === undefined) {
        mismatches.push(
          `'${name}@${installedVersion}' is installed but not declared by any manifest.`,
        );
      }
    }
    if (this.installedStateSource === null && this.manifests.length > 0) {
      reasoning.push(
        'No node_modules/.package-lock.json was found, so GenXEvo can report what the project DECLARES but not what is actually installed.',
      );
    }

    return {
      declaredNodeRange: engines,
      pinnedNodeVersion: this.nodePin,
      pinnedNodeVersionSource: this.nodePinSource,
      packageManagerField: manifest?.packageManagerField ?? null,
      moduleSystemDeclaration: manifest?.type ?? null,
      lockfiles: this.lockfiles.map((l) => l.kind),
      scriptNames: [...this.scriptNames].sort(),
      installedNotable: installed,
      installedStateSource: this.installedStateSource,
      mismatches,
    };
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractPaths(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string');
  return [];
}
