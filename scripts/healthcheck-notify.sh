#!/bin/bash
# healthcheck-notify.sh — send the health-check verdict to Jack, from the Mac itself.
#
#   scripts/healthcheck-notify.sh <run-dir> <exit-code>
#   scripts/healthcheck-notify.sh --test        # send a fake alert to prove wiring
#
# Deliberately has NO dependency on Cowork, Claude, or any cloud service: the
# whole point of moving this job to launchd was that it keeps working when none
# of that is reachable. Everything here is curl and the macOS Keychain.
#
# CREDENTIALS come from the login keychain, never from a file in the repo and
# never from the environment (launchd jobs have no useful environment anyway):
#
#   Slack incoming webhook:
#     security add-generic-password -a "$USER" -s claudish-health-slack -w 'https://hooks.slack.com/services/...'
#
#   Gmail app password, for the email copy (optional):
#     security add-generic-password -a "$USER" -s claudish-health-smtp -w 'your-16-char-app-password'
#
# Either credential being absent is not an error — that channel is simply
# skipped and noted in the log. A health check that fails to alert should still
# leave a report behind, so nothing here is allowed to abort the run.
set -u

REPO="$HOME/mag/claudish"
EMAIL_TO="jack.rudenko@10xlabs.com.au"
EMAIL_FROM="jack.rudenko@10xlabs.com.au"
SMTP_URL="smtps://smtp.gmail.com:465"

kc() { security find-generic-password -a "$USER" -s "$1" -w 2>/dev/null; }

notify_mac() {
  # Always available, needs no credential, and is the one channel that works
  # even with no network. Fire it first so something lands regardless.
  osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1
}

post_slack() {
  local text="$1" hook
  hook="$(kc claudish-health-slack)"
  if [ -z "$hook" ]; then echo "[notify] no Slack webhook in keychain (claudish-health-slack) — skipped"; return 0; fi
  # --data-binary with a heredoc-built JSON file avoids every quoting trap that
  # comes with embedding a multi-line report in an inline -d argument.
  local payload; payload="$(mktemp)"
  python3 - "$text" > "$payload" <<'PY'
import json,sys
print(json.dumps({"text": sys.argv[1]}))
PY
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
          --data-binary @"$payload" --max-time 25 "$hook" 2>&1)
  rm -f "$payload"
  echo "[notify] slack http $code"
}

send_email() {
  local subject="$1" body="$2" pass
  pass="$(kc claudish-health-smtp)"
  if [ -z "$pass" ]; then echo "[notify] no SMTP app password in keychain (claudish-health-smtp) — skipped"; return 0; fi
  local msg; msg="$(mktemp)"
  {
    echo "From: $EMAIL_FROM"
    echo "To: $EMAIL_TO"
    echo "Subject: $subject"
    echo "Content-Type: text/plain; charset=utf-8"
    echo
    echo "$body"
  } > "$msg"
  curl -sS --url "$SMTP_URL" --ssl-reqd \
       --mail-from "$EMAIL_FROM" --mail-rcpt "$EMAIL_TO" \
       --upload-file "$msg" --user "$EMAIL_FROM:$pass" --max-time 40 \
    && echo "[notify] email sent" || echo "[notify] email FAILED"
  rm -f "$msg"
}

if [ "${1:-}" = "--test" ]; then
  notify_mac "claudish health TEST" "Alert wiring test - not a real failure."
  post_slack ":test_tube: *claudish health check - wiring test*
This is not a real failure. If you can read this, the Slack path works."
  send_email "claudish health: wiring test" "Not a real failure. If you can read this, the email path works."
  exit 0
fi

RUN_DIR="${1:-}"
CODE="${2:-1}"
[ -d "$RUN_DIR" ] || { echo "[notify] no run dir '$RUN_DIR'"; exit 1; }

# Everything below is read out of result.json rather than recomputed, so the
# alert can never disagree with the report sitting next to it.
read -r BROKEN NEWIDS NEWPROV HEADLINE <<EOF2
$(python3 - "$RUN_DIR/result.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
broken=d.get("brokenCount",0)
newids=",".join(d.get("newlyBrokenIds") or []) or "-"
newprov=",".join(d.get("newlyBrokenProviders") or []) or "-"
print(broken, newids, newprov, d.get("modelCount",0))
PY
)
EOF2

if [ "$CODE" -eq 0 ]; then
  echo "[notify] clean run - staying quiet by design"
  exit 0
fi

DETAIL="$(sed -n '/## Failure detail/,$p' "$RUN_DIR/report.md" | head -60)"
SUMMARY="$(head -8 "$RUN_DIR/report.md")"

notify_mac "claudish health check FAILED" "$BROKEN of $HEADLINE models failed. New: $NEWIDS"

post_slack ":rotating_light: *claudish provider health - $BROKEN of $HEADLINE models failed*
Newly broken models: \`$NEWIDS\`
Newly broken providers: \`$NEWPROV\`

\`\`\`
$DETAIL
\`\`\`
Report: \`$RUN_DIR/report.md\`"

send_email "claudish health: $BROKEN model(s) failed" "$SUMMARY

$DETAIL

Full report: $RUN_DIR/report.md"
