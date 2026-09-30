// Extract category counts from a review answer regardless of its section title.
export function coverageCounts(visible) {
  const labels = ['已核实', '部分核实', '未完成', '待返回'];
  return labels.map((label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const after = visible.match(new RegExp('(?:^|[\\s，,|*])' + escaped + '\\*{0,2}\\s*[：:|]?\\s*(\\d+)(?=\\s*(?:题|[（(、，,|\\n]|$))', 'm'));
    const ratio = visible.match(new RegExp('(?:^|[\\s，,:：|*])(\\d+)\\s*\\/\\s*\\d+\\s*' + escaped + '(?=\\s|[，,。|]|$)', 'm'));
    return after ? Number(after[1]) : ratio ? Number(ratio[1]) : NaN;
  });
}

export function coverageSumMismatch(visible, planned) {
  const counts = coverageCounts(visible);
  return counts.some(Number.isNaN) || counts.reduce((sum, count) => sum + count, 0) !== planned;
}
