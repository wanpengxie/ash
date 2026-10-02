#!/bin/bash
# Regression checklist on a device/emulator (run on the machine with adb).
#
#   APK=app-debug.apk tools/regress.sh [R1 R2 …]        (default: R2 R4 R5 R6 R7 R8 R9 R11 R12)
#
# Needs: adb (one device), node ≥ 22, curl. Optional env:
#   GATEWAY_URL and GATEWAY_TICKET  connected gateway and an owner pairing ticket (R7, R9)
#   LAPTOP_SHARE     directory the paired laptop lends as "files" (R8), default ~/ash-shared
# R1 (fresh install) and R3 (reboot) are destructive/slow and only run when named.
# Secrets never reach the output: tokens are read on the device and used in-process only.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG=${ASH_REGRESS_PACKAGE:-ai.ash.agent.probe}
F=/data/user/0/$PKG/files
PORT=${ASH_REGRESS_PORT:-14763}
PASS=0; FAIL=0; RESULTS=()

say() { printf '\n== %s\n' "$*"; }
ok() { PASS=$((PASS+1)); RESULTS+=("✅ $1"); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL+1)); RESULTS+=("❌ $1${2:+ — $2}"); echo "  ✗ $1${2:+ — $2}"; }

# run a script as the app (heredocs need a writable TMPDIR under run-as)
asr() { printf 'export TMPDIR=%s/../cache/tmp; mkdir -p $TMPDIR; cd %s\n%s\n' "$F" "$F" "$1" | adb shell "run-as $PKG sh" 2>/dev/null; }
token() { asr "cat ash/state/tokens.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).api;process.stdout.write(Object.keys(t).find(k=>t[k]==="person:owner")||"")})'; }
fwd() { adb forward tcp:$PORT tcp:$PORT >/dev/null; }
api() { # api METHOD PATH [JSON]
  local t; t=$(token); fwd
  if [ $# -ge 3 ]; then curl -s -m 30 -X "$1" -H "authorization: Bearer $t" -H 'content-type: application/json' -d "$3" "http://127.0.0.1:$PORT$2"
  else curl -s -m 30 -X "$1" -H "authorization: Bearer $t" "http://127.0.0.1:$PORT$2"; fi
}
jq_() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);const f=new Function("v","return ("+process.argv[1]+")");const r=f(v);process.stdout.write(typeof r==="string"?r:JSON.stringify(r))}catch(e){process.stdout.write("")}})' "$1"; }
core_status() { local t; t=$(token) || return 1; fwd; curl -s -o /dev/null -w '%{http_code}' -m 5 -H "authorization: Bearer $t" "http://127.0.0.1:$PORT/api/describe?member=agent:main"; }
session_id() { asr 'cat ash/state/dsh-main-session.json' | jq_ 'v.id||""'; }
core_pids() { adb shell ps -A -o PID,ARGS 2>/dev/null | grep -F "$F/payload/ash/ash-core.mjs --config" | awk '{print $1}'; }
wait_online() { # wait_online SECONDS
  local end=$((SECONDS+$1))
  while [ $SECONDS -lt $end ]; do [ "$(core_status)" = "200" ] && return 0; sleep 3; done; return 1
}
control() { adb shell am broadcast -n $PKG/ai.ash.host.ControlReceiver -a "ai.ash.$1" >/dev/null; }
rows() { api GET "/api/stream?follow=false&limit=1000&after=${1:-0}" | sed -n 's/^data: //p' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const line of s.split("\n")){try{const row=JSON.parse(line);if(Number.isSafeInteger(row.seq)&&row.id&&row.word)console.log(JSON.stringify(row))}catch{}}})'; }
last_seq() { api GET '/api/stream?follow=false&limit=1' | sed -n 's/^id: //p' | tail -1 | tr -d '\r'; }
admin() { local word=$1 body=$2; api POST /api/send "$(node -e 'console.log(JSON.stringify({to:"service:admin",kind:"request",word:process.argv[1],body:JSON.parse(process.argv[2]),wait:true,client_id:crypto.randomUUID()}))' "$word" "$body")" | jq_ 'v.reply?.body||{}'; }
send_say() { local id="regress-$RANDOM$RANDOM"; api POST /api/send "$(node -e 'console.log(JSON.stringify({to:"agent:main",kind:"request",word:"say",body:{text:process.argv[1]},client_id:process.argv[2]}))' "$1" "$id")" | jq_ 'v.id||""'; }
owner_request() { # owner_request TARGET WORD JSON_BODY
  local id="regress-$RANDOM$RANDOM"
  api POST /api/send "$(node -e 'console.log(JSON.stringify({to:process.argv[1],kind:"request",word:process.argv[2],body:JSON.parse(process.argv[3]),wait:true,client_id:process.argv[4]}))' "$1" "$2" "$3" "$id")"
}
wait_row() { # wait_row SECONDS JS_EXPRESSION, where v is the array of new ledger rows
  local end=$((SECONDS+$1)) after="${3:-0}" found
  while [ "$SECONDS" -lt "$end" ]; do
    found=$(rows "$after" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=s.trim().split("\n").filter(Boolean).map(x=>JSON.parse(x));const r=new Function("v","return ("+process.argv[1]+")")(v);if(r)process.stdout.write(JSON.stringify(r))})' "$2")
    [ -n "$found" ] && { echo "$found"; return 0; }
    sleep 1
  done
  return 1
}
deliver_and_wait() { # deliver_and_wait TEXT SECONDS [ATTACHMENTS_JSON] → agent reply text
  wait_online 300 || return 1
  local from; from=$(last_seq)
  local id="regress-$RANDOM$RANDOM"
  local accepted; accepted=$(api POST /api/send "$(node -e 'const a=process.argv[3]?JSON.parse(process.argv[3]):[];console.log(JSON.stringify({to:"agent:main",kind:"request",word:"say",body:{text:process.argv[1],...(a.length?{attachments:a}:{})},client_id:process.argv[2]}))' "$1" "$id" "${3:-}")" | jq_ 'v.id||""')
  [ -n "$accepted" ] || return 1
  local end=$((SECONDS+$2))
  while [ $SECONDS -lt $end ]; do
    local r; r=$(rows "${from:-0}" | ASH_INPUT_ID="$accepted" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=s.trim().split("\n").filter(Boolean).map(x=>JSON.parse(x));const start=e.find(x=>x.word==="turn.start"&&x.body?.ids?.includes(process.env.ASH_INPUT_ID));if(!start)return;const turn=start.body.turn;const done=e.find(x=>x.word==="turn.end"&&x.body?.turn===turn);if(!done)return;const out=e.filter(x=>x.from==="agent:main"&&x.to==="person:owner"&&x.word==="say"&&x.turn===turn).map(x=>x.body?.text).filter(Boolean).join("\n");process.stdout.write(out||`(${done.body?.reason}: ${done.body?.error||""})`)})')
    [ -n "$r" ] && { echo "$r"; return 0; }
    sleep 3
  done
  return 1
}

R1() { say "R1 fresh install → first start"
  [ -n "${APK:-}" ] || { bad R1 "APK not set"; return; }
  adb uninstall $PKG >/dev/null 2>&1; adb install "$APK" >/dev/null || { bad R1 "install failed"; return; }
  adb shell am start -n $PKG/ai.ash.ui.HomeActivity >/dev/null
  if wait_online 900; then ok "R1 installs the payload, starts ash core, the main agent exists ($(session_id))"; else bad R1 "not online after 15 min"; fi
}
R2() { say "R2 update over the top (no force-stop, app not opened)"
  [ -n "${APK:-}" ] || { bad R2 "APK not set"; return; }
  local before; before=$(session_id)
  adb install -r "$APK" >/dev/null || { bad R2 "install failed"; return; }
  if wait_online 900 && [ "$(session_id)" = "$before" ] && [ -n "$before" ]; then ok "R2 back after the update without opening the app; same main session"; else bad R2 "session before=$before after=$(session_id)"; fi
}
R3() { say "R3 reboot"
  local before; before=$(session_id)
  adb reboot; adb wait-for-device
  until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 3; done
  if wait_online 600 && [ "$(session_id)" = "$before" ]; then ok "R3 starts at boot; same main session"; else bad R3 "not back or session changed"; fi
}
R4() { say "R4 kill -9 ash core"
  local p; p=$(core_pids | head -1)
  [ -n "$p" ] || { bad R4 "no core running"; return; }
  asr "kill -9 $p"
  sleep 5
  if wait_online 180 && [ "$(core_pids | wc -l | tr -d ' ')" = "1" ]; then ok "R4 back within 3 min, exactly one core process"; else bad R4 "pids: $(core_pids | tr '\n' ' ')"; fi
}
R5() { say "R5 stop / start"
  control STOP
  local end=$((SECONDS+30)); while [ $SECONDS -lt $end ] && [ -n "$(core_pids)" ]; do sleep 2; done
  sleep 20
  if [ -z "$(core_pids)" ]; then ok "R5 stop keeps the core down"; else bad R5 "core still running after stop"; fi
  control START
  if wait_online 300; then ok "R5 start brings it back"; else bad R5 "not back after start"; fi
}
R6() { say "R6 the main agent answers"
  local r; r=$(deliver_and_wait "用一句话回答：你叫什么名字？你的工作目录（cwd）的绝对路径是什么？" 240)
  echo "    reply: ${r:0:200}"
  if echo "$r" | grep -qi "ash" && echo "$r" | grep -q "ash-home"; then ok "R6 replies as Ash, working in ash-home"; else bad R6 "unexpected reply"; fi
}
R7() { say "R7 web through the gateway (a temporary paired browser)"
  [ -n "${GATEWAY_URL:-}" ] && [ -n "${GATEWAY_TICKET:-}" ] || { bad R7 "GATEWAY_URL/TICKET not set"; return; }
  fwd
  if ASH_TOKEN="$(token)" ASH_URL="http://127.0.0.1:$PORT" GATEWAY_URL="$GATEWAY_URL" node "$HERE/regress-remote.bundle.mjs" web; then ok "R7 a paired browser uses Ash through the gateway (UI, message, streamed answer)"; else bad R7; fi
}
R8() { say "R8 the agent uses the paired laptop"
  local share="${LAPTOP_SHARE:-$HOME/ash-shared}" name="regress-$(date +%s).txt"
  wait_online 300 || { bad R8 "agent not online"; return; }
  adb shell input keyevent 3 >/dev/null 2>&1
  local from ask end; from=$(last_seq)
  [ -n "$(send_say "用你电脑（笔记本）上的文件工具，在共享目录 ${share} 里新建文件 ${name}，内容写 ok，然后列出该目录确认。")" ] || { bad R8 "request not accepted"; return; }
  # Borrowed laptop capabilities are structure risk: the owner approves the write from the notification.
  ask=$(wait_row 180 "v.find(x=>x.kind==='request'&&x.word==='ask'&&x.to==='person:owner'&&String(x.body?.source?.word||'').startsWith('files.'))" "$from") || true
  [ -z "$ask" ] || tap_notification_action "$(echo "$ask" | jq_ 'v.body.options.find(o=>o.id==="once").label')" || true
  end=$((SECONDS+120)); while [ $SECONDS -lt $end ] && [ ! -f "$share/$name" ]; do sleep 3; done
  if [ -f "$share/$name" ]; then ok "R8 the agent wrote $share/$name on the laptop through ash"; rm -f "$share/$name"; else bad R8 "file not on the laptop"; fi
}
R9() { say "R9 phone offline → the browser is told; back → reconnects"
  [ -n "${GATEWAY_URL:-}" ] && [ -n "${GATEWAY_TICKET:-}" ] || { bad R9 "GATEWAY_URL/TICKET not set"; return; }
  fwd
  local pairfile; pairfile=$(mktemp "${TMPDIR:-/tmp}/ash-regress-browser.XXXXXX") || { bad R9 "cannot create temporary pair state"; return; }
  chmod 600 "$pairfile"
  ASH_TOKEN="$(token)" ASH_URL="http://127.0.0.1:$PORT" GATEWAY_URL="$GATEWAY_URL" node "$HERE/regress-remote.bundle.mjs" pair > "$pairfile" || { rm -f "$pairfile"; bad R9 "pairing failed"; return; }
  control STOP; local end=$((SECONDS+40)); while [ $SECONDS -lt $end ] && [ -n "$(core_pids)" ]; do sleep 2; done; sleep 5
  local off; off=$(GATEWAY_URL="$GATEWAY_URL" node "$HERE/regress-remote.bundle.mjs" status < "$pairfile")
  control START; wait_online 300
  local on=""; end=$((SECONDS+120)); while [ $SECONDS -lt $end ]; do on=$(GATEWAY_URL="$GATEWAY_URL" node "$HERE/regress-remote.bundle.mjs" status < "$pairfile"); [ "$on" = "200" ] && break; sleep 5; done
  fwd; ASH_TOKEN="$(token)" ASH_URL="http://127.0.0.1:$PORT" node "$HERE/regress-remote.bundle.mjs" unpair < "$pairfile" >/dev/null; rm -f "$pairfile"
  if [ "$off" = "503" ] && [ "$on" = "200" ]; then ok "R9 offline shows 503 to the browser; it reconnects by itself"; else bad R9 "offline=$off online=$on"; fi
}
R11() { say "R11 DSH ecosystem: install a community plugin with DSH's own plugin manager"
  asr "export HOME=$F PATH=$F/payload/bin:$F/payload/runtime/bin:/system/bin DSH_HOME=$F/dsh-home TMP=\$TMPDIR OPENSSL_CONF=$F/payload/runtime/etc/tls/openssl.cnf SSL_CERT_FILE=$F/payload/runtime/etc/tls/cert.pem; dsh plugin --profile ash-v2 add dsh-mnemon 2>&1 | tail -3"
  control RESTART; sleep 10; wait_online 300
  local bundles; bundles=$(admin plugins.list '{}' | jq_ '(v.result?.bundles||[]).filter(b=>JSON.stringify(b).includes("dsh-mnemon")).length')
  if [ "${bundles:-0}" -gt 0 ]; then ok "R11 dsh-mnemon installed and loaded ($bundles bundle); survives a restart"; else bad R11 "no mnemon bundle"; fi
}
R12() { say "R12 DSH is byte-for-byte as published"
  adb push "$HERE/verify-dsh.mjs" /data/local/tmp/verify-dsh.mjs >/dev/null
  local got; got=$(asr "$F/payload/runtime/bin/node /data/local/tmp/verify-dsh.mjs $F/payload/dsh/lib/node_modules/@deepseek-ai/dsh" | tr -d '\r')
  # The build compared the payload with a same-moment desktop install and recorded the result.
  local ref; ref=$(asr "cat $F/payload/payload-index.json" | jq_ 'v.dshVerify||""')
  echo "    phone:     $got"; echo "    at build:  ${ref:-?}"
  if [ -n "$ref" ] && [ "$got" = "$ref" ]; then ok "R12 DSH on the phone is exactly what the build verified against a desktop install"; else bad R12 "mismatch or no reference"; fi
}

R14() { say "R14 npm-installed CLIs, npx and python venv work (Android has no /usr/bin/env)"
  local px; px=$(adb shell settings get global http_proxy | tr -d '\r'); [ "$px" = "null" ] && px=""
  local env="export HOME=$F TMPDIR=$F/../cache/tmp PATH=$F/payload/bin:$F/payload/runtime/bin:$F/.npm-global/bin:/system/bin npm_config_prefix=$F/.npm-global npm_config_cache=$F/../cache/npm"
  [ -n "$px" ] && env="$env HTTPS_PROXY=http://$px HTTP_PROXY=http://$px npm_config_https_proxy=http://$px npm_config_proxy=http://$px"
  local out; out=$(asr "$env; cd \$TMPDIR; npm install -g cowsay --no-audit --no-fund >/dev/null 2>&1; cowsay r14-global | head -2; npx -y cowsay r14-npx | head -2; rm -rf r14v; python3 -m venv r14v && r14v/bin/python -m pip --version")
  echo "$out" | sed 's/^/    /' | head -8
  if echo "$out" | grep -q "r14-global" && echo "$out" | grep -q "r14-npx" && echo "$out" | grep -q "^pip "; then ok "R14 global CLIs, npx and venv work"; else bad R14; fi
}

R15() { say "R15 an image sent in the chat reaches the model"
  wait_online 300 || { bad R15 "agent not online"; return; }
  local img; img=$(node -e '
    // 64x64 solid red PNG, built by hand (no deps): zlib-stored scanlines + CRCs.
    const zlib=require("zlib");const w=64,h=64;const raw=Buffer.alloc((w*3+1)*h);for(let y=0;y<h;y++){raw[y*(w*3+1)]=0;for(let x=0;x<w;x++){const o=y*(w*3+1)+1+x*3;raw[o]=230;raw[o+1]=20;raw[o+2]=20}}
    const crc=(b)=>{let c=~0;for(const v of b){c^=v;for(let k=0;k<8;k++)c=(c>>>1)^(0xedb88320&-(c&1))}return ~c>>>0};
    const chunk=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(td));return Buffer.concat([l,td,c])};
    const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
    process.stdout.write(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]).toString("base64"))')
  local attachment; attachment=$(node -e 'console.log(JSON.stringify([{name:"r15.png",mime_type:"image/png",data:process.argv[1]}]))' "$img")
  local r; r=$(deliver_and_wait "这张图片主要是什么颜色？只回答颜色。" 180 "$attachment")
  echo "    reply: ${r:0:120}"
  if echo "$r" | grep -q "红"; then ok "R15 the model sees the attached image (answers red)"; else bad R15 "unexpected reply"; fi
}
R16() { say "R16 plugins: disable and enable through ash settings (DSH's plugin manager)"
  wait_online 300 || { bad R16 "agent not online"; return; }
  local plugin=include:tool-plugin-manager before after restored changed
  before=$(admin plugins.list '{}' | jq_ "v.result?.plugins?.find(p=>p.entryId==='$plugin')?.enabled")
  [ "$before" = "true" ] || [ "$before" = "false" ] || { bad R16 "installed plugin not listed"; return; }
  changed=$(admin plugins.op "{\"op\":\"plugin\",\"id\":\"$plugin\",\"enabled\":$([ "$before" = true ] && echo false || echo true)}" | jq_ 'v.ok===true')
  after=$(admin plugins.list '{}' | jq_ "v.result?.plugins?.find(p=>p.entryId==='$plugin')?.enabled")
  restored=$(admin plugins.op "{\"op\":\"plugin\",\"id\":\"$plugin\",\"enabled\":$before}" | jq_ 'v.ok===true')
  local final; final=$(admin plugins.list '{}' | jq_ "v.result?.plugins?.find(p=>p.entryId==='$plugin')?.enabled")
  echo "    installed plugin: $before → $after → $final"
  if [ "$changed" = true ] && [ "$restored" = true ] && [ "$after" != "$before" ] && [ "$final" = "$before" ]; then ok "R16 installed plugin switches through ash settings"; else bad R16 "plugin switch or restoration unconfirmed"; fi
}

R17() { say "R17 three messages sent during one active turn become one next batch"
  wait_online 300 || { bad R17 "agent not online"; return; }
  local from anchor active ids=() next read
  from=$(last_seq); anchor=$(send_say "请详细分析一个有多个步骤的问题：如何给新用户设计一周的个人助手使用体验？" )
  [ -n "$anchor" ] || { bad R17 "first message not accepted"; return; }
  active=$(wait_row 30 "v.find(x=>x.word==='turn.start'&&x.body?.ids?.includes('$anchor'))" "$from") || { bad R17 "first turn did not start"; return; }
  for text in "补充一：重点是首次使用。" "补充二：要考虑提醒。" "补充三：请用中文回答。"; do
    local id; id=$(send_say "$text"); [ -n "$id" ] || { bad R17 "supplement not accepted"; return; }; ids+=("$id")
  done
  local batch; batch=$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' "${ids[@]}")
  local too_late; too_late=$(rows "$from" | ASH_ANCHOR="$anchor" ASH_LAST="${ids[2]}" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=s.trim().split("\n").filter(Boolean).map(JSON.parse);const start=v.find(x=>x.word==="turn.start"&&x.body?.ids?.includes(process.env.ASH_ANCHOR));const end=v.find(x=>x.word==="turn.end"&&x.body?.turn===start?.body?.turn);const last=v.find(x=>x.id===process.env.ASH_LAST);process.stdout.write(String(Boolean(end&&last&&end.ts<=last.ts)))})')
  [ "$too_late" = false ] || { bad R17 "first turn ended before supplements were sent"; return; }
  next=$(ASH_IDS="$batch" wait_row 300 "v.find(x=>x.word==='turn.start'&&JSON.parse(process.env.ASH_IDS).every(id=>x.body?.ids?.includes(id)))" "$from") || { bad R17 "three supplements did not enter one turn"; return; }
  read=$(ASH_IDS="$batch" wait_row 30 "v.find(x=>x.word==='read'&&JSON.parse(process.env.ASH_IDS).every(id=>x.body?.ids?.includes(id)))" "$from") || { bad R17 "not all three messages marked read"; return; }
  local first_turn next_turn; first_turn=$(echo "$active" | jq_ 'v.body.turn'); next_turn=$(echo "$next" | jq_ 'v.body.turn')
  if [ -n "$first_turn" ] && [ "$next_turn" != "$first_turn" ]; then ok "R17 three busy supplements read together in the next turn"; else bad R17 "supplements joined the wrong turn"; fi
}

R18() { say "R18 explicit stop cancels the active turn, without stopping the next turn"
  wait_online 300 || { bad R18 "agent not online"; return; }
  local from anchor active stop decision ended next
  from=$(last_seq); anchor=$(send_say "请详细分析一个有多个步骤的问题：如何给新用户设计一周的个人助手使用体验？")
  [ -n "$anchor" ] || { bad R18 "first message not accepted"; return; }
  active=$(wait_row 30 "v.find(x=>x.word==='turn.start'&&x.body?.ids?.includes('$anchor'))" "$from") || { bad R18 "first turn did not start"; return; }
  local turn; turn=$(echo "$active" | jq_ 'v.body.turn')
  stop=$(send_say "停")
  [ -n "$stop" ] || { bad R18 "stop message not accepted"; return; }
  decision=$(wait_row 15 "v.find(x=>x.word==='reflex.judged'&&x.body?.message_id==='$stop')" "$from") || { bad R18 "no reflex decision"; return; }
  ended=$(wait_row 15 "v.find(x=>x.word==='turn.end'&&x.body?.turn==='$turn')" "$from") || { bad R18 "active turn did not end"; return; }
  next=$(wait_row 30 "v.find(x=>x.word==='turn.start'&&x.body?.ids?.includes('$stop'))" "$from") || { bad R18 "stop message was not admitted to the next turn"; return; }
  local judged_at requested_at elapsed intent acted reason
  judged_at=$(echo "$decision" | jq_ 'v.ts'); requested_at=$(rows "$from" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=s.trim().split("\n").filter(Boolean).map(JSON.parse);process.stdout.write(String(v.find(x=>x.id===process.argv[1])?.ts||""))})' "$stop")
  elapsed=$((judged_at-requested_at)); intent=$(echo "$decision" | jq_ 'v.body.intent'); acted=$(echo "$decision" | jq_ 'v.body.acted'); reason=$(echo "$ended" | jq_ 'v.body.reason')
  echo "    reflex: $intent acted=$acted, decision ${elapsed}ms, turn=$reason"
  local next_turn; next_turn=$(echo "$next" | jq_ 'v.body.turn')
  if [ "$intent" = stop ] && [ "$acted" = true ] && [ "$reason" = cancelled ] && [ "$next_turn" != "$turn" ] && [ "$elapsed" -ge 0 ] && [ "$elapsed" -le 1000 ]; then ok "R18 explicit stop cancels active turn within 1s; stop message enters next turn"; else bad R18 "stop decision/turn/latency did not meet contract"; fi
}

# Tap a notification action button by its label (case-insensitive; some skins upper-case buttons).
# A collapsed notification hides its buttons; swipe down on its title ($2) to expand it first.
ui_center() { adb shell uiautomator dump /sdcard/ash-regress-ui.xml >/dev/null 2>&1
  adb exec-out cat /sdcard/ash-regress-ui.xml | LABEL="$1" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const want=process.env.LABEL.toLowerCase();for(const n of s.match(/<node [^>]*>/g)||[]){const t=(/ text="([^"]*)"/.exec(n)||[])[1]||"",d=(/ content-desc="([^"]*)"/.exec(n)||[])[1]||"";if(t.toLowerCase()!==want&&d.toLowerCase()!==want)continue;const b=/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(n);if(b){process.stdout.write(((+b[1]+ +b[3])>>1)+" "+((+b[2]+ +b[4])>>1));return}}})'; }
tap_notification_action() {
  adb shell cmd statusbar expand-notifications >/dev/null 2>&1; sleep 2
  local xy="" title i
  for i in 1 2 3; do
    xy=$(ui_center "$1")
    [ -n "$xy" ] && break
    title=$(ui_center "${2:-需要你确认}")
    [ -z "$title" ] || adb shell input swipe $title ${title% *} $(( ${title#* } + 400 )) 300
    sleep 1
  done
  adb shell rm -f /sdcard/ash-regress-ui.xml >/dev/null 2>&1
  [ -n "$xy" ] || { adb shell cmd statusbar collapse >/dev/null 2>&1; return 1; }
  adb shell input tap $xy; sleep 1; adb shell cmd statusbar collapse >/dev/null 2>&1
}

R19() { say "R19 a risky phone action produces an Android approval notification and one answer"
  wait_online 300 || { bad R19 "agent not online"; return; }
  adb shell input keyevent 3 >/dev/null 2>&1
  local from request ask notice answer effect end
  from=$(last_seq)
  request=$(send_say "请用手机的 clipboard.set 把剪贴板设为 ash-r19；这是回归测试，请实际调用工具，不要只解释。")
  [ -n "$request" ] || { bad R19 "request not accepted"; return; }
  ask=$(wait_row 180 "v.find(x=>x.kind==='request'&&x.word==='ask'&&x.to==='person:owner'&&Array.isArray(x.body?.options)&&x.body.options.some(o=>o.id==='once')&&x.body.options.some(o=>o.id==='deny'))" "$from") || { bad R19 "no approval ask"; return; }
  local ask_id; ask_id=$(echo "$ask" | jq_ 'v.id||""')
  notice=""; end=$((SECONDS+30))
  while [ "$SECONDS" -lt "$end" ]; do
    notice=$(adb shell dumpsys notification --noredact 2>/dev/null | grep -F "present:$ask_id" | head -1)
    [ -z "$notice" ] || break
    sleep 1
  done
  [ -n "$notice" ] || { bad R19 "approval was not rendered by Android"; return; }
  # Only a screen or the notification itself may answer an ask; tap "once" the way the owner would.
  local once_label; once_label=$(echo "$ask" | jq_ 'v.body.options.find(o=>o.id==="once").label')
  tap_notification_action "$once_label" || { bad R19 "approval action not found in the notification shade"; return; }
  answer=$(wait_row 30 "v.find(x=>x.kind==='response'&&x.reply_to==='$ask_id'&&x.body?.result?.choice==='once')" "$from") || { bad R19 "approval answer not accepted"; return; }
  effect=$(wait_row 180 "v.find(x=>x.kind==='response'&&x.word==='clipboard.set'&&x.body?.ok===true)" "$from") || { bad R19 "approved phone action did not settle"; return; }
  local responses; responses=$(rows "$from" | ASH_ASK="$ask_id" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=s.trim().split("\n").filter(Boolean).map(JSON.parse);process.stdout.write(String(v.filter(x=>x.kind==="response"&&x.reply_to===process.env.ASH_ASK).length))})')
  if [ "$responses" = 1 ]; then ok "R19 Android showed the approval; once produced one terminal answer and one phone effect"; else bad R19 "approval responses=$responses"; fi
}

R20() { say "R20 app-open runs the opener after six hours; quiet hours persist"
  wait_online 300 || { bad R20 "agent not online"; return; }
  local before original changed restored prefs now old from opened opener_start opener quiet
  before=$(admin settings.get '{}'); original=$(echo "$before" | jq_ 'v.result?.delivery?.quiet||""')
  [ -n "$original" ] || { bad R20 "cannot read quiet hours"; return; }
  changed=$(admin settings.set '{"delivery":{"quiet":"00:00-23:59"}}' | jq_ 'v.result?.delivery?.quiet||""')
  [ "$changed" = "00:00-23:59" ] || { bad R20 "cannot set quiet hours"; return; }
  control RESTART; wait_online 300 || { admin settings.set "{\"delivery\":{\"quiet\":\"$original\"}}" >/dev/null; bad R20 "core did not restart"; return; }
  quiet=$(admin settings.get '{}' | jq_ 'v.result?.delivery?.quiet||""')
  now=$(date +%s); old=$(((now-7*3600)*1000)); prefs="/data/user/0/$PKG/shared_prefs/sense_device.xml"
  from=$(last_seq)
  adb shell am force-stop "$PKG" >/dev/null
  asr "p='$prefs'; if [ -f \"\$p\" ]; then sed -i -E 's#<long name=\"app_left\" value=\"[0-9]+\" */>#<long name=\"app_left\" value=\"$old\" />#' \"\$p\"; grep -q 'name=\"app_left\"' \"\$p\" || sed -i 's#</map>#    <long name=\"app_left\" value=\"$old\" />\\n</map>#' \"\$p\"; else mkdir -p \"\$(dirname \"\$p\")\"; printf '%s\\n' '<?xml version=\"1.0\" encoding=\"utf-8\" standalone=\"yes\" ?>' '<map>' '    <long name=\"app_left\" value=\"$old\" />' '</map>' > \"\$p\"; fi"
  adb shell am start -n "$PKG/ai.ash.ui.HomeActivity" >/dev/null
  opened=$(wait_row 180 "v.find(x=>x.word==='sense.screen'&&x.body?.state==='app_open'&&Number(x.body?.away_ms)>=21600000)" "$from") || true
  opener_start=$(wait_row 60 "v.find(x=>x.word==='run.start'&&x.body?.flow==='opener')" "$from") || true
  local opener_run; opener_run=$(echo "$opener_start" | jq_ 'v.body?.run||""')
  [ -z "$opener_run" ] || opener=$(wait_row 180 "v.find(x=>x.word==='run.end'&&x.body?.run==='$opener_run')" "$from") || true
  restored=$(admin settings.set "{\"delivery\":{\"quiet\":\"$original\"}}" | jq_ 'v.result?.delivery?.quiet||""')
  if [ -n "$opened" ] && [ -n "$opener" ] && [ "$quiet" = "00:00-23:59" ] && [ "$restored" = "$original" ]; then
    ok "R20 seven-hour app open ran opener; all-day quiet persisted across restart and was restored"
  else bad R20 "opened=$([ -n "$opened" ]&&echo yes||echo no) opener=$([ -n "$opener" ]&&echo yes||echo no) quiet=$quiet restored=$restored"; fi
}

R21() { say "R21 the real memory loop records a preference and correction, then has no duplicate work"
  wait_online 300 || { bad R21 "agent not online"; return; }
  local stamp from first second trigger run ended log count repeat repeat_end
  stamp="r21-$(date +%s)"
  from=$(last_seq)
  first=$(send_say "回归标记 ${stamp}：我偏好简短回答。")
  second=$(send_say "更正回归标记 ${stamp}：不是偏好详细回答，而是偏好简短回答。")
  [ -n "$first" ] && [ -n "$second" ] || { bad R21 "memory evidence messages not accepted"; return; }
  deliver_and_wait "只回复：收到 $stamp" 180 >/dev/null || { bad R21 "conversation did not settle"; return; }
  trigger=$(owner_request service:work run '{"flow":"memory"}')
  run=$(echo "$trigger" | jq_ 'v.reply?.body?.result?.run||""')
  [ -n "$run" ] || { bad R21 "memory run not accepted"; return; }
  ended=$(wait_row 300 "v.find(x=>x.word==='run.end'&&x.body?.run==='$run')" "$from") || { bad R21 "memory run did not settle"; return; }
  [ "$(echo "$ended" | jq_ 'v.body?.outcome||""')" = done ] || { bad R21 "first memory outcome=$(echo "$ended" | jq_ 'v.body?.outcome||""')"; return; }
  log=$(asr "find ash-home/memory -maxdepth 1 -type f -name '*.md' -print 2>/dev/null | tail -1")
  [ -n "$log" ] || { bad R21 "dated memory log absent"; return; }
  count=$(asr "grep -c '$stamp' '$log' 2>/dev/null || true" | tr -d '\r')
  repeat=$(owner_request service:work run '{"flow":"memory"}'); repeat=$(echo "$repeat" | jq_ 'v.reply?.body?.result?.run||""')
  [ -n "$repeat" ] || { bad R21 "repeat memory run not accepted"; return; }
  repeat_end=$(wait_row 180 "v.find(x=>x.word==='run.end'&&x.body?.run==='$repeat')" "$from") || { bad R21 "repeat memory run did not settle"; return; }
  if [ "${count:-0}" -ge 1 ] && [ "$(echo "$repeat_end" | jq_ 'v.body?.outcome||""')" = no_change ]; then
    ok "R21 real workers committed evidence for $stamp; the next run was no_change"
  else bad R21 "log matches=${count:-0}, repeat=$(echo "$repeat_end" | jq_ 'v.body?.outcome||""')"; fi
}

adb get-state >/dev/null 2>&1 || { echo "no adb device"; exit 2; }
TESTS=("$@"); [ ${#TESTS[@]} -eq 0 ] && TESTS=(R2 R4 R5 R6 R7 R8 R9 R11 R12 R14 R15 R16)
for t in "${TESTS[@]}"; do "$t"; done
printf '\n== summary: %d passed, %d failed\n' "$PASS" "$FAIL"; printf '%s\n' "${RESULTS[@]}"
[ "$FAIL" -eq 0 ]
