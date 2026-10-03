# Privacy

asisaid runs entirely on your machine. It makes no network calls, sends no telemetry and calls no model.

## What it reads

- The messages you send in the session, the agent's last reply, and the session transcript file that Claude Code or Codex passes to the plugin's hooks.

## What it stores

- The standing rules it picked up from your messages (for example "keep it short").
- A short note it puts back after compaction.
- In Codex only, a log of your messages and the agent's last answers, because Codex does not give hooks a readable transcript.

Everything is written to the plugin's own data directory on your machine, readable only by your user account.

## What it sends

Nothing. The only output goes back to your local Claude Code or Codex session as hook context.

## Deleting your data

Uninstalling the plugin deletes its data directory. You can also delete it any time:

- Claude Code: `~/.claude/plugins/data/asisaid-asisaid`
- Codex: the plugin's data directory under `~/.codex`
- Fallback when neither is set: `~/.asisaid`

## Contact

Open an issue at https://github.com/batuhangoktepe/asisaid/issues
