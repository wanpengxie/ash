// Read explicit coverage entries, never a status adjective inside a Q1/Q2 narrative.
const labels = ['已核实', '部分核实', '未完成', '待返回'];
function entries(visible) {
  const found = new Map();
  for (const raw of visible.split('\n')) {
    const line = raw.replaceAll('**', '').trim();
    const standalone = line.match(/^(?:[-*]\s*|\|\s*)?(已核实|部分核实|未完成|待返回)\s*(?:[：:|]\s*|\s+)(\d+)(?:\s*\/\s*(\d+))?/);
    if (standalone) {
      found.set(standalone[1], { count: Number(standalone[2]), denominator: standalone[3] === undefined ? null : Number(standalone[3]) });
      continue;
    }
    if (!line.includes('覆盖')) continue;
    for (const label of labels) {
      const after = line.match(new RegExp(label + '\\s*(?:[：:|]\\s*|\\s+)(\\d+)(?:\\s*\\/\\s*(\\d+))?'));
      const before = line.match(new RegExp('(?:^|[\\s，,:：|])(\\d+)\\s*\\/\\s*(\\d+)\\s*' + label + '(?=\\s|[，,。|]|$)'));
      if (after) found.set(label, { count: Number(after[1]), denominator: after[2] === undefined ? null : Number(after[2]) });
      else if (before) found.set(label, { count: Number(before[1]), denominator: Number(before[2]) });
    }
  }
  return found;
}

export function coverageCounts(visible) {
  const found = entries(visible);
  return labels.map((label) => found.get(label)?.count ?? NaN);
}

export function coverageSumMismatch(visible, planned) {
  const found = entries(visible);
  const counts = labels.map((label) => found.get(label)?.count ?? NaN);
  return counts.some(Number.isNaN) || counts.reduce((sum, count) => sum + count, 0) !== planned ||
    labels.some((label) => found.get(label)?.denominator !== null && found.get(label)?.denominator !== planned);
}
