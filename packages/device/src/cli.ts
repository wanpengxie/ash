import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rename, access } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { DEVICE_VERSION, installRelease, serviceDefinition } from "./install";
import type { startDevice, DeviceConfig } from "./main";
import { deviceLogger } from "./log";
import { callLocal } from "./local";
import { serveMcp } from "./mcp";
import { codexHome, codexStatus, installCodex, uninstallCodex } from "./codex-install";
const exec = promisify(execFile);
export async function deviceCli(start: typeof startDevice, args = process.argv.slice(2)): Promise<void> {
  const option = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes("--version")) { console.log(DEVICE_VERSION); return; }
  const command = args[0]?.startsWith("--") ? "run" : args[0] ?? "help";
  const root = resolve(option("--root") ?? join(homedir(), ".ash-device")), configPath = resolve(option("--config") ?? join(root, "device.json"));
  if (command === "run") { const log = deviceLogger(join(dirname(configPath), "logs")); console.log = log; console.error = log; }
  const serviceFile = process.platform === "darwin" ? join(homedir(), "Library/LaunchAgents/ai.ash.device.plist") : join(homedir(), ".config/systemd/user/ash-device.service");
  if (command === "setup") {
    const gateway = option("--gateway"), pair = option("--pair");
    if (!gateway || !pair) throw new Error("setup requires --gateway URL --pair CODE");
    const url = new URL(gateway); if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Use HTTPS for the gateway");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const config: DeviceConfig = { gateway, name: option("--name") ?? hostname(),
      stateDir: join(root, "state"), workdir: resolve(option("--workdir") ?? join(homedir(), "ash-shared")), installRoot: root };
    await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    console.log("Open Ash and approve this computer's pairing request. Choose what it may do: lend its abilities, be a body, run local agents, web access.");
    const running = await start(config, pair); await running.close();
    if (args.includes("--no-service")) { console.log(`Paired. Start with: ash-device run --config ${configPath}`); return; }
    await mkdir(dirname(serviceFile), { recursive: true });
    await writeFile(serviceFile, serviceDefinition(root, process.platform, process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"), { mode: 0o600 });
    if (process.platform === "darwin") {
      const domain = `gui/${process.getuid!()}`;
      await exec("launchctl", ["bootout", domain, serviceFile]).catch(() => {});
      await exec("launchctl", ["bootstrap", domain, serviceFile]);
    } else {
      await exec("systemctl", ["--user", "daemon-reload"]); await exec("systemctl", ["--user", "enable", "--now", "ash-device.service"]);
      console.log("For service after logout, enable lingering if desired: loginctl enable-linger");
    }
    console.log("Ash device is paired and its user service is running."); return;
  }
  if (command === "mcp") {
    // The Codex App starts this; stdout is the protocol, so nothing else is printed here.
    const socket = await readFile(configPath, "utf8").then((text) => join(JSON.parse(text).stateDir, "mcp.sock"), () => null);
    await serveMcp({ call: (tool, toolArgs, session) => socket ? callLocal(socket, tool, toolArgs, session) : Promise.reject(new Error(`ash-device is not set up on this computer (no ${configPath}); run ash-device setup first`)) });
    return;
  }
  if (command === "codex") {
    const action = args[1], home = option("--codex-home") ?? codexHome();
    if (action === "install") {
      const program = option("--command") ?? join(root, "current", "bin", "ash-device");
      if (!option("--command") && !(await access(program).then(() => true, () => false))) throw new Error(`${program} does not exist; give the ash-device program with --command PATH`);
      for (const line of await installCodex({ codexHome: home, command: resolve(program), args: ["mcp", "--config", configPath] })) console.log(line);
      return;
    }
    if (action === "uninstall") { for (const line of await uninstallCodex({ codexHome: home })) console.log(line); return; }
    if (action === "status") { console.log(JSON.stringify(await codexStatus({ codexHome: home, command: "", args: [] }))); return; }
    console.log("ash-device codex install [--command PATH] [--codex-home DIR] | uninstall | status"); return;
  }
  if (command === "status") {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const pairing = JSON.parse(await readFile(join(config.stateDir, "paired.json"), "utf8").catch(() => "{}"));
    console.log(JSON.stringify({ version: DEVICE_VERSION, configured: true, paired: !!pairing.owner_key, revoked: pairing.revoked === true, config: configPath, workdir: config.workdir })); return;
  }
  if (command === "uninstall") {
    if (process.platform === "darwin") await exec("launchctl", ["bootout", `gui/${process.getuid!()}`, serviceFile]).catch(() => {});
    else await exec("systemctl", ["--user", "disable", "--now", "ash-device.service"]).catch(() => {});
    if (await access(serviceFile).then(() => true, () => false)) await rename(serviceFile, serviceFile + `.disabled-${Date.now()}`);
    console.log(`Service removed. Files, login keys and work are preserved in ${root}.`); return;
  }
  if (command === "update") {
    const version = option("--version-to"), hash = option("--sha256"); if (!version || !hash) throw new Error("update requires --version-to and --sha256");
    console.log(await installRelease(root, version, hash));
    console.log("Restart the ash-device user service to use the update."); return;
  }
  if (command !== "run") { console.log("ash-device setup --gateway URL --pair CODE [--name NAME] [--workdir PATH]\nash-device run | status | update --version-to VERSION --sha256 HASH | uninstall\nash-device codex install | uninstall | status   (let the Codex App use Ash)\nash-device mcp   (the MCP server the Codex App starts)"); return; }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const running = await start(config, option("--pair"), { restart: () => { void running.close().then(() => process.exit(0)); } });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void running.close().then(() => process.exit(0)); });
  await running.run;
  // The connection is over for good (revoked, or the hub speaks another protocol): leave the service stopped, not retrying.
  const paired = JSON.parse(await readFile(join(config.stateDir, "paired.json"), "utf8").catch(() => "{}"));
  console.log(paired.revoked ? "This computer was revoked by its owner; pair it again to reconnect." : "The connection to Ash ended and will not be retried.");
  await running.close();
  process.exit(paired.revoked ? 0 : 1);
}
