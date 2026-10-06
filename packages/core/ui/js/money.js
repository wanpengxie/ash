// Fixed display estimate, not a live FX quote. Rounded from CFETS's 2026-09-28
// USD/CNY fixing (6.7399): https://www.chinamoney.org.cn/chinese/ccprnoticecontent/index.html?searchDate=2026-09-28
// Model catalogs and historical usage records remain denominated in USD.
export const CNY_PER_USD = 6.74;
export const CNY_ESTIMATE_NOTE = `人民币按 1 美元 ≈ ${CNY_PER_USD} 元固定换算，仅供估算，不是账单。`;
const yuan = (value) => `¥${value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
export const usdToCnyText = (value) => typeof value === "number" && Number.isFinite(value) ? yuan(value * CNY_PER_USD) : "—";
export function balanceText(balance) {
  const total = Number(balance.total);
  if (balance.total == null || balance.total === "" || !Number.isFinite(total)) return "—";
  if (balance.currency === "CNY") return yuan(total);
  if (balance.currency === "USD") return `约 ${usdToCnyText(total)}`;
  return `${balance.total} ${balance.currency}`;
}
