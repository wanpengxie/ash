import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { redactText } from "./redact";

/** Bounded operational logs only. Runtime stdout/stderr and workspace output are not logged. */
export function deviceLogger(root: string, maxBytes = 1024 * 1024) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, "device.log");
  let bytes = existsSync(file) ? statSync(file).size : 0;
  return (...args: unknown[]) => {
    const line = `${new Date().toISOString()} ${redactText(format(...args)).slice(0, 4096)}\n`;
    try {
      if (bytes + Buffer.byteLength(line) > maxBytes) {
        if (existsSync(file + ".3")) unlinkSync(file + ".3");
        for (let i = 2; i >= 1; i--) if (existsSync(file + `.${i}`)) renameSync(file + `.${i}`, file + `.${i + 1}`);
        if (existsSync(file)) renameSync(file, file + ".1");
        bytes = 0;
      }
      appendFileSync(file, line, { mode: 0o600 }); bytes += Buffer.byteLength(line);
    } catch { /* Logging failure must not replay or interrupt a task. */ }
  };
}
