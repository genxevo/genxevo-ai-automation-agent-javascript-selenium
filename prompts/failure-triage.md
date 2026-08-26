# Prompt — failure triage

A test is failing. Find the cause; do not guess at one.

1. Call `genxevo_agent_status`, then `genxevo_discover_project`. Confirm this is
   a Selenium project (`summary.seleniumCompatible`). If it is not, stop and say
   so — advice tuned for Selenium applied to another framework is worse than no
   advice.
2. Establish, from evidence rather than assumption:
   - which runner would execute this test, and from which config;
   - which test root the failing file sits under;
   - whether the page objects it uses are in a directory GenXEvo classified as
     page objects, and with what confidence.
3. State the three most likely causes **ranked**, and for each one name the
   specific observation that supports it and the specific observation that would
   refute it.
4. Where you have no evidence, say "I have no evidence for this" rather than
   filling the gap. GenXEvo returns `unknown` deliberately; do not launder an
   `unknown` into a conclusion.
5. Do not propose a fix until I have confirmed which cause to pursue.

Note: this build cannot run tests. Execution arrives in phase 1D. If a step needs
a run, say so instead of pretending to have made one.
