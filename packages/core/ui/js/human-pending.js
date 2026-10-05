// A human's answer and execution are separate durable facts.
export function humanPendingOutcome(item) {
  if (!item) return "";
  if (item.state === "waiting") return "等待你回答";
  if (item.state === "answered") return item.type === "approval" ? "已批准，等待 Ash 判断是否继续" : "已回答，等待 Ash 继续";
  if (item.state === "skipped") return `已批准，但不再继续：${item.reason || "任务已变化"}`;
  if (item.state === "withdrawn") return `已撤回${item.reason ? `：${item.reason}` : ""}`;
  if (item.state === "expired") return "已过期，未执行";
  if (item.state === "denied") return "已拒绝，未执行";
  if (item.state === "redeemed") return !item.execution ? "已兑现，执行中" : item.execution.ok ? "已执行完成"
    : `执行未成功：${item.execution.error?.message || "结果未知，请核对"}`;
  return "";
}
