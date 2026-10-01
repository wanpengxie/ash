// Build only the isolated WebView test package; no main app or user data is touched.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = dirname(fileURLToPath(import.meta.url));
const root = join(source, "../../../../..");
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const javaHome = process.env.JAVA_HOME;
if (!sdk || !javaHome) throw new Error("ANDROID_HOME and JAVA_HOME are required");
const platform = join(sdk, "platforms/android-35/android.jar");
const tools = join(sdk, "build-tools/35.0.1");
const java = join(javaHome, "bin");
const temporary = mkdtempSync(join(tmpdir(), "ash-screen-webview-"));
const output = join(root, "build/evidence/ASH-602/screen-probe.apk");
const run = (program, args) => execFileSync(program, args, { stdio: "inherit" });
try {
  mkdirSync(join(temporary, "classes"));
  mkdirSync(join(temporary, "dex"));
  mkdirSync(dirname(output), { recursive: true });
  run(join(tools, "aapt2"), ["link", "-o", join(temporary, "unsigned.apk"), "--manifest", join(source, "AndroidManifest.xml"), "-I", platform, "--min-sdk-version", "26", "--target-sdk-version", "28"]);
  run(join(java, "javac"), ["-source", "17", "-target", "17", "-cp", platform, "-d", join(temporary, "classes"), join(source, "src/ai/ash/v2screenprobe/MainActivity.java")]);
  run(join(tools, "d8"), ["--lib", platform, "--min-api", "26", "--output", join(temporary, "dex"), join(temporary, "classes/ai/ash/v2screenprobe/MainActivity.class"), join(temporary, "classes/ai/ash/v2screenprobe/MainActivity$1.class")]);
  run("zip", ["-j", "-q", join(temporary, "unsigned.apk"), join(temporary, "dex/classes.dex")]);
  run(join(tools, "zipalign"), ["-f", "4", join(temporary, "unsigned.apk"), join(temporary, "aligned.apk")]);
  run(join(java, "keytool"), ["-genkeypair", "-noprompt", "-alias", "probe", "-keyalg", "RSA", "-keysize", "2048", "-validity", "30", "-dname", "CN=Isolated Screen Probe", "-keystore", join(temporary, "probe.keystore"), "-storepass", "android", "-keypass", "android"]);
  run(join(tools, "apksigner"), ["sign", "--ks", join(temporary, "probe.keystore"), "--ks-key-alias", "probe", "--ks-pass", "pass:android", "--key-pass", "pass:android", "--out", output, join(temporary, "aligned.apk")]);
  run(join(tools, "apksigner"), ["verify", "--verbose", output]);
  process.stdout.write(`${output}\n`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
