// Generated from docs/island/island.html.

/* =========================================================
   Island component
   model = {
     kind: 'listening'|'thinking'|'working'|'stale'|'ask'|'approval'|'in_app'|'result'|'incomplete'|'stopped',
     form: 'compact'|'card'|'edge',
     hugCamera: boolean,
     elapsed: seconds,
     activity: '在看网页'       // 执行类卡片的当前动作（只要动词）
     body: 'Agent 原话',        // 文本类卡片
     quote: '审批要提交的内容',  // approval
     options: ['A','B'],        // ask，仅来自原话 / 正式 ask
     approval: 'pending'|'approved'|'denied'|'expired'
   }
   handlers = { onTap, onOpen, onStop, onClose, onAllow, onDeny, onChoose(text), onSend(text), onViewOriginal }
   ========================================================= */
const AVATAR_ROOT = './avatars/';
const KIND = {
  listening:{label:'在听',title:'在听',face:'listening',ind:'bars',tone:'running',run:true,note:'刚收到你的消息'},
  thinking:{label:'在想',title:'正在处理',face:'thinking',ind:'dots',tone:'running',run:true,note:'你可以继续用手机，需要你时这里会展开'},
  working:{label:null,title:'正在处理',face:'focused',ind:'ring',tone:'running',run:true,note:'你可以继续用手机，需要你时这里会展开'},
  stale:{label:'连接中断',title:'连接中断',face:'default',ind:'off',tone:'offline',run:false,note:'15 秒没收到新状态，Ash 可能仍在运行'},
  ask:{label:'等你回答',title:'等你回答',face:'listening',ind:'pulse',tone:'needs',ph:'或者直接告诉 Ash…'},
  approval:{label:'需要批准',title:'需要你批准',face:'focused',ind:'pulse',tone:'needs'},
  in_app:{label:'去 Ash 操作',title:'需要你在 Ash 里操作',face:'listening',ind:'pulse',tone:'needs'},
  result:{label:'已完成',title:'已完成',face:'success',ind:'check',tone:'done',clamp:true},
  incomplete:{label:'未完成',title:'未完成',face:'thinking',ind:'warn',tone:'stop'},
  stopped:{label:'已停止',title:'已停止',face:'default',ind:'stop',tone:'stop'}
};
const TONE = {running:'#5AD8DB',needs:'#F5A623',done:'#2BB673',stop:'#FF6B6B',offline:'#8D8D93'};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const SVG = {
  ring: t => `<svg class="ind-spin" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="2.4"/><circle cx="9" cy="9" r="7" fill="none" stroke="${t}" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="12 32"/></svg>`,
  check: (t, s=18) => `<svg width="${s}" height="${s}" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8" fill="${t}"/><path d="M5.4 9.2l2.4 2.4 4.8-5" fill="none" stroke="#101011" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  warn: t => `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8" fill="${t}"/><path d="M9 5v5" stroke="#101011" stroke-width="2" stroke-linecap="round"/><circle cx="9" cy="12.8" r="1.1" fill="#101011"/></svg>`,
  off: () => `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6.5" fill="none" stroke="#8D8D93" stroke-width="2" stroke-dasharray="3 3"/></svg>`,
  up: () => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>`,
  send: () => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg>`,
  tick: () => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`
};
function indicator(ind, tone) {
  switch (ind) {
    case 'bars': return '<span class="ind-bars"><i></i><i></i><i></i><i></i></span>';
    case 'dots': return '<span class="ind-dots"><i></i><i></i><i></i></span>';
    case 'ring': return SVG.ring(tone);
    case 'pulse': return '<span class="ind-pulse pulse"></span>';
    case 'check': return SVG.check(tone);
    case 'warn': return SVG.warn(tone);
    case 'stop': return '<span class="ind-stop"></span>';
    default: return SVG.off();
  }
}
function fmt(sec) {
  const e = Math.floor((sec || 0) / 5) * 5, m = Math.floor(e / 60), s = String(e % 60).padStart(2, '0');
  return { short: `${m}:${s}`, long: m ? `${m} 分 ${s} 秒` : `${e} 秒` };
}

function renderIsland(m, ui) {
  const k = KIND[m.kind] || KIND.working;
  const ap = m.kind === 'approval' ? (m.approval || 'pending') : '';
  let label = k.label || m.activity || '在忙', toneKey = k.tone, ind = k.ind;
  if (ap === 'approved') { label = '已批准'; toneKey = 'done'; ind = 'check'; }
  if (ap === 'denied' || ap === 'expired') { label = ap === 'denied' ? '已拒绝' : '审批已过期'; toneKey = 'offline'; ind = 'off'; }
  const tone = TONE[toneKey];
  const needsYou = toneKey === 'needs';
  const t = fmt(m.elapsed);
  const face = `${AVATAR_ROOT}${k.face}.webp`;
  const aria = esc(`Ash：${label}，点按展开`);

  if (m.form === 'compact') return `
    <button class="isl-compact isl-in" data-act="tap" aria-label="${aria}">
      <img class="isl-av" src="${face}" alt="">
      <span class="isl-label">${esc(label)}</span>
      <span class="isl-spacer"></span>
      ${k.run || m.kind === 'stale' ? `<span class="isl-time">${t.short}</span>` : ''}
      <span class="isl-ind">${indicator(ind, tone)}</span>
    </button>`;

  if (m.form === 'edge') return `
    <button class="isl-edge" data-act="tap" aria-label="${aria}"><img class="isl-av" src="${face}" alt=""></button>`;

  const isText = !k.run && m.kind !== 'stale';
  const meta = k.run ? `已用 ${t.long}` : ['result', 'stopped', 'incomplete'].includes(m.kind) ? `用时 ${t.long}` : '刚刚';
  const clamp = k.clamp && !ui.more;
  let middle;
  if (!isText) {
    middle = `<div class="activity">${indicator(ind === 'bars' ? 'dots' : ind, tone)}<span><b>${esc(m.kind === 'stale' ? '状态待确认' : (m.activity || k.label || '在忙'))}</b><span>${esc(k.note)}</span></span></div>`;
  } else {
    middle = `<div style="display:flex;flex-direction:column;gap:8px">
      <p class="body${clamp ? ' clamp' : ''}">${esc(m.body)}</p>
      ${m.quote ? `<div class="quote">${esc(m.quote)}</div>` : ''}
      ${m.kind === 'approval' ? `<button class="more" data-act="original">查看完整原文</button>` : k.clamp ? `<button class="more" data-act="more">${ui.more ? '收起' : '展开全文'}</button>` : ''}
    </div>`;
  }
  let action = '';
  if (m.kind === 'ask' && m.options?.length)
    action = `<div class="options">${m.options.map((o, i) => `<button class="opt" data-act="choose" data-i="${i}">${esc(o)}</button>`).join('')}</div>`;
  if (ap === 'pending') action = `<div class="ap-row"><button class="btn-primary" style="flex:1.4" data-act="allow">允许并继续</button><button class="btn-neutral" style="flex:1" data-act="deny">拒绝</button></div>`;
  if (ap === 'approved') action = `<button class="ap-approved" disabled>${SVG.tick()}已批准，等待继续</button>`;
  if (ap === 'denied') action = `<div class="ap-final">已拒绝 · 这一步不会执行</div>`;
  if (ap === 'expired') action = `<div class="ap-final">已过期 · 未执行，需要时让 Ash 重新申请</div>`;
  if (m.kind === 'in_app') action = `<button class="btn-primary" data-act="open">去 Ash 里操作</button>`;

  return `
  <div class="isl-card isl-in">
    <div class="card-head">
      <img class="isl-av" src="${face}" alt="">
      <div class="card-titles">
        <span class="card-title"><span class="dot${needsYou ? ' pulse' : ''}"></span>${esc(k.title)}</span>
        <span class="card-meta">Ash · ${meta}</span>
      </div>
      <button class="icon-btn" data-act="tap" aria-label="收起成胶囊">${SVG.up()}</button>
    </div>
    ${middle}
    ${action}
    <div class="foot">
      <div class="foot-input">
        <label><span class="sr">回复 Ash</span><input type="text" placeholder="${esc(k.ph || '回复 Ash…')}"></label>
        <button class="send" data-act="send" aria-label="发送">${SVG.send()}</button>
      </div>
      <div class="foot-links">
        ${k.run ? '<button class="stop" data-act="stop"><i></i>停止任务</button>' : ''}
        <span style="flex:1"></span>
        <button data-act="open">回到 Ash</button>
        <button data-act="close" style="padding-right:4px!important">关闭</button>
      </div>
    </div>
  </div>`;
}

function mountIsland(root, handlers = {}) {
  const el = document.createElement('div');
  el.className = 'isl';
  root.appendChild(el);
  const ui = { more: false };
  let model = null;
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]'); if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'more') { ui.more = !ui.more; return draw(); }
    if (act === 'choose') return handlers.onChoose?.(model.options[+b.dataset.i]);
    if (act === 'send') { const inp = el.querySelector('input'); const v = inp?.value.trim() || ''; if (inp) inp.value = ''; return handlers.onSend?.(v); }
    const map = { tap: 'onTap', open: 'onOpen', stop: 'onStop', close: 'onClose', allow: 'onAllow', deny: 'onDeny', original: 'onViewOriginal' };
    handlers[map[act]]?.();
  });
  el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.matches('input')) el.querySelector('[data-act=send]')?.click(); });
  function draw() {
    el.dataset.form = model.form;
    if (model.hugCamera) el.dataset.hug = ''; else delete el.dataset.hug;
    el.style.setProperty('--tone', TONE[(KIND[model.kind] || KIND.working).tone]);
    el.innerHTML = renderIsland(model, ui);
  }
  return {
    el,
    render(next) {
      const contentChanged = !model || model.kind !== next.kind || model.form !== next.form || model.approval !== next.approval || model.body !== next.body;
      if (model && model.kind !== next.kind) ui.more = false;
      model = { ...next };
      if (contentChanged) draw();
      else { const time = el.querySelector('.isl-time, .card-meta'); draw(); void time; }
    }
  };
}
