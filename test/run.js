'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'plugin', 'scripts', 'asisaid.js');
const { extractRules, standingRules, violation, detectLanguage } = require(SCRIPT);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asisaid-'));
const env = { ...process.env, CLAUDE_PLUGIN_DATA: path.join(tmp, 'data') };
const run = (args, input) => execFileSync('node', [SCRIPT, ...args], { input: JSON.stringify(input), env }).toString();
const json = (args, input) => JSON.parse(run(args, input));

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };

const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (content) => ({ type: 'assistant', message: { role: 'assistant', content } });
const transcript = path.join(tmp, 's1.jsonl');
fs.writeFileSync(transcript, [
  user([{ type: 'text', text: '<system-reminder>noise</system-reminder>' }, { type: 'text', text: 'Build the login page. Never use axios, always use fetch.' }]),
  assistant([{ type: 'text', text: 'Starting with fetch.' }]),
  assistant([{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: {} }]),
  user([{ type: 'tool_result', tool_use_id: 't1', content: 'Your questions have been answered: "Which styling?"="Tailwind". You can now continue.' }]),
  user("Don't commit, I will do it myself."),
  user('This is a sidechain message', { isSidechain: true }),
  user('<command-name>/model</command-name><command-args>sonnet</command-args>'),
  user('Add a show/hide toggle to the password field.'),
  assistant([{ type: 'text', text: 'Added.' }]),
  { type: 'attachment', attachment: { type: 'queued_command', prompt: 'Make the button gray.', humanTurn: true } },
  { type: 'system', subtype: 'compact_boundary' },
  user('Previous summary...', { isCompactSummary: true }),
  user('Your answers are too long, keep it short.'),
  user('Write the tests too.'),
  assistant([{ type: 'text', text: 'Tests written.' }]),
].map((e) => JSON.stringify(e)).join('\n') + '\n');
const s1 = { session_id: 's1', transcript_path: transcript, cwd: tmp };

test('PreCompact stores a snapshot silently', () => {
  assert.strictEqual(run(['precompact'], s1), '');
});

test('SessionStart:compact restores the user\'s own words', () => {
  const out = json(['restore'], s1);
  const note = out.hookSpecificOutput.additionalContext;
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(note, /Never use axios, always use fetch\./);
  assert.match(note, /- "Don't commit, I will do it myself\."/);
  assert.match(note, /- "Your answers are too long, keep it short\."/);
  assert.match(note, /Which styling\? → Tailwind/);
  assert.match(note, /User: Write the tests too\.\nAssistant: Tests written\./);
  assert.match(note, /User: Make the button gray\./);
  assert.doesNotMatch(note, /noise|sidechain|sonnet|Previous summary/);
  assert.match(out.systemMessage, /^asisaid: restored \d+ rules, 1 decision and the last 3 turns/);
});

test('every prompt carries a short reminder, the restore is not repeated', () => {
  const out = json(['prompt'], { ...s1, prompt: 'continue' });
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /^asisaid — standing rules/);
  assert.match(ctx, /Never use axios, always use fetch\./);
  assert.match(ctx, /keep it short/);
  assert.doesNotMatch(ctx, /<asisaid>/);
  assert.strictEqual(out.systemMessage, undefined);
});

test('the next prompt carries the restore if SessionStart never ran', () => {
  run(['precompact'], s1);
  const out = json(['prompt'], { ...s1, prompt: 'continue' });
  assert.match(out.hookSpecificOutput.additionalContext, /<asisaid>/);
  assert.ok(out.systemMessage);
  assert.doesNotMatch(json(['prompt'], { ...s1, prompt: 'continue' }).hookSpecificOutput.additionalContext, /<asisaid>/);
});

test('a reply that breaks a checkable rule is sent back once per turn', () => {
  const s3 = { session_id: 's3', transcript_path: path.join(tmp, 'none.jsonl'), cwd: tmp };
  run(['prompt'], { ...s3, prompt: 'way tooooo long' });
  const long = Array(200).fill('word').join(' ');
  const out = json(['stop'], { ...s3, last_assistant_message: long });
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /tooooo long.*200 words/);
  assert.strictEqual(run(['stop'], { ...s3, last_assistant_message: long }), '');
  run(['prompt'], { ...s3, prompt: 'ok' });
  assert.strictEqual(run(['stop'], { ...s3, last_assistant_message: 'Short answer.' }), '');
});

test('a missing transcript never breaks compaction', () => {
  assert.strictEqual(run(['precompact'], { session_id: 's2', transcript_path: path.join(tmp, 'missing.jsonl') }), '');
});

test('Codex: rules and the assistant\'s last answers come from asisaid\'s own log', () => {
  const c = { session_id: 'c1', transcript_path: null, cwd: tmp };
  run(['prompt', 'codex'], { ...c, prompt: 'Never leave console.log in the code.' });
  run(['stop', 'codex'], { ...c, last_assistant_message: 'Cleaned up.' });
  run(['prompt', 'codex'], { ...c, prompt: 'Always run the tests after every change.' });
  run(['stop', 'codex'], { ...c, last_assistant_message: 'Tests pass.' });
  assert.strictEqual(run(['precompact', 'codex'], c), '');
  const note = json(['restore', 'codex'], c).hookSpecificOutput.additionalContext;
  assert.match(note, /- "Always run the tests after every change\."/);
  assert.match(note, /- "Never leave console\.log in the code\."/);
  assert.match(note, /Assistant: Tests pass\./);
  assert.doesNotMatch(note, /User:/);
  run(['precompact', 'codex'], c);
  const out = json(['prompt', 'codex'], { ...c, prompt: 'go on' });
  assert.match(out.hookSpecificOutput.additionalContext, /<asisaid>/);
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /go on/);
});

test('standing rules: one-off and pasted text are ignored', () => {
  assert.deepStrictEqual(
    standingRules("End every answer with OK. Never use emoji. For now just say 'ready'."),
    ['End every answer with OK.', 'Never use emoji.'],
  );
  assert.deepStrictEqual(standingRules('Keep it short from now on. Fix the login bug.'), ['Keep it short from now on.']);
  assert.deepStrictEqual(standingRules('why is it still broken?'), []);
  assert.deepStrictEqual(standingRules('<pasted_content id="1">Never use emoji.</pasted_content id="1"> did it work'), []);
});

test('brevity asks are caught in many phrasings, code requests are not', () => {
  const caught = ['In short, what is the fix', 'tl;dr please', 'TLDR', 'be concise', 'answer briefly', 'keep it short', 'way too long',
    'explain it in 2 sentences', 'get to the point', 'shorter answers please', 'no fluff'];
  for (const s of caught) assert.ok(violation([s], Array(300).fill('w').join(' ')), s);
  const ignored = ['make the function shorter', 'use a shorter variable name', 'summarize this file', 'the short-term plan'];
  for (const s of ignored) assert.strictEqual(violation([s], Array(300).fill('w').join(' ')), null, s);
});

test('brevity asked as a question still counts', () => {
  assert.deepStrictEqual(standingRules("In short, what's the fix?"), ["In short, what's the fix?"]);
  assert.deepStrictEqual(standingRules('For now, keep it short.'), ['For now, keep it short.']);
});

test('short mode: directive in the user\'s language, detail requests and lifting are respected', () => {
  const s = { session_id: 's4', transcript_path: path.join(tmp, 'none.jsonl'), cwd: tmp };
  const ctx = (prompt) => json(['prompt'], { ...s, prompt }).hookSpecificOutput.additionalContext;
  const long = Array(300).fill('word').join(' ');

  assert.match(ctx('Your answers are way too long for me.'), /Reply in English\. Put the answer in the first line, then at most 5 .*Keep every specific/);
  assert.strictEqual(json(['stop'], { ...s, last_assistant_message: long }).decision, 'block');

  assert.match(ctx('Explain the caching layer in detail, please.'), /asked for detail in this message/);
  assert.strictEqual(run(['stop'], { ...s, last_assistant_message: long }), '');

  assert.match(ctx('What changed in the build?'), /Put the answer in the first line/);
  const out = json(['stop'], { ...s, last_assistant_message: long });
  assert.match(out.reason, /Write it again in English: the answer in the first line, then at most 5 bullets.*Keep every specific/);
  assert.doesNotMatch(out.reason, /only saw the start/);

  assert.strictEqual(run(['prompt'], { ...s, prompt: 'You can be more detailed from here on.' }), '');
  assert.strictEqual(run(['stop'], { ...s, last_assistant_message: long }), '');
});

test('on screen, a long reply is cut at the limit and rewritten once', () => {
  const s = { session_id: 's6', transcript_path: path.join(tmp, 'none.jsonl'), cwd: tmp };
  run(['prompt'], { ...s, prompt: 'keep it short please' });
  const DISPLAY = path.join(__dirname, '..', 'plugin', 'scripts', 'display.js');
  const show = (input) => execFileSync('node', [DISPLAY], { input: JSON.stringify({ ...s, ...input }), env }).toString();
  const line = (n) => Array(n).fill('word').join(' ') + '\n';
  assert.strictEqual(show({ message_id: 'm1', index: 0, delta: line(100) }), '');
  const cut = JSON.parse(show({ message_id: 'm1', index: 1, delta: line(50) })).hookSpecificOutput.displayContent;
  assert.strictEqual(cut.split(/\s+/).filter((w) => w === 'word').length, 20);
  assert.match(cut, /asisaid: shortening/);
  assert.strictEqual(JSON.parse(show({ message_id: 'm1', index: 2, delta: line(30) })).hookSpecificOutput.displayContent, '');
  const out = json(['stop'], { ...s, last_assistant_message: line(180) });
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /only saw the start of your last reply/);
  assert.strictEqual(show({ message_id: 'm2', index: 0, delta: line(300) }), '');
});

test('on screen: code blocks are not counted and new messages start fresh', () => {
  const s = { session_id: 's7', transcript_path: path.join(tmp, 'none.jsonl'), cwd: tmp };
  run(['prompt'], { ...s, prompt: 'be concise' });
  const DISPLAY = path.join(__dirname, '..', 'plugin', 'scripts', 'display.js');
  const show = (input) => execFileSync('node', [DISPLAY], { input: JSON.stringify({ ...s, ...input }), env }).toString();
  const code = '```js\n' + Array(400).fill('x').join(' ') + '\n```\n';
  assert.strictEqual(show({ message_id: 'a', index: 0, delta: 'Here:\n' + code }), '');
  assert.strictEqual(show({ message_id: 'a', index: 1, delta: Array(100).fill('w').join(' ') + '\n' }), '');
  assert.strictEqual(show({ message_id: 'b', index: 0, delta: Array(110).fill('w').join(' ') + '\n' }), '');
  run(['prompt'], { ...s, prompt: 'now explain the cache in detail' });
  assert.strictEqual(show({ message_id: 'c', index: 0, delta: Array(500).fill('w').join(' ') + '\n' }), '');
});

test('a complaint about missing details is not a request for detail', () => {
  const { classify } = require(SCRIPT);
  assert.strictEqual(classify('your short answers keep missing important details').detail, false);
  assert.strictEqual(classify('explain the cache in detail').detail, true);
});

test('Stop falls back to the transcript when the reply text is not passed', () => {
  const file = path.join(tmp, 's5.jsonl');
  fs.writeFileSync(file, [
    user('keep it short'),
    assistant([{ type: 'tool_use', id: 'x', name: 'Read', input: {} }]),
    user([{ type: 'tool_result', tool_use_id: 'x', content: 'file' }]),
    assistant([{ type: 'text', text: Array(300).fill('word').join(' ') }]),
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const s = { session_id: 's5', transcript_path: file, cwd: tmp };
  run(['prompt'], { ...s, prompt: 'keep it short' });
  assert.strictEqual(json(['stop'], s).decision, 'block');
});

test('language detection', () => {
  assert.strictEqual(detectLanguage('What changed in the build?'), 'English');
  assert.strictEqual(detectLanguage('ok'), null);
});

test('rules detected for the compaction note', () => {
  assert.deepStrictEqual(
    extractRules([{ user: 'End every answer with OK. Never use emoji."' }, { user: 'Add a test for every change.' }, { user: 'hi' }]),
    ['End every answer with OK.', 'Never use emoji.', 'Add a test for every change.'],
  );
});

test('checks: length, emoji, code blocks do not count', () => {
  assert.strictEqual(violation(['Never use emoji.'], 'Done 👍').why, 'it contains emoji');
  assert.strictEqual(violation(['Never use emoji.'], 'Done'), null);
  assert.strictEqual(violation(['keep it short'], '```\n' + Array(500).fill('x').join(' ') + '\n```\nDone.'), null);
});

console.log(`\n${passed} passed`);
