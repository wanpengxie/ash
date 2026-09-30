import { resolve } from "node:path";
import { checkRepository } from "../packages/core/test/arch/checks";

const findings = checkRepository(resolve(process.argv[2] ?? "."), process.env.ASH_ARCH_PRIVATE_TERMS_FILE);
for (const f of findings) process.stderr.write(`${f.rule} ${f.file}: ${f.detail}\n`);
process.stdout.write(`Architecture gate: ${findings.length ? "NOT YET CONFORMANT" : "PASS"} (${findings.length} findings)\n`);
if (findings.length) process.exitCode = 1;
