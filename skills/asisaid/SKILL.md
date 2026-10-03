---
name: asisaid
description: Keeps the user's feedback about how you work in force for the whole session. Use when the user gives feedback such as "too long", "keep it short", "no emoji", "always ...", "never ...", "from now on ...", and when resuming after compaction or in a new session.
---

# asisaid (lite)

Users repeat themselves because agents drop feedback a few turns later. Treat feedback about how you work as a standing rule, not a one-off.

## When the user gives feedback about how you work

1. Turn it into one short rule, keeping the user's own words.
2. Append it to `.asisaid/rules.md` in the project root. Create the file if it is missing. One rule per line, nothing else.
3. Acknowledge in one short sentence and apply it immediately.

Instructions limited to the current task ("for now", "this time") are not standing rules. A newer rule replaces an older one that contradicts it.

## Before every reply

Check your draft against every standing rule from this session: length, tone, language, formatting, emoji, what to ask before doing. Fix violations before sending.

## After compaction or in a new session

Read `.asisaid/rules.md` before your first reply and follow it.

## Full version

The asisaid plugin for Claude Code and Codex does this automatically with hooks: it reminds the agent of the rules every turn, sends back replies that break them, and restores the user's own words after compaction.
