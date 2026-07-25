#!/usr/bin/env node
// CLI over the Telegram bridge's schedule store — lets a Claude session manage
// reminders/tasks in plain English ("remind me every day at 8 to…").
// The bridge daemon reads this file fresh each poll cycle, so changes take
// effect within ~1 minute with no restart.
//
//   node schedule.mjs list
//   node schedule.mjs add daily 08:00 "text"            # every day
//   node schedule.mjs add once 2026-07-30 09:30 "text"  # specific date+time
//   node schedule.mjs add in 90m "text"                 # relative: m|h|d
//   node schedule.mjs remove <id>
//   node schedule.mjs update <id> [--at HH:MM|YYYY-MM-DDTHH:MM] [--text "…"] [--run true|false]
//
// Flags: --run  → execute the text as a Claude task instead of sending a
//        plain reminder (same as the "run:" prefix in Telegram's /remind).

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schedules.json');

const load = () => {
  let raw;
  try {
    raw = readFileSync(FILE, 'utf8');
  } catch {
    return { nextId: 0, items: [] }; // no file yet
  }
  try {
    const d = JSON.parse(raw);
    return { nextId: d.nextId || 0, items: Array.isArray(d.items) ? d.items : [] };
  } catch (e) {
    // Never let a corrupt store look like "no schedules" and get overwritten.
    console.error(`schedules.json is corrupt (${e.message}) — refusing to overwrite it.`);
    console.error(`Inspect or move ${FILE}, then retry.`);
    process.exit(1);
  }
};
const save = (s) => {
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, FILE);
};
const fmt = (s) =>
  `#${s.id} · ${s.kind === 'daily' ? `daily ${s.at}` : new Date(s.at).toLocaleString()} · ${
    s.run ? 'run' : 'remind'
  } · ${s.text}`;
const die = (m) => {
  console.error(m);
  process.exit(1);
};

const argv = process.argv.slice(2);
const cmd = (argv[0] || 'list').toLowerCase();
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
};
const hasFlag = (name) => argv.includes(`--${name}`);
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]?.startsWith('--')));

const store = load();

if (cmd === 'list') {
  console.log(store.items.length ? store.items.map(fmt).join('\n') : 'No schedules.');
} else if (cmd === 'add') {
  const kind = (positional[1] || '').toLowerCase();
  let item;
  if (kind === 'daily') {
    const at = positional[2];
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(at || '')) die('add daily <HH:MM> "text"');
    item = { kind: 'daily', at: at.padStart(5, '0'), text: positional.slice(3).join(' ') };
    const now = new Date().toTimeString().slice(0, 5);
    if (now >= item.at) {
      const d = new Date();
      item.lastFired = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  } else if (kind === 'once') {
    const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(positional[2] || '');
    const timeIdx = hasDate ? 3 : 2;
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(positional[timeIdx] || '')) die('add once [YYYY-MM-DD] <HH:MM> "text"');
    let when;
    if (hasDate) {
      when = new Date(`${positional[2]}T${positional[timeIdx].padStart(5, '0')}:00`);
    } else {
      const [h, m] = positional[timeIdx].split(':');
      when = new Date();
      when.setHours(+h, +m, 0, 0);
      if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
    }
    if (isNaN(when.getTime())) die('unparseable date/time');
    item = { kind: 'once', at: when.getTime(), text: positional.slice(timeIdx + 1).join(' ') };
  } else if (kind === 'in') {
    const m = (positional[2] || '').match(/^(\d+)(m|h|d)$/i);
    if (!m) die('add in <N>m|h|d "text"');
    const mult = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase()];
    item = { kind: 'once', at: Date.now() + Number(m[1]) * mult, text: positional.slice(3).join(' ') };
  } else {
    die('add daily|once|in …');
  }
  if (!item.text) die('missing text');
  if (item.kind === 'once' && item.at <= Date.now())
    die(`${new Date(item.at).toLocaleString()} is in the past — nothing scheduled; give a future date/time`);
  if (hasFlag('run')) item.run = true;
  item.id = store.nextId = (store.nextId || 0) + 1;
  store.items.push(item);
  save(store);
  console.log(`added ${fmt(item)}`);
} else if (cmd === 'remove') {
  const id = Number(positional[1]);
  const before = store.items.length;
  store.items = store.items.filter((s) => s.id !== id);
  if (store.items.length === before) die(`no schedule #${id}`);
  save(store);
  console.log(`removed #${id}`);
} else if (cmd === 'update') {
  const id = Number(positional[1]);
  const item = store.items.find((s) => s.id === id);
  if (!item) die(`no schedule #${id}`);
  const at = flag('at');
  if (at) {
    if (item.kind === 'daily') {
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) die('daily --at wants HH:MM');
      item.at = at.padStart(5, '0');
      delete item.lastFired;
      // Moving a daily to a time already past today must not fire immediately.
      const now = new Date();
      if (now.toTimeString().slice(0, 5) >= item.at)
        item.lastFired = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    } else {
      let when;
      if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) {
        // bare HH:MM on a one-off → today, or tomorrow if already past (same as `add once`)
        const [h, m] = at.split(':');
        when = new Date();
        when.setHours(+h, +m, 0, 0);
        if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
      } else {
        when = new Date(at);
      }
      if (isNaN(when.getTime())) die('once --at wants HH:MM or YYYY-MM-DDTHH:MM');
      if (when.getTime() <= Date.now())
        die(`${when.toLocaleString()} is in the past — not moved; give a future date/time`);
      item.at = when.getTime();
    }
  }
  const text = flag('text');
  if (text) item.text = text;
  // `--run` bare = on (matches `add`); `--run true|false` explicit; `--no-run` off.
  // Never consume the next token unless it's literally true/false, or a flag
  // following --run would be silently read as its value.
  if (argv.includes('--no-run')) delete item.run;
  else if (argv.includes('--run')) {
    const v = flag('run');
    if (v === 'false') delete item.run;
    else item.run = true;
  }
  save(store);
  console.log(`updated ${fmt(item)}`);
} else {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).join('\n'));
}
