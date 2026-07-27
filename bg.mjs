#!/usr/bin/env node
// Hand a long job to a Telegram bridge BACKGROUND worker and return instantly.
//
//   node bg.mjs "run the full test suite and report what fails"
//
// The bridge daemon drains this drop-box each poll cycle (≤~1 min) and runs the
// text in its own background Claude session, streaming progress to Telegram.
// The calling session is free immediately.
//
// Workers are unbounded: if one is busy, the daemon spawns another, so several
// handoffs run in PARALLEL rather than queueing behind each other.
//
// When the job finishes, its output is delivered to the CHAT lane as a worker
// report — the assistant decides what to do and gives you a short update.
// Raw output never goes straight to your chat. History: bg-results.jsonl.
//
// A background worker is a SEPARATE session: it does not see your conversation,
// so write each task self-contained. Its result does NOT come back into your
// current turn — use it for "go do this and report", not for work whose result
// you need in order to answer right now.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bg-queue.json');
const text = process.argv.slice(2).join(' ').trim();

if (!text) {
  console.error('usage: node bg.mjs "<task for the background lane>"');
  process.exit(1);
}

// The daemon drains this file concurrently. A pid-unique temp keeps our write
// from clobbering (or being clobbered by) its claim, and re-reading inside the
// retry loop means an item can't be lost to a drain that landed mid-flight.
const TMP = `${FILE}.${process.pid}.tmp`;
let pending = 0;
let lastErr;

for (let attempt = 0; attempt < 5; attempt++) {
  let items = [];
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    if (Array.isArray(parsed)) items = parsed;
  } catch {
    /* missing or mid-rename — treat as empty and retry on failure */
  }
  items.push({ text, queuedAt: new Date().toISOString() });
  try {
    writeFileSync(TMP, JSON.stringify(items, null, 2));
    renameSync(TMP, FILE);
    pending = items.length;
    lastErr = null;
    break;
  } catch (e) {
    lastErr = e;
  }
}

if (lastErr) {
  console.error(`could not hand off after 5 attempts: ${lastErr.message}`);
  process.exit(1);
}

console.log(`handed to background lane (${pending} pending): ${text.slice(0, 80)}`);
