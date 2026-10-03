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

const all = (byLanguage) => Object.values(byLanguage).flat();
const RULE_PATTERNS = all(RULES);

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
    .split(/(?<=[.!?])\s+|(?<=[。！？])/)
    .map((s) => s.replace(/^[-*>\d.)\s"'“”‘’]+/, '').replace(/["'“”‘’\s]+$/, '').trim())
    .filter(Boolean);
}

const LEXICON = require('./lexicon');
const LANGS = Object.keys(LEXICON);
const CATEGORIES = ['brevity', 'long', 'too', 'short', 'reply', 'answer', 'code', 'detail', 'permission', 'lift', 'standing', 'oneOff', 'negation', 'emoji', 'much', 'skip', 'explain', 'longform', 'text', 'cancel', 'noNeed', 'again', 'briefNoun', 'strong'];
const RULE_WORD = /(?:^|\s)(?:rule|regla|regle|regel|regola|regul|kural|aturan|pravidl|quy tac|mode|modo|modus|consigne|zasad|demistim|dedim|i said|told you|j ai dit|dije|disse|gesagt|detto|gezegd|mowilem)|правил|режим|говорил|казав|规则|規則|要求|模式|ルール|モード|言った|규칙|모드|했던|قاعد|قلت/;
const FOLD_MAP = { ı: 'i', ł: 'l', ß: 'ss', đ: 'd', ø: 'o', æ: 'ae', œ: 'oe', أ: 'ا', إ: 'ا', آ: 'ا', ى: 'ي', ة: 'ه', ؤ: 'و', ئ: 'ي' };
const CJK = /[぀-ヿ㐀-鿿가-힯ᄀ-ᇿ豈-﫿]/;
const TOKEN_SPLIT = /[^\p{L}\p{M}\p{N}]+/u;

function fold(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[ıłßđøæœأإآىةؤئ]/g, (c) => FOLD_MAP[c])
    .normalize('NFKD')
    .replace(/[̀-ًͯ-ٰٟ]/g, '')
    .normalize('NFKC')
    .replace(/\btl\s*[;:]?\s*dr\b/g, ' tldr ')
    .replace(/['’`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compileTerm(term) {
  const suffix = term.startsWith('*');
  const stem = term.endsWith('*');
  const text = fold(term.replace(/^\*|\*$/g, ''));
  const words = text.split(TOKEN_SPLIT).filter(Boolean);
  return { cjk: CJK.test(text), stem, suffix, text, phrase: words.join(' '), single: words.length === 1, ascii: /^[a-z0-9 ]{2,}$/.test(text) };
}

const TERMS = Object.fromEntries(LANGS.map((lang) => [lang, Object.fromEntries(
  CATEGORIES.map((cat) => [cat, (LEXICON[lang][cat] || []).map(compileTerm)]),
)]));
const STOPWORDS = Object.fromEntries(LANGS.filter((l) => LEXICON[l].stop).map((l) => [l, new Set(LEXICON[l].stop.map(fold))]));

function prepare(text) {
  const base = fold(text);
  const variants = new Set([base, base.replace(/(\p{L})\1{2,}/gu, '$1'), base.replace(/(\p{L})\1{2,}/gu, '$1$1')]);
  return [...variants].map((raw) => {
    const tokens = raw.split(TOKEN_SPLIT).filter(Boolean);
    return { raw, tokens, spaced: ` ${tokens.join(' ')} `, cjk: CJK.test(raw) };
  });
}

function nearlyEqual(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || a[0] !== b[0]) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function hit(term, form) {
  if (!term.phrase) return false;
  if (term.cjk) return form.raw.includes(term.text);
  if (form.cjk && term.ascii && form.raw.includes(term.phrase)) return true;
  if (term.suffix) return term.single && form.tokens.some((w) => w.length > term.phrase.length && w.endsWith(term.phrase));
  if (term.stem) {
    if (term.single) return form.tokens.some((w) => w.startsWith(term.phrase));
    return form.spaced.includes(` ${term.phrase}`);
  }
  if (form.spaced.includes(` ${term.phrase} `)) return true;
  return term.single && term.phrase.length >= 6
    && form.tokens.some((w) => w.length >= 5 && w.slice(-2) === term.phrase.slice(-2) && nearlyEqual(w, term.phrase));
}

function langScores(text) {
  const s = String(text || '');
  if (/[\uac00-\ud7af\u1100-\u11ff]/.test(s)) return [['ko', 10]];
  if (/[\u3040-\u30ff]/.test(s)) return [['ja', 10]];
  if (/[\u4e00-\u9fff]/.test(s)) return [['zh', 10]];
  if (/[\u0600-\u06ff]/.test(s)) return [['ar', 10]];
  if (/[\u0900-\u097f]/.test(s)) return [['hi', 10]];
  if (/[\u0400-\u04ff]/.test(s)) return [[/[іїєґ]/i.test(s) ? 'uk' : 'ru', 10]];
  const tokens = fold(s).split(TOKEN_SPLIT).filter(Boolean);
  const lower = s.toLowerCase();
  return Object.entries(STOPWORDS).map(([lang, set]) => {
    let score = tokens.filter((t) => set.has(t)).length;
    if (LEXICON[lang].chars && LEXICON[lang].chars.test(lower)) score += 2;
    return [lang, score];
  }).filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1]);
}

function detectLang(text) {
  const [best, second] = langScores(text);
  if (!best || best[1] < 2 || (second && second[1] === best[1])) return null;
  return best[0] === 'hi' && best[1] < 10 ? 'hi-latn' : best[0];
}

function languageLabel(code) {
  if (!code) return null;
  if (code === 'hi-latn') return 'Hinglish (Hindi in Latin script)';
  return LEXICON[code] ? LEXICON[code].name : null;
}

function classify(text, sessionLang) {
  const forms = prepare(text);
  const detected = detectLang(text);
  const base = (code) => (code === 'hi-latn' ? 'hi' : code);
  const guesses = langScores(text).slice(0, 3).map(([l]) => l);
  const cyrillicPair = (l) => (l === 'ru' ? ['ru', 'uk'] : l === 'uk' ? ['uk', 'ru'] : [l]);
  const langs = [...new Set([detected, ...guesses, sessionLang, 'en'].map(base).flatMap(cyrillicPair).filter((l) => l && TERMS[l]))];
  const wide = detected ? langs : LANGS;
  const has = (lang, cat) => TERMS[lang][cat].some((t) => forms.some((f) => hit(t, f)));
  const anyOf = (cat, list) => list.some((l) => has(l, cat));
  const inLang = (l, ...cats) => cats.every((c) => (Array.isArray(c) ? c.some((x) => has(l, x)) : has(l, c)));

  const artifact = anyOf('code', wide);
  const answer = anyOf('answer', wide);
  const negation = anyOf('negation', wide);
  const strong = anyOf('strong', LANGS);
  const explicitBrevity = strong || anyOf('brevity', LANGS);
  const skipExplain = wide.some((l) => inLang(l, 'skip', 'explain'));
  const combo = skipExplain || wide.some((l) => inLang(l, 'long', 'too')
    || inLang(l, 'short', 'reply')
    || inLang(l, 'too', 'much', 'reply')
    || inLang(l, 'text', ['too', 'much'])
    || (has(l, 'longform') && (answer || negation || has(l, 'skip') || has(l, 'standing'))));
  let brevity = strong || ((explicitBrevity || combo) && (!artifact || answer));

  const brief = anyOf('briefNoun', wide) || anyOf('short', wide);
  const ruleWord = forms.some((f) => RULE_WORD.test(f.raw));
  const cancel = anyOf('cancel', wide);
  const longish = anyOf('detail', wide) || anyOf('long', wide);
  const standingWords = anyOf('standing', wide);
  const lift = !artifact && (anyOf('lift', LANGS)
    || (anyOf('noNeed', wide) && brief)
    || (cancel && (ruleWord || (brief && (!explicitBrevity || anyOf('detail', wide)))))
    || (anyOf('permission', wide) && longish && (anyOf('again', wide) || standingWords)));
  if (lift) brevity = false;

  let detail = anyOf('detail', wide);
  if (detail && brevity) {
    if (explicitBrevity || skipExplain) detail = false;
    else brevity = false;
  }
  const oneOff = anyOf('oneOff', wide);
  return {
    lang: detected,
    brevity,
    detail: detail && !lift,
    lift,
    standing: standingWords && !oneOff,
    oneOff,
    emojiRule: anyOf('emoji', wide) && (standingWords || negation),
  };
}

function isBrevity(rule) {
  return classify(rule).brevity;
}

function isStanding(sentence, sessionLang) {
  const c = classify(sentence, sessionLang);
  if (c.brevity) return true;
  if (/[?？]$/.test(sentence) || c.oneOff) return false;
  return c.standing || c.emojiRule;
}

function detectLanguage(text) {
  return languageLabel(detectLang(text));
}

function standingRules(text, sessionLang) {
  const out = [];
  for (const line of ownWords(text).split('\n')) {
    for (const s of sentences(line)) if (s.length >= 2 && isStanding(s, sessionLang)) out.push(clip(s, 160));
  }
  return out;
}

function extractRules(turns) {
  const seen = new Map();
  for (const { user } of turns) {
    for (const line of ownWords(user).split('\n')) {
      for (const s of sentences(line)) {
        if (s.endsWith('?') || s.length < 6) continue;
        if (!matches(RULE_PATTERNS, s) && !isStanding(s)) continue;
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
  if (/^\s*Caveat: The messages below were generated/.test(t) || /NOT USER INPUT|^\s*\[Subagent hand-back\]/.test(t)) return '';
  t = t
    .replace(/<system-reminder[^>]*>[\s\S]*?<\/system-reminder[^>]*>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<agent-message[^>]*>[\s\S]*?<\/agent-message>/g, '')
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
  const noEmoji = newestFirst.find((r) => classify(r).emojiRule);
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
  const state = { rules: [], turn: 0, blockedTurn: -1, detailTurn: -1, lang: null, langCode: null };
  let turns = [];
  try {
    if (agent === 'codex') turns = readLog(input.session_id).turns;
    else if (input.transcript_path) turns = parseTranscript(input.transcript_path).turns;
  } catch {}
  for (const t of turns) {
    const code = detectLang(ownWords(t.user));
    if (code) { state.langCode = code; state.lang = languageLabel(code); }
    addRules(state, standingRules(t.user, state.langCode));
  }
  return state;
}

function prompt(agent) {
  const input = readHookInput();
  const built = hasPending(input.session_id) ? takePending(input.session_id) : null;
  const state = loadState(input.session_id) || seedState(input, agent);
  if (agent === 'codex') appendLog(input.session_id, 'user', input.prompt);
  const text = ownWords(cleanUserText(input.prompt || ''));
  const c = text ? classify(text, state.langCode) : {};
  if (c.lang) { state.langCode = c.lang; state.lang = languageLabel(c.lang); }
  if (c.lift) state.rules = state.rules.filter((r) => !isBrevity(r));
  else if (text) addRules(state, standingRules(text, state.langCode));
  state.turn += 1;
  const detailAsked = Boolean(c.detail);
  if (detailAsked) state.detailTurn = state.turn;
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

function main() {
  const [cmd, arg] = process.argv.slice(2);
  const commands = { precompact, restore, prompt, stop };
  try {
    if (commands[cmd]) commands[cmd](arg);
    else console.log('usage: asisaid.js precompact|restore|prompt|stop [codex]');
  } catch (err) {
    logError(err);
  }
  process.exitCode = 0;
}

if (require.main === module) main();

module.exports = { parseTranscript, readLog, buildNote, buildFromTurns, cleanUserText, extractRules, standingRules, violation, summaryLine, detectLanguage, reminder, classify };
