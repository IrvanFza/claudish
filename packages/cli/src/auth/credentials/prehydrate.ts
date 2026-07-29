/**
 * prehydrate — resolve provider credentials in the PARENT before spawning
 * child `claudish` processes.
 *
 * WHY THIS EXISTS
 *
 * The 1Password SDK's DesktopAuth handshake is arbitrated by the desktop app
 * across the whole MACHINE, not per process: it authorizes ONE client and
 * instantly denies every concurrent peer with
 *
 *   "Denied authorization for SDK client"
 *
 * claudish already serializes SDK calls WITHIN a process (`runSdkExclusive` in
 * op-source.ts — the -4 IPC fix), but `team` and channel `create_session` spawn
 * N sibling PROCESSES, and no in-process queue can span those. Each child
 * constructs its own SDK client and they all race.
 *
 * Measured on a 7-model `team` run (session team-20260729-163623): all seven
 * children spawned within 6ms, five hit the denial, and only the models whose
 * key happened to be in the shell env survived. Reduced repro: 6 children in a
 * tight loop → 5 denied; the same 6 staggered 4s apart → 0 denied.
 *
 * The denial is swallowed by `onAuthFailure: "skip"` (correct — a bad op source
 * must never lock the user out), so the child dies with a bare
 * "X API Key is required", which reads as "claudish ignored my 1Password setup".
 *
 * THE FIX
 *
 * Do in the parent, ONCE, what each child would otherwise do N times in
 * parallel. `validateApiKeysForModels` runs every model through the credential
 * authority, and the authority write-throughs each resolved op:// key into
 * `process.env` (api-key-credential.ts). Spawned children inherit `process.env`,
 * so they find the key in step 1 of the resolution chain and never construct an
 * SDK client at all — exactly the state the surviving models were already in.
 *
 * The parent's own resolution is serialized by the existing op queue, and a
 * 1Password Environment is fetched once per process (single-flight), so this
 * costs ONE handshake regardless of how many models are being spawned.
 *
 * Note this does not cover two INDEPENDENT claudish processes launched at the
 * same instant by unrelated sessions — that would need a cross-process lock.
 * It covers every spawn site claudish itself owns.
 */

import { validateApiKeysForModels } from "../../providers/provider-resolver.js";

/**
 * Resolve credentials for `models` into `process.env` before spawning children.
 *
 * Cheap and safe to call unconditionally: with no 1Password source configured
 * the sync sniff (`hasOpSources`) short-circuits without importing the SDK, and
 * any provider whose key is already in env never reaches 1Password either.
 *
 * NEVER THROWS. Pre-hydration is an optimization of WHERE resolution happens,
 * not a gate on whether the spawn proceeds — a credential that cannot be
 * resolved here simply stays missing, and the child reports it exactly as
 * before. Failing the spawn on a pre-hydration error would turn a soft
 * "this one model has no key" into a hard "the whole team run died".
 */
export async function prehydrateCredentialsForSpawn(models: (string | undefined)[]): Promise<void> {
  const wanted = models.filter((m): m is string => !!m);
  if (wanted.length === 0) return;
  try {
    await validateApiKeysForModels(wanted);
  } catch {
    // Non-fatal by contract — see above.
  }
}
