#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_TOKENS = parseInt(process.env.ASISAID_MAX_TOKENS || '', 10) || 2000;
const BRIEF_WORDS = parseInt(process.env.ASISAID_BRIEF_WORDS || '', 10) || 120;
const CHARS_PER_TOKEN = 3.5;
const BUDGET = Math.floor(MAX_TOKENS * CHARS_PER_TOKEN);
const TAIL_TURNS = 3;
const MAX_RULES = 25;
const MAX_ACTIVE = 6;
const PENDING_TTL_MS = 6 * 60 * 60 * 1000;
const OPEN = '<asisaid>';
const CLOSE = '</asisaid>';

const SETTING_COMMANDS = /^\/(model|config|permissions|effort|theme|login|logout|resume|clear|cost|status|usage|fast|output-style|plugin|mcp|hooks|agents|memory|doctor|help|exit)\b/;

const RULES = {
  en: [
    /\b(?:don'?t|do not|never|always|must(?:n'?t)?|should(?:n'?t| not)|stop|avoid|instead|prefer|make sure|remember|from now on|no more|only use|use only|not allowed|wrong)\b/i,
    /\b(?:every|each) (?:time|response|reply|answer|message|change|commit|step)\b/i,
    /\b(?:too (?:long|short|verbose|much)|shorter|keep it (?:short|brief|simple)|be (?:brief|concise)|not what I (?:asked|meant|said)|I (?:said|told you)|as I said|ask me|ask before|without asking|don'?t assume|together|step by step)\b/i,
  ],
  tr: [
    /(?<!\p{L})(?:asla|hiçbir zaman|hiç bir zaman|her zaman|hep|mutlaka|sakın|yerine|hayır|yanlış|olmaz|olmasın|istemiyorum|istemem|unutma|bundan sonra|dikkat et|sadece|yalnızca|gerek yok|tercih)(?!\p{L})/iu,
    /(?<!\p{L})(?:yapma|etme|kullanma|dokunma|silme|ekleme|değiştirme|atma|gönderme|çalıştırma|kurma|bozma|elleme|yazma)(?!\p{L})/iu,
    /(?<!\p{L})\p{L}+(?:mayın|meyin|masın|mesin|mamalı\p{L}*|memeli\p{L}*|malısın|melisin|malıyız|meliyiz|madan|meden)(?!\p{L})/iu,
    /(?<!\p{L})her (?:cevap|cevab|yanıt|mesaj|seferinde|defasında|adım|değişiklik|commit)\p{L}*/iu,
    /(?<!\p{L})(?:çok uzun|çok kısa|kısa yaz|kısa tut|daha kısa|daha basit|uzatma|abartma|gereksiz|baştan savma|beğenmedim|sevmedim|böyle değil|öyle değil|bu değil|demedim|dememiştim|demiştim|söylemiştim|zaten söyledim|anlamadın|yanlış anladın|bana sor|önce sor|sor|beraber|birlikte|kendi başına|tek başına|adım adım)(?!\p{L})/iu,
  ],
};

const STANDING = {
  en: [/\b(?:always|never|from now on|every (?:time|response|reply|answer|message)|each (?:time|response|reply|answer))\b/i],
  tr: [/(?<!\p{L})(?:asla|hiçbir zaman|hiç bir zaman|her zaman|hep|bundan sonra|her (?:cevap|cevab|yanıt|mesaj|seferinde)\p{L}*)(?!\p{L})/iu],
};

const BREVITY = {
  en: [/(?:\b(?:too long|too verbose|too wordy|too much text|wall of text|in short|in brief|briefly|be (?:brief|concise|short)|keep it (?:short|brief|concise|tight)|(?:shorter|brief|concise|short) (?:answers?|repl(?:y|ies)|responses?|version)|(?:answer|reply|respond|write|explain) (?:briefly|shortly|concisely)|in (?:one|a few|two|three|1|2|3) (?:lines?|sentences?|words)|no fluff|less text|fewer words|(?:get|straight) to the point|just the answer|shorter please|stop rambling)\b|\btl;?dr\b)/i],
  tr: [/(?<!\p{L})(?:çok uzun|uzun yazma|uzun yazıyorsun|çok yazıyorsun|uzatma|lafı uzatma|kısa yaz|kısa tut|kısa kes|kısa ve öz|kısa ve net|kısaca|kısacası|daha kısa (?:yaz|anlat|tut|cevap|ol)|(?:cevab|yanıt|mesaj|yazı)\p{L}* kısalt|tek cümle|bir cümle|birkaç cümle|birkaç kelime|net söyle|direkt söyle|özet geç)\p{L}*/iu],
};

const ONE_OFF = {
  en: [/\b(?:for now|right now|this time)\b/i],
  tr: [/(?<!\p{L})(?:şimdilik|şimdi|bu sefer|bu seferlik)(?!\p{L})/iu],
};

const DETAIL = {
  en: [/\b(?:in (?:full )?detail|detailed|elaborate|explain (?:fully|thoroughly|everything)|full (?:explanation|details|report|version)|comprehensive|thorough|long version|deep dive|go deep|walk me through|everything about)\b/i],
  tr: [/(?<!\p{L})(?:detaylı|detaylıca|detayları|ayrıntılı|ayrıntılıca|ayrıntıları|uzun uzun|uzunca|tüm detay|bütün detay|derinlemesine|her şeyi anlat|tam rapor|açıklamalı)\p{L}*/iu],
};

const LIFT = {
  en: [/\b(?:you can (?:be|write) (?:more )?(?:detailed|verbose|longer)|longer (?:answers|replies) are (?:fine|ok)|no need to be (?:brief|short)|stop being (?:brief|short))\b/i],
  tr: [/(?<!\p{L})(?:uzun yazabilirsin|detaylı yazabilirsin|uzun yazman sorun değil|kısa yazmana gerek yok|kısa yazma artık|artık uzun yaz)\p{L}*/iu],
};

const LANGUAGE_HINTS = {
  Turkish: /[çğışöüÇĞİŞÖÜ]|(?<!\p{L})(?:ve|bir|bu|şu|için|ne|neden|nasıl|mı|mi|mu|değil|yap|olsun|var|yok|ama|gibi)(?!\p{L})/iu,
};

const NO_EMOJI = /emoji/i;

const all = (byLanguage) => Object.values(byLanguage).flat();
const RULE_PATTERNS = all(RULES);
const STANDING_PATTERNS = all(STANDING);
const BREVITY_PATTERNS = all(BREVITY);
const ONE_OFF_PATTERNS = all(ONE_OFF);
const DETAIL_PATTERNS = all(DETAIL);
const LIFT_PATTERNS = all(LIFT);

function normalize(text) {
  return text.replace(/(\p{L})\1{2,}/gu, '$1');
}

function matches(patterns, text) {
  const forms = [text, normalize(text), text.replace(/(\p{L})\1{2,}/gu, '$1$1')];
  return patterns.some((re) => forms.some((f) => re.test(f)));
}

function ownWords(text) {
  return String(text || '').replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, ' ');
}

function sentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/^[-*>\d.)\s"'“”‘’]+/, '').replace(/["'“”‘’\s]+$/, '').trim())
    .filter(Boolean);
}

function isBrevity(rule) {
  return matches(BREVITY_PATTERNS, rule);
}

function isStanding(sentence) {
  if (isBrevity(sentence)) return true;
  if (sentence.endsWith('?') || matches(ONE_OFF_PATTERNS, sentence)) return false;
  return matches(STANDING_PATTERNS, sentence) || NO_EMOJI.test(sentence);
}

function detectLanguage(text) {
  const words = (String(text).match(/\p{L}+/gu) || []).length;
  if (words < 3) return null;
  for (const [name, re] of Object.entries(LANGUAGE_HINTS)) if (re.test(text)) return name;
  return /^[\x00-\x7F]*$/.test(text) ? 'English' : null;
}

function standingRules(text) {
  const out = [];
  for (const line of ownWords(text).split('\n')) {
    for (const s of sentences(line)) if (s.length >= 6 && isStanding(s)) out.push(clip(s, 160));
  }
  return out;
}

function extractRules(turns) {
  const seen = new Map();
  for (const { user } of turns) {
    for (const line of ownWords(user).split('\n')) {
      for (const s of sentences(line)) {
        if (s.endsWith('?') || s.length < 6) continue;
        if (!matches(RULE_PATTERNS, s)) continue;
        const key = s.toLowerCase().replace(/\s+/g, ' ');
        seen.delete(key);
        seen.set(key, clip(s, 300));
      }
    }
  }
  return [...seen.values()].slice(-MAX_RULES);
}

function clip(text, max) {
  text = text.trim();
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = Math.max(0, max - head - 40);
  const cut = text.length - head - tail;
  return `${text.slice(0, head).trimEnd()} … [${cut} chars trimmed]` + (tail ? ` … ${text.slice(-tail).trimStart()}` : '');
}

function quote(text) {
  return text.replace(/\n+/g, ' ⏎ ');
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n');
}

function parseAnswers(text) {
  const out = [];
  const re = /"([^"]+)"="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) out.push({ q: m[1].trim(), a: m[2].trim() });
  return out;
}

function cleanUserText(t) {
  if (!t || t.includes(OPEN)) return '';
  if (/^\s*Caveat: The messages below were generated/.test(t)) return '';
  t = t
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-(?:stdout|stderr)>[\s\S]*?<\/local-command-(?:stdout|stderr)>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '');
  const cmd = t.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmd) {
    const name = cmd[1].trim();
    const args = ((t.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '').trim();
    if (!args || SETTING_COMMANDS.test(name)) return '';
    t = `${name} ${args}`;
  }
  return t
    .replace(/^\[Request interrupted by user[^\]]*\]\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseTranscript(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const toolNames = new Map();
  const turns = [];
  const decisions = [];
  let compactions = 0;

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }

    if (e.type === 'system' && e.subtype === 'compact_boundary') { compactions++; continue; }
    const att = e.type === 'attachment' && e.attachment;
    if (att && att.type === 'queued_command' && typeof att.prompt === 'string' && att.humanTurn !== false && !e.isSidechain) {
      const text = cleanUserText(att.prompt);
      if (text) turns.push({ user: text, assistant: '' });
      continue;
    }
    if (e.isSidechain || e.isMeta || e.isCompactSummary || e.isVisibleInTranscriptOnly) continue;
    const msg = e.message;
    if (!msg) continue;

    if (e.type === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_use') toolNames.set(b.id, b.name);
        else if (b.type === 'text' && b.text && turns.length) turns[turns.length - 1].assistant = b.text.trim();
      }
      continue;
    }

    if (e.type === 'user') {
      const c = msg.content;
      if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) {
        for (const b of c) {
          if (b.type === 'tool_result' && toolNames.get(b.tool_use_id) === 'AskUserQuestion') {
            decisions.push(...parseAnswers(blockText(b.content)));
          }
        }
        continue;
      }
      const text = cleanUserText(typeof c === 'string' ? c : blockText(c));
      if (text) turns.push({ user: text, assistant: '' });
    }
  }

  return { turns, decisions, compactions };
}

function dedupeDecisions(list) {
  const byQ = new Map();
  for (const d of list) { byQ.delete(d.q); byQ.set(d.q, d); }
  return [...byQ.values()];
}

function buildNote(transcriptPath) {
  return buildFromTurns(parseTranscript(transcriptPath));
}

function buildFromTurns(t, { userTail = true } = {}) {
  if (!t.turns.length) return null;

  let used = 0;
  const take = (s, cap) => {
    if (used + s.length > BUDGET) return false;
    if (cap && cap.used + s.length > cap.max) return false;
    used += s.length + 1;
    if (cap) cap.used += s.length + 1;
    return true;
  };
  const cap = (share) => ({ used: 0, max: Math.floor(BUDGET * share) });

  const rules = [];
  const rulesCap = cap(0.35);
  for (const r of extractRules(t.turns).reverse()) {
    if (take(`- "${quote(r)}"`, rulesCap)) rules.unshift(r);
  }

  const decisions = [];
  const decCap = cap(0.1);
  for (const d of dedupeDecisions(t.decisions).reverse()) {
    if (take(`- ${d.q} → ${d.a}`, decCap)) decisions.unshift(d);
  }

  const tail = [];
  for (let i = t.turns.length - 1; i >= Math.max(0, t.turns.length - TAIL_TURNS); i--) {
    const turn = t.turns[i];
    const u = userTail ? clip(turn.user, 1200) : '';
    if (u && !take(u)) break;
    const a = turn.assistant ? clip(turn.assistant, 700) : '';
    if (!u && !a) continue;
    tail.unshift({ user: u, assistant: a && take(a) ? a : '' });
  }

  const sections = [
    OPEN,
    'The conversation was just compacted. Below are the user\'s OWN WORDS from before compaction, quoted verbatim (long messages are trimmed). Treat them as authoritative: where the compaction summary is vaguer or disagrees, follow the user\'s words. Keep working from where things stood; do not re-ask what is answered here.',
  ];
  if (rules.length) sections.push('## Rules and corrections the user gave (oldest → newest)', rules.map((r) => `- "${quote(r)}"`).join('\n'));
  if (decisions.length) sections.push('## Decisions the user made', decisions.map((d) => `- ${d.q} → ${d.a}`).join('\n'));
  if (tail.length) {
    sections.push(
      userTail ? '## Last turns before compaction (verbatim)' : '## Your last answers before compaction',
      tail.map((x) => [x.user && `User: ${x.user}`, x.assistant && `Assistant: ${x.assistant}`].filter(Boolean).join('\n')).join('\n\n'),
    );
  }
  sections.push(CLOSE);

  const note = sections.join('\n\n');
  const stats = {
    turns: tail.length,
    rules: rules.length,
    decisions: decisions.length,
    tokens: Math.round(note.length / CHARS_PER_TOKEN),
    compactions: t.compactions,
  };
  return { note, stats, rules, decisions, tail };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function summaryLine(stats) {
  const k = stats.tokens >= 1000 ? `${(stats.tokens / 1000).toFixed(1)}K` : String(stats.tokens);
  const parts = [
    stats.rules && plural(stats.rules, 'rule'),
    stats.decisions && plural(stats.decisions, 'decision'),
    stats.turns && `the last ${plural(stats.turns, 'turn')}`,
  ].filter(Boolean);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] || 'nothing';
  return `asisaid: restored ${list} (~${k} tokens)`;
}

function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || process.env.PLUGIN_DATA || path.join(os.homedir(), '.asisaid');
}

function sessionFile(kind, sessionId, ext) {
  return path.join(dataDir(), kind, String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_') + ext);
}

function writePrivate(file, content, append) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  (append ? fs.appendFileSync : fs.writeFileSync)(file, content, { mode: 0o600 });
}

function appendLog(sessionId, role, text) {
  if (!text || !text.trim()) return;
  writePrivate(sessionFile('log', sessionId, '.jsonl'), JSON.stringify({ role, text }) + '\n', true);
}

function readLog(sessionId) {
  const turns = [];
  let raw = '';
  try { raw = fs.readFileSync(sessionFile('log', sessionId, '.jsonl'), 'utf8'); } catch {}
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.role === 'user') {
      const text = cleanUserText(e.text);
      if (text) turns.push({ user: text, assistant: '' });
    } else if (e.role === 'assistant' && turns.length) {
      turns[turns.length - 1].assistant = String(e.text).trim();
    }
  }
  return { turns, decisions: [], compactions: 0 };
}

function writePending(sessionId, payload) {
  writePrivate(sessionFile('pending', sessionId, '.json'), JSON.stringify({ ...payload, createdAt: Date.now() }));
}

function takePending(sessionId) {
  const file = sessionFile('pending', sessionId, '.json');
  let data = null;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  try { fs.unlinkSync(file); } catch {}
  if (!data || Date.now() - (data.createdAt || 0) > PENDING_TTL_MS) return null;
  return data;
}

function hasPending(sessionId) {
  return fs.existsSync(sessionFile('pending', sessionId, '.json'));
}

function loadState(sessionId) {
  try { return JSON.parse(fs.readFileSync(sessionFile('rules', sessionId, '.json'), 'utf8')); } catch { return null; }
}

function saveState(sessionId, state) {
  writePrivate(sessionFile('rules', sessionId, '.json'), JSON.stringify(state));
}

function ruleKey(rule) {
  return normalize(rule).toLowerCase().replace(/\s+/g, ' ');
}

function addRules(state, rules) {
  for (const r of rules) {
    state.rules = state.rules.filter((x) => ruleKey(x) !== ruleKey(r));
    state.rules.push(r);
  }
  state.rules = state.rules.slice(-MAX_RULES);
}

function languageName(state) {
  return state.lang || "the user's language";
}

function reminder(state, detailAsked) {
  const active = state.rules.slice(-MAX_ACTIVE);
  if (!active.length) return '';
  const lines = [`asisaid — standing rules the user gave in this session (their words). Follow them in this reply:`];
  lines.push(...active.map((r) => `- "${quote(r)}"`));
  const brief = active.some(isBrevity);
  if (brief && detailAsked) {
    lines.push(`The user asked for detail in this message, so this reply may be longer. Reply in ${languageName(state)}.`);
  } else if (brief) {
    lines.push(`The user wants short replies. Reply in ${languageName(state)} with only what matters: the result, what they need to decide or do, and blockers. A few sentences, no tables, recaps, long lists or source lists unless asked. Never drop code, commands, error messages or questions the user must answer.`);
  }
  return lines.join('\n');
}

function violation(rules, reply, { detailAsked = false, lang = null } = {}) {
  const text = String(reply || '').replace(/```[\s\S]*?```/g, ' ');
  const words = (text.match(/\S+/g) || []).length;
  const newestFirst = rules.slice().reverse();
  const brief = detailAsked ? null : newestFirst.find(isBrevity);
  if (brief && words > BRIEF_WORDS) {
    return {
      rule: brief,
      why: `${words} words`,
      fix: `Rewrite your last reply in ${lang || "the user's language"}, in at most ${Math.round(BRIEF_WORDS * 0.6)} words of prose: only the result, what the user needs to decide or do, and blockers. Keep any code, commands, error messages and questions for the user unchanged; do not redo any work.`,
    };
  }
  const noEmoji = newestFirst.find((r) => NO_EMOJI.test(r));
  if (noEmoji && /\p{Extended_Pictographic}/u.test(text)) {
    return { rule: noEmoji, why: 'it contains emoji', fix: 'Repeat your last reply without any emoji.' };
  }
  return null;
}

function logError(err) {
  try {
    writePrivate(path.join(dataDir(), 'errors.log'), `${new Date().toISOString()} ${(err && err.stack) || err}\n`, true);
  } catch {}
}

function readHookInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function build(input, agent) {
  if (agent === 'codex') return buildFromTurns(readLog(input.session_id), { userTail: false });
  return input.transcript_path ? buildNote(input.transcript_path) : null;
}

function precompact(agent) {
  const input = readHookInput();
  const built = build(input, agent);
  if (built) writePending(input.session_id, { note: built.note, stats: built.stats });
}

function restore(agent) {
  const input = readHookInput();
  const built = takePending(input.session_id) || build(input, agent);
  if (!built) return;
  process.stdout.write(JSON.stringify({
    systemMessage: summaryLine(built.stats),
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: built.note },
  }));
}

function seedState(input, agent) {
  const state = { rules: [], turn: 0, blockedTurn: -1, detailTurn: -1, lang: null };
  let turns = [];
  try {
    if (agent === 'codex') turns = readLog(input.session_id).turns;
    else if (input.transcript_path) turns = parseTranscript(input.transcript_path).turns;
  } catch {}
  for (const t of turns) {
    addRules(state, standingRules(t.user));
    state.lang = detectLanguage(ownWords(t.user)) || state.lang;
  }
  return state;
}

function prompt(agent) {
  const input = readHookInput();
  const built = hasPending(input.session_id) ? takePending(input.session_id) : null;
  const state = loadState(input.session_id) || seedState(input, agent);
  if (agent === 'codex') appendLog(input.session_id, 'user', input.prompt);
  const text = ownWords(cleanUserText(input.prompt || ''));
  if (matches(LIFT_PATTERNS, text)) state.rules = state.rules.filter((r) => !isBrevity(r));
  else addRules(state, standingRules(text));
  state.turn += 1;
  const detailAsked = matches(DETAIL_PATTERNS, text);
  if (detailAsked) state.detailTurn = state.turn;
  state.lang = detectLanguage(text) || state.lang;
  saveState(input.session_id, state);

  const context = [built && built.note, reminder(state, detailAsked)].filter(Boolean).join('\n\n');
  if (!context) return;
  const out = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } };
  if (built) out.systemMessage = summaryLine(built.stats);
  process.stdout.write(JSON.stringify(out));
}

function stop(agent) {
  const input = readHookInput();
  if (agent === 'codex') appendLog(input.session_id, 'assistant', input.last_assistant_message);
  const state = loadState(input.session_id);
  if (!state || state.blockedTurn === state.turn) return;
  const reply = input.last_assistant_message != null ? input.last_assistant_message : lastAssistantText(input.transcript_path);
  const v = violation(state.rules, reply, { detailAsked: state.detailTurn === state.turn, lang: state.lang });
  if (!v) return;
  state.blockedTurn = state.turn;
  saveState(input.session_id, state);
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `asisaid: your reply breaks a rule the user gave: "${quote(v.rule)}" (${v.why}). ${v.fix}`,
    systemMessage: `asisaid: reply broke "${clip(v.rule, 60)}" (${v.why}), fixing`,
  }));
}

function lastAssistantText(file) {
  if (!file) return '';
  let raw = '';
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
  } catch { return ''; }
  const parts = [];
  for (const line of raw.split('\n').reverse()) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain) continue;
    const c = e.message && e.message.content;
    if (e.type === 'user' && !(Array.isArray(c) && c.some((b) => b.type === 'tool_result'))) break;
    if (e.type === 'assistant' && Array.isArray(c)) {
      const text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (text) parts.unshift(text);
      else if (parts.length) break;
    }
  }
  return parts.join('\n');
}

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function findTranscript(sessionId, cwd) {
  const projects = path.join(claudeDir(), 'projects');
  if (sessionId && /^[A-Za-z0-9-]+$/.test(sessionId)) {
    for (const dir of safeReaddir(projects)) {
      const f = path.join(projects, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  }
  const dir = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'));
  const newest = safeReaddir(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  return newest ? newest.f : null;
}

function peek(sessionId) {
  const file = findTranscript(sessionId, process.cwd());
  if (!file) {
    console.log('asisaid: no transcript found for this session yet.');
    return;
  }
  const id = path.basename(file, '.jsonl');
  const state = loadState(id) || { rules: [] };
  const built = buildNote(file);
  const out = [];
  out.push(state.rules.length
    ? `Standing rules (reminded every turn, checked on every reply):\n${state.rules.slice(-MAX_ACTIVE).map((r) => `  - ${quote(r)}`).join('\n')}`
    : 'No standing rules yet.');
  if (built) {
    const s = built.stats;
    out.push('', `After the next compaction asisaid would restore ~${s.tokens} tokens: ${plural(s.rules, 'rule')}, ${plural(s.decisions, 'decision')}, the last ${plural(s.turns, 'turn')}.`);
  }
  console.log(out.join('\n'));
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  const commands = { precompact, restore, prompt, stop, peek };
  try {
    if (commands[cmd]) commands[cmd](arg);
    else console.log('usage: asisaid.js precompact|restore|prompt|stop [codex] | peek [session-id]');
  } catch (err) {
    logError(err);
    if (cmd === 'peek') console.log(`asisaid: could not read this session (${err.message}).`);
  }
  process.exitCode = 0;
}

if (require.main === module) main();

module.exports = { parseTranscript, readLog, buildNote, buildFromTurns, cleanUserText, extractRules, standingRules, violation, summaryLine, detectLanguage, reminder };
