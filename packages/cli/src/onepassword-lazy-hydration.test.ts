import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// REGRESSION: claudish --version triggered 1Password resolution because
// hydrateOpSecrets ran before parseArgs. AND: a keyless/local model (ollama@) or
// an already-satisfied key still resolved the whole op:// config. Fixed by (1)
// moving hydration to the point of need (after parseArgs), and (2) making it
// PER-CREDENTIAL — hydrate only when a routed model's required key is missing,
// resolving op:// for ONLY those env vars.
//
// This is a STRUCTURAL ordering test. The full CLI can't be driven in a unit
// test (it spawns Claude, exits the process inside parseArgs, etc.). The
// invariants enforced here:
//   (a) hydrateOpSecrets is NOT called before parseArgs (terminal flags exit first)
//   (b) hydrateOpSecrets is called AFTER validateApiKeysForModels (validate-first)
//   (c) hydration is GUARDED by neededEnvVars (per-credential: skipped when no
//       routed model needs a missing key)

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(__dirname, "index.ts"), "utf-8");

/**
 * Extract the body of the runCli function via brace matching, starting at the
 * `async function runCli()` declaration.
 */
function extractRunCliBody(source: string): string {
  const declIdx = source.indexOf("async function runCli()");
  expect(declIdx).toBeGreaterThanOrEqual(0);

  // Find the opening brace of the function body.
  const openBraceIdx = source.indexOf("{", declIdx);
  expect(openBraceIdx).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let i = openBraceIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(openBraceIdx, i + 1);
      }
    }
  }
  throw new Error("Could not find matching close brace for runCli()");
}

describe("1Password lazy hydration ordering", () => {
  const runCliBody = extractRunCliBody(indexSource);

  it("calls hydrateOpSecrets AFTER parseArgs() inside runCli (not before)", () => {
    const parseArgsIdx = runCliBody.indexOf("await parseArgs(");
    expect(parseArgsIdx).toBeGreaterThanOrEqual(0);

    // The call now takes an argument: hydrateOpSecrets(neededEnvVars).
    const firstHydrateIdx = runCliBody.indexOf("hydrateOpSecrets(");
    expect(firstHydrateIdx).toBeGreaterThanOrEqual(0);

    // The FIRST hydrateOpSecrets call inside runCli must occur AFTER parseArgs()
    // so terminal flags (--version/--help/--init/--probe/--list-models) exit the
    // process before any 1Password resolution.
    expect(firstHydrateIdx).toBeGreaterThan(parseArgsIdx);
  });

  it("calls hydrateOpSecrets AFTER validating keys (validate-first / per-credential)", () => {
    const validateIdx = runCliBody.indexOf("validateApiKeysForModels(");
    expect(validateIdx).toBeGreaterThanOrEqual(0);

    const firstHydrateIdx = runCliBody.indexOf("hydrateOpSecrets(");
    expect(firstHydrateIdx).toBeGreaterThanOrEqual(0);

    // Validation must run BEFORE hydration so we know which env vars are actually
    // needed-and-missing — only then do we touch 1Password (and only for those).
    expect(firstHydrateIdx).toBeGreaterThan(validateIdx);
  });

  it("guards hydration on neededEnvVars (per-credential — keyless/satisfied skip it)", () => {
    // The hydration call must be passed a neededEnvVars set AND be reached only
    // when that set is non-empty (so ollama@/local and already-set keys skip it).
    expect(runCliBody).toContain("hydrateOpSecrets(neededEnvVars)");
    expect(runCliBody).toContain("neededEnvVars.size > 0");
  });
});
