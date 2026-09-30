#!/usr/bin/env node
// Run with --stub for an offline contract check; set TYPESAFE_API_KEY for real samples.
import { performance } from 'node:perf_hooks';

const questions = {
  intent: { type: 'choice', instructions: 'Classify the new message in relation to the current task.', criteria: {
    stop_all: 'Stop all ongoing work.', stop_current: 'Stop the current action.',
    wait: 'Pause briefly.', redirect: 'Change the direction of the task.',
    unrelated: 'No control instruction for the current task.',
  } },
  targets_current: { type: 'noul', instructions: 'Probability that the message refers to the current task.' },
  urgency: { type: 'score', instructions: 'Urgency of the control instruction, from 0 to 3.' },
};

export const payload = {
  model: 'jev-latest',
  state: {
    current_task: 'Looking up tomorrow’s calendar events',
    latest_user_message: 'Stop looking at my calendar',
    recent_messages: ['Please check tomorrow’s schedule', 'One moment'],
  },
  questions,
};

export function percentile(values, p) {
  if (!values.length) throw new Error('No samples');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
}

export async function evaluate({ key, stub = false, timeoutMs = 6000 }) {
  if (stub) return { model: 'stub', answers: {
    intent: { type: 'choice', choice: 'stop_current', confidence: .99 },
    targets_current: { type: 'noul', noul: .99 },
    urgency: { type: 'score', score: 2 },
  } };
  if (!key) throw new Error('TYPESAFE_API_KEY is required for real samples');
  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const stub = process.argv.includes('--stub');
  const count = Number(process.argv.find(arg => arg.startsWith('--count='))?.split('=')[1] ?? 30);
  if (!Number.isSafeInteger(count) || count < 1 || count > 200) throw new Error('count must be 1–200');
  const samples = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    const result = await evaluate({ key: process.env.TYPESAFE_API_KEY, stub });
    if (!result?.answers?.intent || !result?.answers?.targets_current || !result?.answers?.urgency) {
      throw new Error('Sample ' + (i + 1) + ' lacks required answers');
    }
    samples.push(Math.round(performance.now() - start));
  }
  console.log(JSON.stringify({
    mode: stub ? 'stub (not latency evidence)' : 'real',
    count, model: stub ? 'stub' : 'jev-latest',
    min_ms: Math.min(...samples), median_ms: percentile(samples, .5),
    p95_ms: percentile(samples, .95), max_ms: Math.max(...samples),
    samples_ms: samples,
  }, null, 2));
}
