# Picker release — open findings (2026-09-23)

Defects and decisions still open when the OpenTUI picker shipped in v10.1.0. Each was
re-checked against the code on the release candidate, not carried over from notes.

## 1. Realtime models return to the Codex list — a decision, not a bug

The picker once excluded `gpt-live-1` and the `gpt-realtime-*` family from the OpenAI Codex
list, because the owner saw them offered as launchable coding models. Since v10.0.0 the cloud
models catalog decides chat capability first (`classifyChatCapability`,
`providers/transport/probe-discovery.ts`), and it publishes these ids with output modalities
`["audio","text"]`. The classifier's rule is "output INCLUDES text → chat model", so on any
machine with the v3 catalog cached they are offered again. The name rules that excluded them
now run only for models the catalog does not describe.

Two statements in the repository disagree about which answer is right:

- the classifier's comment: *"`["audio", "text"]` speaks AND writes, so it can answer a chat
  turn"*;
- the thesaurus in `CLAUDE.md`: a chat model *"takes text in and gives only text out"*.

Settling it means choosing one and changing the other. What was observed, on catalog
generation `g-20260923015912067-d8c0c200`: the `gpt-realtime-*` catalog description says
"realtime VOICE interactions ... audio and text inputs over WebRTC, WebSocket, or SIP"; and
36 of the 1000 rows read (the first page of 1137) publish an output list containing both
`audio` and `text` — the `gpt-realtime-*` family and `gpt-live-1`, `gpt-audio` and
`gpt-audio-mini`, Qwen omni, audio and livetranslate models (realtime and not), and Google
Lyria. Whether those answer an ordinary `/v1/chat/completions` turn was NOT tested. A rule on
output modality alone treats all 36 identically, so choosing "only text" drops every one.

## 2. The config TUI's status strip has no error tier

`tui/components/TabBar.tsx:68` colours a status message green when the string starts with one
of a fixed list of prefixes (`"Key saved"`, `"Rule added"`, …) and yellow otherwise. There is
no red tier, so a hard failure and a routine save differ only between yellow and green. Choosing
severity by the prefix of a human sentence also breaks silently when a message is reworded.
Pre-existing; the picker did not touch it. The picker's `ErrorBanner` three-tier model is the
shape a fix would reuse.

## 3. `--free` always throws

`getFreeModels` (`model-selector.ts:521`) is a stub returning `[]`, and `selectModel` throws
`"No free models available"` whenever `--free` is set. The flag is reachable from the CLI, and
the catalog does carry free models (`FREE` rows are visible in the picker), so the data exists
while the feature does not. Implement it against the catalog's free rows, or remove the flag.

## 4. One unreproduced test failure

`ModelPicker.test.tsx` "has EXACTLY ONE cursor" failed once in about 23 runs of the file,
on the first run after that file's module was rewritten on disk, and passed the next 20 runs,
including 12 in isolation. No failure message was captured, so whether it saw 0 cursors (a
frame caught before paint — timing) or 2 (a real defect) is unknown. If it recurs, capture the
assertion message before touching the test.

## 5. No test pins the `video` rule's removal

During the v10 merge, a `\bvideo\b` rule this branch had added to `NON_CHAT_PATTERNS` was
removed: it ran before the `videoOutputKnown` guard and would have excluded a model that only
READS video despite a published `videoOutput: false`. No row in the real catalog has the shape
that distinguishes the two behaviours (video in the name, `videoOutput` published, no output
modality list), so no test pins it, and a hand-built fixture would break the rule that
fixtures come from real data. Add the test when such a row exists.
