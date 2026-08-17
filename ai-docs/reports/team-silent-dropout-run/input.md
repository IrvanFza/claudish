You are one member of a review panel. Follow these steps in order.

**Step 1 — start background work FIRST.** Before anything else, launch a background
subagent using the Task tool with `run_in_background: true` and
`subagent_type: "general-purpose"`, giving it this task:

    "List every .ts file under packages/cli/src/ that has the word 'timeout' in it,
     then count them and report the number. Take your time and be thorough."

Do NOT wait for that agent. Move straight on to step 2 while it runs.

**Step 2 — write your review.** Read `packages/cli/src/team-orchestrator.ts` and write a
detailed review of its output-classification logic (the `classifyRunOutput` function and
the `ModelState` type). Your review must be **at least 800 words** and must cover:

- what signals it uses to decide a run succeeded
- what failure modes those signals can and cannot detect
- whether exit code 0 is a sound success oracle here
- one concrete scenario it would misclassify

**Step 3 — end with a vote.** Your response MUST end with a fenced block in exactly this
form, and nothing after it:

```vote
VERDICT: APPROVE
CONFIDENCE: 8
SUMMARY: one sentence
```

Use REJECT instead of APPROVE if you think the logic is unsound.

Do not stop early. Do not ask questions. Produce the full review and the vote block.
