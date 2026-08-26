# Prompt — toolchain sanity

The suite behaves differently for different people, or differently on CI.

1. Call `genxevo_agent_status` and note `data.host.nodeVersion`. This is the Node
   running **GenXEvo**, not the Node running the tests. Do not confuse them.
2. Call `genxevo_discover_project` and compare four things:
   - `toolchain.declaredNodeRange` versus `toolchain.pinnedNodeVersion`, and
     where the pin came from;
   - the declared dependency versions versus `toolchain.installedNotable`;
   - `summary.packageManager` versus any `packageManager` field in the manifest;
   - the lockfiles present versus the package manager actually in use.
3. Report every mismatch as a mismatch, with both values. A declaration the
   toolchain has silently ignored is a common and expensive cause of "works on my
   machine".
4. Say which mismatch you would fix first and why. Do not fix anything yet.
