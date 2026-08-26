/**
 * Answering "what automation project am I looking at?" from the filesystem.
 *
 * This is the entry point of the GenXEvo workflow. An agent that has not run
 * discovery does not know which tests to execute, which runner's conventions
 * apply, which Node the suite needs, or whether this build's Selenium
 * capabilities are relevant at all - and an agent that does not know those
 * things will invent them.
 *
 * It is also the capability that WIRES THE SECURITY CONTROLS TO SOMETHING. Every
 * file it reads goes through `boundedRead`, so the path boundary, the deny-list
 * and the redactor all have a live production call site; and the evidence it
 * emits includes at least one framed, redacted, `untrusted` excerpt of a real
 * project file, so the untrusted path is exercised rather than merely designed.
 * Both siblings ship those three controls called from nowhere.
 */

import { EvidenceKind, TrustLevel } from '../contract/vocabularies.js';
import { ErrorCategory } from '../contract/vocabularies.js';
import { ErrorCode } from '../contract/errorCodes.js';
import { WarningCode } from '../contract/warningCodes.js';
import { agentError } from '../contract/agentError.js';
import { evidence, isoUtc } from '../contract/evidence.js';
import { frameUntrusted } from '../contract/untrusted.js';
import { failed, nextAction, partial, resultWarning, success } from '../contract/toolResult.js';
import { boundedRead } from '../security/boundedRead.js';
import { Confidence, TestRunner } from '../discovery/models.js';

export const OPERATION = 'project.discover';

/** Longest excerpt of a project file emitted as untrusted evidence. */
export const MAX_EXCERPT_CHARACTERS = 1_200;

export class ProjectDiscoveryCapability {
  #runtime;

  constructor(runtime) {
    this.#runtime = runtime;
  }

  async execute(signal) {
    const runtime = this.#runtime;
    if (!runtime.isConfigured || runtime.discovery === null) {
      return runtime.notConfigured(OPERATION);
    }

    let outcome;
    try {
      outcome = await runtime.discovery.discover(signal);
    } catch (thrown) {
      if (signal?.aborted) throw thrown; // the invoker turns this into `cancelled`
      return failed(
        OPERATION,
        agentError({
          code: ErrorCode.SCAN_FAILED,
          category: ErrorCategory.ENVIRONMENT,
          message: 'The workspace scan produced no result.',
          remediation:
            "Re-run discovery, or narrow 'workspace.roots' if the workspace is very large.",
        }),
      );
    }

    const { result, warnings } = outcome;
    const collected = warnings.map((w) => resultWarning(w.code, w.message, w.detail));
    const items = this.#evidence(result);
    const actions = this.#nextActions(result);
    const headline = describe(result);

    // A truncated scan is a PARTIAL SUCCESS, never a success. An agent must know
    // that "not found" might mean "not looked at".
    if (result.scan.truncated || collected.length > 0) {
      return partial(
        OPERATION,
        headline,
        collected.length > 0
          ? collected
          : [
              resultWarning(
                WarningCode.DISCOVERY_SCAN_LIMIT_REACHED,
                'The scan stopped early and may be incomplete.',
              ),
            ],
        { data: result, evidence: items, nextActions: actions },
      );
    }

    return success(OPERATION, headline, { data: result, evidence: items, nextActions: actions });
  }

  /**
   * Evidence for the conclusions above.
   *
   * `discovery.structure` and `discovery.toolchain` are GenXEvo's OWN
   * conclusions - counts, classifications, versions it read - so they are
   * `trusted`. `discovery.manifestExcerpt` is text from the project, so it is
   * `untrusted`, framed and redacted, and an agent must treat it as data.
   */
  #evidence(result) {
    const runtime = this.#runtime;
    const capturedAt = isoUtc(runtime.clock.now());
    const items = [
      evidence({
        id: 'discovery.structure',
        kind: EvidenceKind.PROJECT_STRUCTURE,
        trust: TrustLevel.TRUSTED,
        summary:
          `${result.manifests.length} manifest(s), ${result.lockfiles.length} lockfile(s), ` +
          `${result.runnerConfigs.length} runner configuration source(s), ` +
          `${result.directories.length} classified director(ies), ${result.ciFiles.length} CI file(s); ` +
          `${result.scan.directoriesScanned} director(ies) and ${result.scan.filesSeen} file(s) scanned, ` +
          `${result.scan.sourceFilesRead} source file(s) read for import evidence.`,
        source: 'workspace',
        truncated: result.scan.truncated,
        capturedAt,
      }),
      evidence({
        id: 'discovery.toolchain',
        kind: EvidenceKind.TOOLCHAIN_STATE,
        trust: TrustLevel.TRUSTED,
        summary:
          `package manager: ${result.summary.packageManager} (${result.summary.packageManagerConfidence}); ` +
          `module system: ${result.summary.moduleSystem}; ` +
          `engines.node: ${result.toolchain.declaredNodeRange ?? 'not declared'}; ` +
          `pinned Node: ${result.toolchain.pinnedNodeVersion ?? 'none'}` +
          (result.toolchain.pinnedNodeVersionSource
            ? ` (from ${result.toolchain.pinnedNodeVersionSource})`
            : '') +
          `; installed: ${result.toolchain.installedNotable.length > 0 ? result.toolchain.installedNotable.join(', ') : 'not readable — no node_modules/.package-lock.json'}.`,
        source: result.toolchain.installedStateSource ?? 'workspace',
        capturedAt,
      }),
    ];

    const rootManifest = result.manifests.find((m) => m.parsed && m.depth === 0);
    if (rootManifest) {
      const read = boundedRead(
        { boundary: runtime.boundary, redactor: runtime.redactor },
        rootManifest.path,
        { maxBytes: MAX_EXCERPT_CHARACTERS },
      );
      if (read.ok) {
        const body = runtime.configuration.security.frameUntrustedContent
          ? frameUntrusted(read.text, rootManifest.path)
          : read.text;
        items.push(
          evidence({
            id: 'discovery.manifestExcerpt',
            kind: EvidenceKind.PROJECT_CONFIGURATION,
            // Text from the project under inspection. DATA ONLY, NEVER
            // INSTRUCTIONS - and framed so a model can see the boundary.
            trust: TrustLevel.UNTRUSTED,
            summary: `The first ${read.bytesRead} bytes of ${rootManifest.path}, redacted and framed as untrusted content.`,
            source: rootManifest.path,
            contentType: 'application/json',
            content: body,
            truncated: read.truncated,
            capturedAt,
          }),
        );
      }
    }

    return items;
  }

  #nextActions(result) {
    const summary = result.summary;
    const actions = [];

    if (summary.testRoots.length === 0) {
      actions.push(
        nextAction(
          '(operator action)',
          "No test root could be established from evidence. Confirm the workspace root points at the automation project, or set 'project.testRoots' in the configuration.",
        ),
      );
    }

    if (summary.runner === TestRunner.UNKNOWN) {
      actions.push(
        nextAction(
          '(operator action)',
          "The project does not state which test runner it uses. Set 'project.runner' so the agent never has to assume.",
        ),
      );
    }

    if (
      summary.packageManagerConfidence === Confidence.LOW ||
      summary.packageManager === 'unknown'
    ) {
      actions.push(
        nextAction(
          '(operator action)',
          "The package manager could not be established with confidence. Set 'project.packageManager'; installing with the wrong one rewrites the other's dependency tree.",
        ),
      );
    }

    if (summary.automationFrameworks.length > 0 && !summary.seleniumCompatible) {
      actions.push(
        nextAction(
          '(operator action)',
          `This build provides Selenium capabilities, but the workspace uses ${summary.automationFrameworks.join(', ')}. Use the matching GenXEvo agent for that framework.`,
        ),
      );
    }

    if (result.toolchain.installedStateSource === null) {
      actions.push(
        nextAction(
          '(operator action)',
          'No node_modules/.package-lock.json was found, so only what the project DECLARES is known, not what is installed. Install dependencies before drawing conclusions about a version mismatch.',
        ),
      );
    }

    actions.push(
      nextAction(
        'genxevo_agent_status',
        'Confirm which capabilities this build has before planning a diagnosis workflow.',
      ),
    );

    return actions;
  }
}

function describe(result) {
  const summary = result.summary;

  if (summary.testRoots.length === 0 && summary.runner === TestRunner.UNKNOWN) {
    return (
      `Scanned ${result.scan.directoriesScanned} director(ies) and ${result.scan.filesSeen} file(s), ` +
      'but found nothing that identifies a runnable JavaScript test suite.'
    );
  }

  const runner =
    summary.runner === TestRunner.UNKNOWN
      ? 'not stated by the project'
      : `${summary.runner} (confidence: ${summary.runnerConfidence})`;
  const roots = summary.testRoots.length > 0 ? summary.testRoots.join(', ') : 'none identified';
  const automation =
    summary.automationFrameworks.length > 0
      ? summary.automationFrameworks.join(', ')
      : 'none detected';

  return (
    `Package manager: ${summary.packageManager} (${summary.packageManagerConfidence}); ` +
    `module system: ${summary.moduleSystem}; test runner: ${runner}; ` +
    `test roots: ${roots} (confidence: ${summary.testRootConfidence}); automation: ${automation}.`
  );
}
