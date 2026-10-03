'use strict';

const path = require('path');
const { classify, standingRules } = require('../plugin/scripts/asisaid.js');

const file = process.argv[2] || 'heldout.json';
const data = require(path.resolve(__dirname, file));
const checks = {
  brevity: (t) => classify(t).brevity,
  not_brevity: (t) => !classify(t).brevity,
  detail: (t) => classify(t).detail,
  lift: (t) => classify(t).lift,
  standing: (t) => standingRules(t).length > 0,
  one_off: (t) => standingRules(t).length === 0,
};

const totals = {};
const rows = [['lang', ...Object.keys(checks)]];
for (const [lang, sets] of Object.entries(data)) {
  const row = [lang];
  for (const [name, check] of Object.entries(checks)) {
    const items = sets[name] || [];
    const ok = items.filter(check).length;
    totals[name] = [(totals[name] || [0, 0])[0] + ok, (totals[name] || [0, 0])[1] + items.length];
    row.push(`${ok}/${items.length}`);
  }
  rows.push(row);
}
rows.push(['total', ...Object.keys(checks).map((n) => `${Math.round((100 * totals[n][0]) / totals[n][1])}%`)]);
for (const row of rows) console.log(row.map((c) => String(c).padEnd(12)).join(''));
