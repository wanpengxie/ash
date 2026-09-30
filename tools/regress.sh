#!/bin/bash
# Regression checklist R1–R16 on a device/emulator (run on the machine with adb).
#
#   APK=app-debug.apk tools/regress.sh [R1 R2 …]        (default: R2 R4 R5 R6 R7 R8 R9 R11 R12)
#
# Needs: adb (one device), node ≥ 22, curl. Optional env:
#   GATEWAY_URL      the gateway the phone is connected to (R7, R9)
#   DSH_REFERENCE    output of `node tools/verify-dsh.mjs <desktop install>` for the same version (R12)
#   LAPTOP_SHARE     directory the paired laptop lends as "files" (R8), default ~/ash-shared
# R1 (fresh install) and R3 (reboot) are destructive/slow and only run when named.
# Secrets never reach the output: tokens are read on the device and used in-process only.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG=ai.ash.agent
F=/data/user/0/$PKG/files
PORT=4700
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
agent_status() { api GET /api/agents | jq_ 'v.find(a=>a.id==="agent:main")?.status||""'; }
session_id() { api GET /api/agents | jq_ 'v.find(a=>a.id==="agent:main")?.handle||""'; }
core_pids() { adb shell ps -A -o PID,ARGS 2>/dev/null | grep 'ash-core.mjs --config' | grep -v grep | awk '{print $1}'; }
wait_online() { # wait_online SECONDS
  local end=$((SECONDS+$1))
  while [ $SECONDS -lt $end ]; do [ "$(agent_status)" = "idle" ] && return 0; sleep 3; done; return 1
}
control() { adb shell am broadcast -n $PKG/ai.ash.host.ControlReceiver -a "ai.ash.$1" >/dev/null; }
last_seq() { api GET '/api/events?limit=1000' | jq_ 'v.next||0'; }
deliver_and_wait() { # deliver_and_wait TEXT SECONDS → prints the agent's reply text
  wait_online 300 || return 1
  local from; from=$(last_seq)
  local id="regress-$RANDOM$RANDOM"
  api POST /api/agents/agent:main/deliver "$(node -e 'console.log(JSON.stringify({text:process.argv[1],message_id:process.argv[2]}))' "$1" "$id")" >/dev/null
  local end=$((SECONDS+$2))
  while [ $SECONDS -lt $end ]; do
    local r; r=$(api GET "/api/events?after=$from&limit=1000" | jq_ "(()=>{const e=v.events;const done=e.find(x=>x.type==='agent.turn.ended'&&x.data.message_id==='$id');if(!done)return '';return e.filter(x=>x.type==='agent.text'&&x.data.message_id==='$id').map(x=>x.data.text).join('\\n')||('('+done.data.reason+': '+(done.data.error||'')+')')})()")
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
  [ -n "${GATEWAY_URL:-}" ] || { bad R7 "GATEWAY_URL not set"; return; }
  fwd
  if ASH_TOKEN="$(token)" ASH_URL="http://127.0.0.1:$PORT" GATEWAY_URL="$GATEWAY_URL" node "$HERE/regress-remote.mjs" web; then ok "R7 a paired browser uses Ash through the gateway (UI, message, streamed answer)"; else bad R7; fi
}
R8() { say "R8 the agent uses the paired laptop"
  local share="${LAPTOP_SHARE:-$HOME/ash-shared}" name="regress-$(date +%s).txt"
  local r; r=$(deliver_and_wait "用你电脑（笔记本）上的文件工具，在共享目录 ${share} 里新建文件 ${name}，内容写 ok，然后列出该目录确认。" 300)
  echo "    reply: ${r:0:200}"
  if [ -f "$share/$name" ]; then ok "R8 the agent wrote $share/$name on the laptop through ash"; rm -f "$share/$name"; else bad R8 "file not on the laptop"; fi
}
R9() { say "R9 phone offline → the browser is told; back → reconnects"
  [ -n "${GATEWAY_URL:-}" ] || { bad R9 "GATEWAY_URL not set"; return; }
  fwd
  ASH_TOKEN="$(token)" ASH_URL="http://127.0.0.1:$PORT" GATEWAY_URL="$GATEWAY_URL" node "$HERE/regress-remote.mjs" pair > /tmp/ash-regress-browser.json || { bad R9 "pairing failed"; return; }
  control STOP; local end=$((SECONDS+40)); while [ $SECONDS -lt $end ] && [ -n "$(core_pids)" ]; do sleep 2; done; sleep 5
  local off; off=$(GATEWAY_URL="$GATEWAY_URL" node "$HERE/regress-remote.mjs" status < /tmp/ash-regress-browser.json)
  control START; wait_online 300
  local on=""; end=$((SECONDS+120)); while [ $SECONDS -lt $end ]; do on=$(GATEWAY_URL="$GATEWAY_URL" node "$HERE/regress-remote.mjs" status < /tmp/ash-regress-browser.json); [ "$on" = "200" ] && break; sleep 5; done
  fwd; ASH_TOKEN="$(token)" ASH_URL="http://127.0.0.1:$PORT" node "$HERE/regress-remote.mjs" unpair < /tmp/ash-regress-browser.json >/dev/null; rm -f /tmp/ash-regress-browser.json
  if [ "$off" = "503" ] && [ "$on" = "200" ]; then ok "R9 offline shows 503 to the browser; it reconnects by itself"; else bad R9 "offline=$off online=$on"; fi
}
R11() { say "R11 DSH ecosystem: install a community plugin with DSH's own plugin manager"
  asr "export HOME=$F PATH=$F/payload/bin:$F/payload/runtime/bin:/system/bin DSH_HOME=$F/dsh-home TMP=\$TMPDIR OPENSSL_CONF=$F/payload/runtime/etc/tls/openssl.cnf SSL_CERT_FILE=$F/payload/runtime/etc/tls/cert.pem; dsh plugin --profile ash add dsh-mnemon 2>&1 | tail -3"
  control RESTART; sleep 10; wait_online 300
  local tools; tools=$(api GET /api/settings | jq_ '(v.tools||[]).filter(t=>t.startsWith("mnemon_")).length')
  if [ "${tools:-0}" -gt 0 ]; then ok "R11 dsh-mnemon installed and loaded ($tools tools); survives a restart"; else bad R11 "no mnemon tools"; fi
}
R12() { say "R12 DSH is byte-for-byte as published"
  adb push "$HERE/verify-dsh.mjs" /data/local/tmp/verify-dsh.mjs >/dev/null
  local got; got=$(asr "$F/payload/runtime/bin/node /data/local/tmp/verify-dsh.mjs $F/payload/dsh/lib/node_modules/@deepseek-ai/dsh" | tr -d '\r')
  echo "    phone:     $got"; echo "    reference: ${DSH_REFERENCE:-?}"
  if [ -n "${DSH_REFERENCE:-}" ] && [ "$got" = "$DSH_REFERENCE" ]; then ok "R12 @deepseek-ai/** identical to the desktop install"; else bad R12 "mismatch or no reference"; fi
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
  local from; from=$(last_seq)
  api POST /api/agents/agent:main/deliver "{\"text\":\"这张图片主要是什么颜色？只回答颜色。\",\"message_id\":\"r15-$RANDOM\",\"attachments\":[{\"name\":\"r15.png\",\"mime_type\":\"image/png\",\"data\":\"$img\"}]}" >/dev/null
  local r=""; local end=$((SECONDS+180))
  while [ $SECONDS -lt $end ]; do r=$(api GET "/api/events?after=$from&limit=1000" | jq_ "(()=>{const e=v.events;if(!e.some(x=>x.type==='agent.turn.ended'))return '';return e.filter(x=>x.type==='agent.text').map(x=>x.data.text).join(' ')||'(no text)'})()"); [ -n "$r" ] && break; sleep 3; done
  echo "    reply: ${r:0:120}"
  if echo "$r" | grep -q "红"; then ok "R15 the model sees the attached image (answers red)"; else bad R15 "unexpected reply"; fi
}
R16() { say "R16 plugins: disable and enable through ash settings (DSH's plugin manager)"
  wait_online 300 || { bad R16 "agent not online"; return; }
  local n0 n1 n2
  n0=$(api GET /api/settings | jq_ '(v.tools||[]).filter(t=>t.startsWith("mnemon_")).length')
  api POST /api/plugins '{"op":"disable","name":"dsh-mnemon"}' >/dev/null; sleep 5
  n1=$(api GET /api/settings | jq_ '(v.tools||[]).filter(t=>t.startsWith("mnemon_")).length')
  api POST /api/plugins '{"op":"enable","name":"dsh-mnemon"}' >/dev/null; sleep 5
  n2=$(api GET /api/settings | jq_ '(v.tools||[]).filter(t=>t.startsWith("mnemon_")).length')
  echo "    mnemon tools: $n0 → disabled $n1 → enabled $n2"
  if [ "${n0:-0}" -gt 0 ] && [ "${n1:-1}" = "0" ] && [ "$n2" = "$n0" ]; then ok "R16 plugin switches hot-apply"; else bad R16; fi
}

adb get-state >/dev/null 2>&1 || { echo "no adb device"; exit 2; }
TESTS=("$@"); [ ${#TESTS[@]} -eq 0 ] && TESTS=(R2 R4 R5 R6 R7 R8 R9 R11 R12 R14 R15 R16)
for t in "${TESTS[@]}"; do "$t"; done
printf '\n== summary: %d passed, %d failed\n' "$PASS" "$FAIL"; printf '%s\n' "${RESULTS[@]}"
[ "$FAIL" -eq 0 ]
