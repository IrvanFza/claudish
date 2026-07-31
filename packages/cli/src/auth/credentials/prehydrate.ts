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
 * Pre-hydration is the cheap path, not the whole fix. It covers the keys
 * 1Password CAN supply, at every spawn site claudish owns. Two other gaps are
 * handled elsewhere:
 *
 *   · Keys 1Password does NOT hold still send each child to the SDK →
 *     `publishOpSkipList` below tells children not to bother.
 *   · Two INDEPENDENT claudish processes launched at the same instant by
 *     unrelated sessions cannot be reached by any parent/child protocol →
 *     `providers/onepassword-handshake-lock.ts` serializes the handshake
 *     across processes.
 */

import { getOpFailures } from "../../providers/onepassword.js";
import { validateApiKeysForModels } from "../../providers/provider-resolver.js";
import { OP_UNAVAILABLE_ENV, getOpUnavailableVars } from "./op-source.js";

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
    publishOpSkipList();
  } catch {
    // Non-fatal by contract — see above.
  }
}

/**
 * Tell children which env vars 1Password answered it does NOT hold, so they
 * skip the SDK for those entirely.
 *
 * Pre-hydration alone cannot silence the race. It hands children every key
 * 1Password CAN supply — but a bare model name filters a CHAIN, and each child
 * walks that chain from the top. The candidates 1Password has nothing for are
 * still a miss in env, so each child opens its own SDK client for them, all at
 * the same instant. Observed in ai-docs/sessions/opverify3: 3/3 models
 * succeeded on inherited keys, and two children still logged
 * "Denied authorization for SDK client" chasing a key that does not exist.
 *
 * ONLY published when the run recorded NO op failures. A denial also produces
 * an empty resolve, and publishing that would teach every child that a key the
 * user really does store in 1Password is permanently absent — turning one
 * transient denial into a run-wide outage. With failures present we publish
 * nothing and children behave exactly as before.
 */
function publishOpSkipList(): void {
  if (getOpFailures().length > 0) return;
  const unavailable = getOpUnavailableVars();
  if (unavailable.length === 0) return;
  process.env[OP_UNAVAILABLE_ENV] = unavailable.join(",");
}
