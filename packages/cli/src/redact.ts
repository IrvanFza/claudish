/**
 * Redaction for diagnostics.
 *
 * Two levels, because two different things are being protected:
 *
 *   redactSecrets()     — credentials ONLY. For text that stays on this machine
 *                         but WILL be read by an agent: on-disk error logs,
 *                         status.json snippets. Paths and emails are the user's
 *                         own and redacting them makes a local debug log worse,
 *                         so they are left alone here.
 *
 *   sanitizeForReport() — credentials AND personal data. For anything LEAVING
 *                         the machine (the `report_error` tool). Home directory
 *                         paths and email addresses identify the user, so they go.
 *
 * Conflating the two is how the old single `sanitize()` ended up simultaneously
 * too weak (it knew only `sk-` keys, so it missed Google, xAI, JWTs, and every
 * `_TOKEN`/`_SECRET`/`_KEY` variable) and too aggressive (it scrubbed `/Users/…`
 * out of logs that never leave the machine).
 */

/** What a redacted value is replaced with. Distinctive so it greps cleanly. */
const MASK = "***REDACTED***";

/**
 * Values that are obviously instructional placeholders, not real secrets.
 *
 * claudish's own credential errors say `export ZHIPU_API_KEY='your-key-here'`.
 * Redacting that turns actionable help into noise, so these are passed through.
 */
/*
 * Anything beginning with "your" is instructional, not a credential — no real
 * key starts that way. Enumerating exact phrases was too narrow: it covered
 * `your-key-here` but not the bare `your-key`, so claudish's own remediation
 * line `export GEMINI_API_KEY=your-key  (for google)` came back as
 * `=***REDACTED***`, turning the fix instructions into noise.
 */
const PLACEHOLDER =
  /^(['"`]?)(your[-_a-z0-9]*|<[^>]*>|\.\.\.|x{3,}|\*{3,}|REDACTED|CHANGEME|TODO|\$\{[^}]*\}|)(['"`]?)$/i;

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value.trim());
}

/**
 * `NAME=value` / `NAME: value` / `"NAME": "value"` where NAME looks like a
 * credential holder. Covers _API_KEY, _KEY, _TOKEN, _SECRET, _PASSWORD — the old
 * pattern matched only `_API_KEY=`, so GEMINI_CLIENT_SECRET, ANTHROPIC_AUTH_TOKEN,
 * OP_SERVICE_ACCOUNT_TOKEN and every CUSTOM_*_KEY leaked through.
 */
/*
 * The value alternation tries `${VAR}` FIRST. Without that branch the generic
 * class stops at `}` and captures a truncated `${VAR`, which then fails the
 * placeholder check and gets masked — leaving a corrupted `KEY=***REDACTED***}`.
 * claudish's own customEndpoints config uses `"apiKey": "${VLLM_API_KEY}"`, so
 * echoing config would have been mangled.
 */
const ASSIGNMENT_RE =
  /(["']?\b[A-Z][A-Z0-9_]*(?:_API_KEY|_KEY|_TOKEN|_SECRET|_PASSWORD)\b["']?\s*[:=]\s*)(["'`]?\$\{[^}]*\}["'`]?|["'`]?[^\s"'`,}]+["'`]?)/g;

/**
 * Known credential shapes, matched on their vendor prefix so a bare value is
 * caught even without a variable name attached.
 *
 * Derived from the providers claudish actually routes to; `sk-` alone (the old
 * behaviour) covers only OpenAI-family keys.
 */
const TOKEN_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // OpenAI / Anthropic / OpenRouter / Moonshot — sk-, sk-ant-, sk-or-v1-
  { name: "sk", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  // Google AI Studio / Gemini
  { name: "google", re: /\bAIza[A-Za-z0-9_-]{20,}/g },
  // xAI
  { name: "xai", re: /\bxai-[A-Za-z0-9_-]{16,}/g },
  // GitHub personal / OAuth / server / user / refresh tokens
  { name: "github", re: /\bgh[posur]_[A-Za-z0-9]{20,}/g },
  // AWS access key id
  { name: "aws", re: /\bAKIA[0-9A-Z]{12,}/g },
  // JWT (MiniMax and friends issue these as keys). Three base64url segments.
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // Zhipu / GLM: <32 hex>.<16 alnum>
  { name: "zhipu", re: /\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/g },
  // Authorization headers of any scheme
  { name: "bearer", re: /\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9_.\-+/=]{12,}/g },
];

/**
 * Strip credentials from text. Safe to run on anything; never throws.
 *
 * Deliberately does NOT do blanket high-entropy matching — that would redact
 * legitimate content (hashes, base64 payloads, model ids) and make logs
 * untrustworthy. Known shapes plus named assignments cover the real cases.
 */
export function redactSecrets(text: string | undefined | null): string {
  if (!text) return "";
  let out = text;

  // Named assignments first, so `FOO_API_KEY=sk-abc…` is masked once as a whole
  // rather than leaving a dangling `FOO_API_KEY=` next to a separate mask.
  out = out.replace(ASSIGNMENT_RE, (match, lhs: string, value: string) =>
    isPlaceholder(value) ? match : `${lhs}${MASK}`
  );

  for (const { re } of TOKEN_PATTERNS) {
    out = out.replace(re, (match) => {
      // Preserve the scheme word on Authorization headers so the log still
      // shows WHICH auth scheme was used.
      const scheme = /^(Bearer|Basic|Token)\s/.exec(match);
      return scheme ? `${scheme[1]} ${MASK}` : MASK;
    });
  }

  return out;
}

/**
 * Full sanitization for data leaving this machine: credentials plus the personal
 * details that identify the user.
 */
export function sanitizeForReport(text: string | undefined | null): string {
  if (!text) return "";
  return (
    redactSecrets(text)
      // Home directories carry the username.
      .replace(/\/Users\/[^/\s]+/g, "/Users/***")
      .replace(/\/home\/[^/\s]+/g, "/home/***")
      .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, "C:\\Users\\***")
      // Email addresses.
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "***@***.***")
  );
}
