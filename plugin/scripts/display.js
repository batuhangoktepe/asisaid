#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const BRIEF_WORDS = parseInt(process.env.ASISAID_BRIEF_WORDS || '', 10) || 120;
const NOTICE = '\n… asisaid: shortening this reply\n';

function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || process.env.PLUGIN_DATA || path.join(os.homedir(), '.asisaid');
}

function stateFile(sessionId) {
  return path.join(dataDir(), 'rules', String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
}

function countProse(text, inCode) {
  const parts = String(text).split('```');
  let words = 0;
  parts.forEach((part, i) => {
    const code = i % 2 === 1 ? !inCode : inCode;
    if (!code) words += (part.match(/\S+/g) || []).length;
  });
  return { words, inCode: (parts.length - 1) % 2 === 1 ? !inCode : inCode };
}

function firstWords(text, n) {
  if (n <= 0) return '';
  let count = 0;
  const re = /\S+\s*/g;
  let m;
  let end = 0;
  while ((m = re.exec(text)) && count < n) {
    end = m.index + m[0].length;
    count++;
  }
  return text.slice(0, end);
}

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  const file = stateFile(input.session_id);
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (!state.short || state.blockedTurn === state.turn) return;

  const id = input.message_id || 'message';
  const d = state.display && state.display.turn === state.turn && state.display.message === id
    ? state.display
    : { turn: state.turn, message: id, words: 0, inCode: false, hidden: false };
  const delta = String(input.delta || '');
  let shown = null;

  if (d.hidden) {
    shown = '';
  } else {
    const counted = countProse(delta, d.inCode);
    if (!d.inCode && d.words + counted.words > BRIEF_WORDS) {
      d.hidden = true;
      shown = firstWords(delta, BRIEF_WORDS - d.words).replace(/\s+$/, '') + NOTICE;
    } else {
      d.words += counted.words;
      d.inCode = counted.inCode;
    }
  }

  state.display = d;
  try { fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 }); } catch {}
  if (shown !== null) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'MessageDisplay', displayContent: shown } }));
  }
}

try { main(); } catch {}
process.exitCode = 0;
