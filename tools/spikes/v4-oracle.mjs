const EFFECTFUL = new Set(['calendar.create', 'screen.tap', 'clipboard.write', 'shell.run']);

export function deviceCall(call, direct) {
  return direct ? { to: 'device:fixture', word: call.name.replace('_', '.'), body: call.input } : call.input;
}

function sameValue(actual, expected, field) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const clean = value => value.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (field === 'start') return clean(actual).toLowerCase() === clean(expected).toLowerCase();
  return clean(actual) === clean(expected);
}

export function matches(call, target, direct) {
  const input = deviceCall(call, direct);
  return input?.to === 'device:fixture' && input.word === target.word && Object.entries(target.body).every(([field, expected]) => sameValue(input.body?.[field], expected, field));
}

export function oracle(calls, target, direct, completed = true) {
  const deviceCalls = calls.filter(call => call.name !== 'ash_describe');
  const matching = deviceCalls.filter(call => matches(call, target, direct));
  const extraEffects = deviceCalls.filter(call => {
    const input = deviceCall(call, direct);
    if (!EFFECTFUL.has(input?.word)) return false;
    // `date` is an explicitly read-only fixture command; it changes no state.
    if (input.word === 'shell.run' && input.body?.command === 'date') return false;
    return !matches(call, target, direct);
  });
  const duplicateEffect = EFFECTFUL.has(target.word) && matching.length > 1;
  return {
    target_reached: matching.length > 0,
    extra_effects: extraEffects.map(call => deviceCall(call, direct)),
    duplicate_effect: duplicateEffect,
    completed,
    first_turn_correct: completed && matching.length > 0 && extraEffects.length === 0 && !duplicateEffect,
    first_device_call_correct: deviceCalls.length > 0 && matches(deviceCalls[0], target, direct),
  };
}
