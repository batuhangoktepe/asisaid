# asisaid

**Stop repeating yourself to your coding agent.**

You say "too long". Two replies later, it's long again. You say "never use axios". After the next compaction, there's axios.

asisaid keeps your feedback in force for the whole session, for Claude Code and Codex.

![asisaid demo: after "Too long. Keep it short." every following reply stays short](docs/demo.gif)

## What it does

- **Picks up your standing rules.** "Keep it short", "never use emoji", "always run the tests": caught from what you already write. No syntax, no config.
- **Reminds the agent every turn.** One short reminder rides along with each prompt.
- **Sends back replies that break a rule.** Too long after you asked for short, or emoji after you said no emoji: the reply goes back once with a note to fix it.
- **Restores your own words after compaction.** Your rules, your decisions and the last turns, verbatim, right after the summary.

## Short mode

The feedback people repeat most is "too long". Once you ask for brevity in any form, including the implicit ones ("way too much text", "skip the explanation", "every answer is an essay", "less talk, more code", "yes or no:"), asisaid switches the session to short mode:

- Every reply comes in your language, with only what matters: the result, what you need to decide or do, and blockers.
- Code, commands, error messages and questions for you are never cut. Code blocks don't count toward the limit.
- Ask for detail in a message ("explain in detail", "walk me through") and that reply can be long.
- Say "you can be more detailed now" or "forget the brevity thing" and short mode is off.

## Install

**Claude Code**

```
/plugin marketplace add batuhangoktepe/asisaid
/plugin install asisaid@asisaid
```

**Codex**

```
codex plugin marketplace add batuhangoktepe/asisaid
codex plugin add asisaid@asisaid
```

Then approve the hooks once with `/hooks`.

**Any other agent (lite)**

```
npx skills add batuhangoktepe/asisaid
```

An instruction-only skill for Cursor, Gemini CLI, Copilot and other agents that support Agent Skills. It has no hooks, so there are no automatic checks.

## Usage

Nothing to do. Work as usual.

## What counts as a rule

| You write | asisaid |
|---|---|
| "Your answers are too long." | Short mode, every reply is checked |
| "In short, what's the fix?" | Short mode, every reply is checked |
| "Never use emoji." | Kept, and every reply is checked |
| "Always run the tests after a change." | Kept and reminded |
| "For now, just say ready." | Ignored, one-off |
| "Why is it still broken?" | Ignored, a question |
| Pasted logs or chats | Ignored, not your words |

Works in 20 languages: English, Spanish, Portuguese, French, German, Italian, Dutch, Polish, Russian, Ukrainian, Chinese, Japanese, Korean, Hindi (and Hinglish), Indonesian, Vietnamese, Arabic, Czech, Swedish and Turkish. Detection is concept-based, not keyword lists: "too + long", "skip + explanation", "every answer + essay", typo-tolerant, and it ignores requests about code or documents ("make this function shorter", "write a brief README section").

## Accuracy

Measured on a blind set of 640 developer messages in 20 languages, written without access to the detection code (`npm run eval`):

| | |
|---|---|
| Brevity requests caught | 86% |
| Code/content requests correctly ignored | 99% |
| Detail requests recognized | 96% |
| "Longer is fine again" recognized | 93% |
| Standing rules ("always", "never", "from now on") | 96% |
| One-off instructions correctly ignored | 100% |

And in 30 live sessions (English, Turkish, Spanish, German, Japanese × Haiku, Sonnet, Opus), after the user said "too long" once:

- Follow-up answers were **34% shorter** overall: 50% with Sonnet, 39% with Haiku, 5% with Opus, which already follows that feedback well on its own.
- Every reply stayed in the user's language, every code request still returned complete code, and "explain in detail" still got a long answer.

## How it works

| Hook | asisaid |
|---|---|
| `UserPromptSubmit` | Picks up new rules and adds the reminder |
| `Stop` | Checks the reply against length and emoji rules, sends it back at most once per turn |
| `PreCompact` | Snapshots your words before the summary replaces them |
| `SessionStart` (compact) | Puts them back right after the summary |

No network calls, no extra model calls, no dependencies. Requires Node.js 18+.

## Privacy

Everything stays on your machine, in the plugin's own data directory. Nothing is sent anywhere.

## Configuration

| Variable | Default | |
|---|---|---|
| `ASISAID_BRIEF_WORDS` | `120` | Word limit once you've asked for short replies |
| `ASISAID_MAX_TOKENS` | `2000` | Budget for the note restored after compaction |

## Limitations

- The check runs when the reply is finished, so the long reply is already on screen; the corrected one follows right after.
- Rules are detected without a model, so some phrasings will be missed (see Accuracy). Languages outside the 20 still get short mode, but rule detection there is weaker.
- Only length and emoji are checked automatically. Other rules are reminded every turn.

## Development

```
git clone https://github.com/batuhangoktepe/asisaid
cd asisaid
npm test
claude --plugin-dir ./plugin
```

No dependencies to install. `npm test` runs the hook tests, and `--plugin-dir` loads the plugin into a Claude Code session without installing it.

## License

[MIT](LICENSE)
