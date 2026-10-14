# owner.mjs: the owner from a command line

One file, no dependencies, Node 22 or newer. It connects to the hub's local link (`ws://127.0.0.1:<port>/link`) as the
owner's human channel: the same connection a phone makes, to say things, read what comes back, answer cards and call words.
Build it from the repository with `node tools/e2e/build-owner.mjs` (the built file is committed; a test fails when it is
out of date). Source: `owner.ts`. Test: `packages/core/test/edges/owner-cli/owner.test.ts`.

## How it is let in

There is one way in, and the tool uses it as it is (SPEC-03 §2.2, "local" row):

1. `Authorization: Bearer <local token>`: the hub makes this token each time it starts and hands it, with the port, to the
   hand app only (`hands.handoff`, then `IHand.attach` over Binder). It lives in memory; it is not in `host.json`, a log or a file.
2. A signature over the hub's challenge with this client's own key (ECDSA P-256). The key is made on first use and kept in
   `--state` (default `~/.ash-owner/identity.json`, mode 600); the hub registers the channel under it (`paired_by=local`),
   and the owner can list or revoke it like any hand (`service:devices`).

There is no test mode, no switch and no environment variable that skips either check. A wrong token is closed with 4001.

**Consequence for an `adb forward`:** the forwarded connection reaches the hub as a loopback connection, but loopback alone
is not trusted: without the token it is refused. Nothing on the phone gives the token to an adb shell, on purpose. So the
tool needs the token from somewhere the owner chose to put it (`--token-file`, `--token-stdin`); see "Where the token
comes from" below.

## Use

```
owner.mjs --port 8765 --token-file ./token say "你好"
owner.mjs --port 8765 --token-file ./token watch 120
owner.mjs --port 8765 --token-file ./token answer <card id> once
owner.mjs --port 8765 --token-file ./token call service:admin status
owner.mjs --port 8765 --token-file ./token call service:history query '{"limit":20}'
owner.mjs --port 8765 --token-file ./token set-key < deepseek-key.txt
```

Connection: `--port N` (or `--url ws://127.0.0.1:N/link`; env `ASH_OWNER_PORT`), the token from `--token-file PATH`
(env `ASH_OWNER_TOKEN_FILE`) or `--token-stdin` (first line). Or both at once from `--link-file PATH` (env
`ASH_OWNER_LINK_FILE`): the `{port, token}` JSON a debug build of the phone app writes (see "On a phone or emulator");
`--port`, `--url` and the token options, when given, win over it. The token and any key are **never arguments**: arguments
land in the shell history and in `ps`. `--state DIR` keeps the identity key (one hand per state dir); `--name` names the channel.

| Command | What it does |
|---|---|
| `say "<text>"` | Sends the text to `agent:main` (`--to agent:x` for another), waits for this round's answer (`say`, `show`, `ask` for the owner), then for `--settle` seconds (default 1.5) of quiet for more bubbles, and prints them. Ends at once on a question waiting for the owner. `--timeout` (default 120 s) gives up with exit 2. `--all` prints every ledger message that arrives, not only those for the owner. |
| `watch [seconds]` | Prints everything that arrives: ledger messages, cards, questions, and `present` frames (notification, status). Default 60 s, 0 = until Ctrl-C. Declares the `chat` and `notification` surfaces (`--surfaces` to change). |
| `answer <id> <option> [text]` | `<id>` is the message id (or seq) of a card. An approval or a question (`ask` line): sends the owner's answer (`once`, `always`, `deny`, or a question's option; free text for cards that allow it). An option card (`card` line): picks that option for the agent that showed it. A second answer to the same card is refused (exit 3). |
| `call <member> <word> ['<json>' \| - \| @file]` | Calls a word as the owner and prints the result. The body is a JSON object: in the argument, on standard input (`-`) or in a file (`@path`). |
| `set-key [REF]` | `service:vault/set` for `REF` (default `DEEPSEEK_API_KEY`), the key from `--key-file PATH` or standard input; nothing of it is printed. |
| `script <file.json>` | A debug hub only. Sends the script to `agent:script` (an agent that makes the calls the script lists, without a model), plays the owner's side while it runs (answering cards, looking at the phone), and checks what must hold. Exit 0 all held, 4 something did not, 2 the reports did not come in time. See [DEVICE-VERIFICATION.md](DEVICE-VERIFICATION.md) and the scripts in `scripts/`. |

### Setting the model key

The owner's word is **`service:vault/set`** with `{ref, value}`; `DEEPSEEK_API_KEY` is the ref the hub's agents and small
model read (`OPENROUTER_API_KEY` for OpenRouter). It is owner-only and local-only: it works only from a channel on the same
machine, which this tool is (local token). Through a relay the hub refuses it.

```
owner.mjs --port N --token-file T set-key < /path/to/deepseek-key.txt        # DEEPSEEK_API_KEY
owner.mjs --port N --token-file T set-key OPENROUTER_API_KEY --key-file k.txt
owner.mjs --port N --token-file T call service:vault list                     # configured: true/false, never a value
```

`call service:vault set '{"ref":"…","value":"…"}'` also works but puts the key in the arguments; use `set-key`, or
`call service:vault set -` with the JSON on standard input. The choice of the main model is a separate word:
`call service:admin model.set '{"provider":"deepseek","model":"…"}'`.

## Output

One line per event on standard output, each starting with a UTC time with milliseconds, then a kind and `key=value`
fields (values with spaces are JSON-quoted). Easy to grep:

```
2026-10-10T15:52:36.491Z conn state=welcomed hand=RxOI… client=client:4puy… local=true
2026-10-10T15:52:36.586Z sent seq=22 id=m_Ny0h… to=agent:main
2026-10-10T15:52:36.943Z msg seq=27 id=m_gFJI… from=agent:main to=person:owner mkind=request word=say text=你好，我在。
2026-10-10T15:52:38.493Z done replies=1 waited_ms=1907
```

Kinds: `conn`, `sent`, `msg` (a message), `card` (an option card: `options=a:text,b:text`), `ask` (an approval or a question:
`options=once:…,always:…,deny:…`), `present`, `history` (`--history N`), `result` (of `call`), `answered`, `timeout`, `done`,
`error`. `--json` prints one JSON object per line (`at`, `kind`, the same fields, and `raw` for the ledger message or frame).

Exit codes: 0 done; 1 cannot connect or refused (4001: wrong token; 4003: revoked); 2 `say` got no reply in time;
3 the hub refused or failed a word; 64 usage.

## Where the token comes from

Only the hand app holds it. What is available without touching the hub:

- On a machine where the hub runs as a plain process (tests, `startHub` with a fake host), the host's `hands.handoff` call
  carries it: that is how `packages/core/test/scenarios` and this tool's test get it.
- On a phone, nothing hands it to an outside process, with one exception that exists only in a **debuggable** build of
  the hand app (see "On a phone or emulator" below).
- The relay carries only computers' own connections, end to end encrypted (docs/LINK-E2E.md); it serves no page and opens no
  human channel. This tool does not speak the relay.

## On a phone or emulator (debuggable build only)

A debuggable build of the hand app (`ai.ash.agent`, `assembleDebug`) writes the connection it was handed to its own
private directory, each time the kernel host attaches: `files/debug/local-link.json`, mode 0600, `{"port":…,"token":"…","at":<ms>}`.
It is replaced atomically when the token changes, and deleted when the kernel host lets go of the hand app (unbinds) and
when the app process starts again. A release build never writes it: the code is off unless both `BuildConfig.DEBUG` and the
package's `FLAG_DEBUGGABLE` are set, and only a debuggable package can be read with `run-as`, so a release build adds no way in.

```
adb shell run-as ai.ash.agent cat files/debug/local-link.json > link.json && chmod 600 link.json
PORT=$(node -p 'require("./link.json").port')
adb forward tcp:$PORT tcp:$PORT                     # same number on both sides, so --link-file alone is enough
node tools/e2e/owner.mjs --link-file link.json say "你好"
```

If the local port must differ, forward `adb forward tcp:<local> tcp:<port>` and add `--port <local>`; the token still comes
from the file. Without `--link-file`, take `port` and `token` out of the JSON yourself, keep the token in a 0600 file and give
that to `--token-file` (`node -p 'require("./link.json").token' > token && chmod 600 token`). Remember the token is never an argument.

**The token changes every time the hub starts** (a phone restart, the kernel host restarting the hub, a reinstall). After
that, `link.json` is stale and the hub closes the connection with 4001: read the file from the phone again. If the file is
missing, the kernel host has not attached yet (or has let go): open the app and wait for it to say it is connected.
The file holds the token in clear, so keep your copy private and delete it when you are done.

# 真机场景 (real-phone scenarios): `scenarios.mjs`

One more file with no dependencies (Node 22 or newer), next to `owner.mjs`. It is the old real-phone regression
(`tools/regress.sh` R1-R21) and the key use scenarios of `spec/REGRESSION-0.3.md` rewritten for the new hub, as scripts that
run on the machine that has adb (a MacBook with the phone or emulator attached). There is nothing to build: copy
`owner.mjs` and `scenarios.mjs` into one folder and run it.

```
adb devices                                    # the serial
node scenarios.mjs --serial <serial> --link-file link.json                 # everything
node scenarios.mjs --serial <serial> --link-file link.json --only R19,S085 # some
node scenarios.mjs --list                                                   # what there is
```

Before you start: a **debuggable** build of the hand app (`assembleDebug`, so that `run-as` works), the app has connected
(the kernel attached: open it once and wait for it to say so), the phone is awake and not behind a PIN (the script sends
WAKEUP and dismisses the keyguard, which a PIN refuses), and for the scenarios that talk to the agent a model key is set.

What it does with `adb` and `owner.mjs`:

- **The link.** `run-as ai.ash.agent cat files/debug/local-link.json` is written to `--link-file` (mode 600) and the port is
  forwarded (`adb forward`). The token changes every time the hub starts, so the script reads it again whenever a call is
  refused or the hub is not there, and after every scenario that restarts the hub. Nothing else is needed from you.
- **Acting.** Words are called as the owner (`owner.mjs call`), the agent is spoken to with `say`, and the phone is touched
  with `input keyevent`, `monkey`, `cmd statusbar`, `cmd notification post`. The state it changes (approval mode, the
  phone's trust tier, settings, timers, test apps, a sub-agent) it puts back, also when the scenario fails.
- **Judging.** Only facts: the ledger (`service:history/query` after a marker: which word was called and on which member,
  whether a card came and with which options, the answer code of a request, turn lanes and outcomes), the phone's own report
  (`config.status`), `dumpsys window` (foreground package), `dumpsys notification` (what was posted), `dumpsys meminfo`,
  `ps` (the hub and DSH). It never judges what the agent says. Anything that goes through the model is asked for in a way that
  forces one word ("call `clipboard.set` with ..."), and the verdict is whether that word was called.

Output is one line per scenario, `PASS|FAIL|SKIP|MANUAL <id> <name> -- <detail>`, then `SUMMARY`. Exit code 0 when nothing
FAILed, 1 otherwise, 2 when it could not start (no adb, no device, no link), 64 for bad arguments.

| Status | Meaning |
|---|---|
| `PASS` / `FAIL` | Judged by facts. A FAIL also leaves `<shots>/<id>-fail.png`. |
| `SKIP` | A need is missing; the line says what to switch on (the table below), or the situation could not be made (for example the model was too fast for "busy"). |
| `MANUAL` | The automatic part ran and its result is in the line; the rest needs an eye. The screenshots are in `--shots` (default `./shots`), named after the scenario: `S114-running.png`. |

Options: `--only LIST` (ids, old numbers, categories, `all`), `--skip LIST`, `--safe` (leave out what kills a process),
`--shots DIR`, `--report FILE` (JSON), `--timeout-scale X` (slow phone or network), `--alt-model provider/model` (S157),
`--manual-wait S` (S033 waits this long for the tap on the notification, 0 = no wait), `--package`, `--kernel-package`,
`--owner`, `--adb`, `--state`. `node scenarios.mjs --help` has the rest. The scenarios that kill the hub or DSH run last.

## The scenarios

Each is named by the old number it replaces (`R` is `tools/regress.sh`, `S` is REGRESSION-0.3; the third column is what else it covers).

| Id | Scenario | Also covers | |
|---|---|---|---|
| **Smoke (already proven on a phone; quick re-check)** | | | |
| `R6` | 对话：主 agent 一轮回复 | S057 | auto |
| `S028` | 首次见面：账本最前面是 agent 先开口 | | auto (SKIP on a used install) |
| `S082` | 提醒（前台）：到点消息落进对话 | | auto |
| `S075` | 提醒（后台）：回到桌面后到点出系统通知 | 设备23 | auto |
| `S161` | 用量：一轮之后今日调用数增加 | | auto |
| `S174` | 内存压测：连续多轮后中枢没有重启、内存有界 | | auto |
| **Conversation** | | | |
| `R17` | 连发：忙时连发三条，不会每条各开一轮 | S002, S003 | auto |
| `R18` | 插话停：说「停下」，在途的一轮被取消 | S004 | auto |
| `S016` | 选项卡：出卡、点选、下一轮收到 | | auto |
| `S005` | 对话失败重试：DSH 在回答中途被杀，出失败提示和 [重试]，点了能做完 | S006-S009 | auto, kills DSH |
| **Approval** | | | |
| `R19` | 审批：出卡、批一次、只执行一次 | | auto |
| `S032` | 审批：拒绝后不执行，发起者被告知 | | auto |
| `S036` | 审批：以后都可以 → 生成规则，再来不出卡 | S034, S035, S037, S038 | auto |
| `S039` | 审批：过期作废，迟到的批准不执行 | | auto (SKIP if the agent does not shorten the ttl) |
| `S033` | 通知上答审批：系统通知出现自动查，点按钮由人 | 人场景8 | MANUAL |
| **Sub-agents** | | | |
| `S046` | 子 agent：主 agent 建、启动、问、告诉 | S049, S050 | auto |
| `S048` | 子 agent：主人直接对话，在被点名那一轮能回人 | | auto |
| `S051` | 子 agent：后台（非被点名）那一轮不能对主人说话 | | auto |
| **Phone abilities** | | | |
| `S085` | agent 经窄腰调手机的词（查电量） | 设备20 | auto |
| `S086` | 日历（列日历、查未来 30 天） | | auto |
| `S087` | 位置 | | auto |
| `S088` | 相册（相册列表、图片列表、读一张） | | auto |
| `S026` | 文件：主人直接在主 body 里写、读、列文件 | 人场景27 | auto |
| `S089` | 读通知（adb 发一条，感知档案里查到） | | auto |
| `S090` | 电量（和 `dumpsys battery` 对得上） | | auto |
| `S091` | 剪贴板（写入再读出） | | auto |
| `S092` | 打开应用（设置），前台包名对 | | auto |
| `S093` | 打开网址，前台换成了浏览器 | | auto |
| `S094` | 浏览器任务（开页、读页、截图、关） | | auto |
| `S094b` | 屏幕读取和操作（无障碍） | S095 | auto |
| `S094c` | 后台也能动手（调试身份上的虚拟屏；没有任意命令） | 设备33 | auto |
| **Apps** | | | |
| `S119` | 脚手架生成、校验通过 | | auto |
| `S120` | agent 要装 → 出审批卡（不提供“以后都可以”），批了才装上 | | auto |
| `S121` | 主人装（授权）、停用、启用、收回授权 | S125 | auto |
| `S122` | 页面（surface）和图标 | 设备39 | auto |
| `S123` | 调应用自己的工具（加一条、读出来） | | auto |
| `S124` | 内置 health 在、能描述；已授权时读工具可调 | 设备37 | auto |
| **Senses and pulse** | | | |
| `S097` | 屏幕开关事件进感知档案，不进账本；感知器官在运行 | S100, S102, S103 | auto |
| `S066` | pulse：手动触发一次，后台线醒一轮 | S067 | auto (SKIP without an 'Ash 卡片' widget) |
| `S061` | 每日复盘：把复盘时刻设到两分钟后，后台线被叫醒 | S062, S063 | auto (SKIP when today's review already went out) |
| **Settings** | | | |
| `S164` | 暂停 / 继续：暂停期间不开新一轮，继续后恢复 | S165, R5 | auto |
| `S159` | 密钥：存进保险箱，列表只见“已配置”，账本里没有明文，删除后消失 | S160 | auto |
| `S163` | DSH 插件：列出、关掉再打开一个社区插件 | R16, S167 | auto (SKIP without a community plug-in) |
| `S157` | 模型切换：切到另一个模型，重启 DSH 和中枢后仍保持，换回 | S158, S162 | auto, kills the hub |
| `R20` | 设置跨重启：安静时段和暂停状态杀中枢后仍在 | S166 | auto, kills the hub |
| **Recovery** | | | |
| `S040` | 审批卡等待时杀中枢，重启后重新出卡，批了照样只执行一次 | | auto, kills the hub |
| `S170` | 一轮进行中杀中枢，重启后这条消息不重放，agent 被告知上一轮中断 | S171, R4 | auto, kills the hub |
| `S168` | DSH 进程被杀后自动拉起，下一句话能答 | | auto, kills DSH |
| **Eyes** | | | |
| `S114` | 任务岛：任务进行中截屏，再从中枢停掉这一轮 | S115-S118 | MANUAL |

Not rewritten: R1 and R3 (fresh install, reboot: they take the phone away), R2 (update over the top: it needs an APK to install), R7-R9 and R14-R15 (the gateway, the paired laptop, an image in chat: other tools), R11-R12 (the DSH ecosystem checks: S163 covers switching a community plug-in; "as published" is checked by the container build), R21 (the memory loop of the old design, replaced by the daily review S061).

## What the phone must allow (`SKIP` tells you which)

The hand app reports its own switches (`config.status`); a scenario that needs one that is `missing` is skipped with the line
below. Replace `$S` by the serial and `ai.ash.agent` by `--package` if you changed it.

| Need (`config.status` item) | Scenarios | How to switch it on |
|---|---|---|
| `calendar` | S086 | `adb -s $S shell pm grant ai.ash.agent android.permission.READ_CALENDAR` (and `WRITE_CALENDAR`) |
| `location` | S087 | `pm grant ai.ash.agent android.permission.ACCESS_FINE_LOCATION` (and `ACCESS_COARSE_LOCATION`); an emulator also needs a fix: `adb -s $S emu geo fix 121.47 31.23` |
| `location_background` | (reading in the background) | `pm grant ai.ash.agent android.permission.ACCESS_BACKGROUND_LOCATION` |
| `activity_recognition` | activity sense | `pm grant ai.ash.agent android.permission.ACTIVITY_RECOGNITION` |
| `photos` | S088 | `pm grant ai.ash.agent android.permission.READ_MEDIA_IMAGES` (Android 13+, else `READ_EXTERNAL_STORAGE`), and `ACCESS_MEDIA_LOCATION` |
| `all_files` | files outside the media folders | `adb -s $S shell appops set ai.ash.agent MANAGE_EXTERNAL_STORAGE allow` |
| `notifications` | S075, S033 | `pm grant ai.ash.agent android.permission.POST_NOTIFICATIONS` |
| `notification_listener` and the in-app opt-in | S089 | `adb -s $S shell cmd notification allow_listener ai.ash.agent/ai.ash.caps.senses.NotificationSense`; the opt-in (通知读取) is a switch in the app, no adb command |
| `accessibility` | S094b | `adb -s $S shell settings put secure enabled_accessibility_services ai.ash.agent/ai.ash.caps.screen.A11yService` and `settings put secure accessibility_enabled 1` |
| `usage_access` | app usage | `adb -s $S shell appops set ai.ash.agent GET_USAGE_STATS allow` |
| `overlay` | the island | `adb -s $S shell appops set ai.ash.agent SYSTEM_ALERT_WINDOW allow` |
| `write_settings` | settings words | `adb -s $S shell appops set ai.ash.agent WRITE_SETTINGS allow` |
| `exact_alarm` | exact reminders | `adb -s $S shell appops set ai.ash.agent SCHEDULE_EXACT_ALARM allow` |
| `battery_optimization` | staying alive | `adb -s $S shell dumpsys deviceidle whitelist +ai.ash.agent` (and `+ai.ash.kernel`) |
| `host_shell` | S094c | pair 「后台也能动手」 in Ash's checkup; on a test phone the service can be started over USB with the line in `REMEDY.host_shell` (`tools/e2e/scenarios.mjs`) |

Other needs: a **paired phone** (`phone`: the device is online in `service:devices/list`), a **model key** (`llm`:
`owner.mjs set-key DEEPSEEK_API_KEY < key.txt`), **internet on the phone** (`network`: S093, S094), the **process** can be
killed (`kill`: `run-as ai.ash.kernel kill -9` works on a debuggable kernel build, or use an emulator/rooted shell).
The permission dialogs that `pm grant` cannot reach (accessibility on some makers' ROMs, the notification opt-in, the
battery whitelists of MIUI/ColorOS) are done by hand once.

## Tests of the script

`node --test tools/e2e/scenarios.test.mjs` judges recorded samples (`tools/e2e/fixtures/`: output of `owner.mjs`, ledgers of an
approval, a refusal, a stop, a failed turn with its retry card, busy supplements, a sub-agent whose background turn is refused;
`dumpsys` window/notification/meminfo/battery, `ps`) and drives the runner with stand-ins for adb and `owner.mjs`; it needs no
device. `packages/core/test/edges/owner-cli/scenarios.test.ts` runs the real script against a real hub with a fake `adb`
(fetching the link, the approval flow, pause and resume, sub-agents, an option card, stop and busy messages).
