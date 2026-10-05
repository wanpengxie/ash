/* Local packaged content only. Native owns authorization, transport, window focus and capture. */
(() => {
  'use strict';
  // A turn ending is not proof that its task succeeded. Keep the agreed neutral fallback, marked by a quiet grey dot:
  // the dashed ring belongs to a lost connection.
  KIND.reply={label:'本轮回复',title:'本轮回复',face:'default',ind:'dot',tone:'offline',clamp:true};
  const vendorIndicator=indicator;
  indicator=(ind,tone)=>ind==='dot'?'<span class="ind-pulse"></span>':vendorIndicator(ind,tone);
  // The card shows the agent's words as plain text, as the reference does; Markdown marks would show as stray symbols.
  const plain=text=>String(text??'').split('\n').filter(line=>!/^\s*(```|\|?\s*:?-{3,})/.test(line)).map(line=>line
    .replace(/^\s*#{1,6}\s+/,'').replace(/^\s*>\s?/,'').replace(/^(\s*)[-*+]\s+/,'$1• ')
    .replace(/^\s*\|(.*)\|\s*$/,(_,cells)=>cells.split('|').map(c=>c.trim()).filter(Boolean).join(' · '))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/(\*\*|__)(.+?)\1/g,'$2').replace(/`([^`]*)`/g,'$1'))
    .join('\n').replace(/\n{3,}/g,'\n\n').trim();
  const root=document.getElementById('root'), el=document.createElement('div');
  el.className='isl'; root.append(el);
  let snapshot=null, form='compact', selected=null, expandedOriginal=false, more=false;
  let episode='', lastKey='', draft='', customTarget=null, busy=false, notice='', lastSize='';
  // While the island changes form (width and radius over .5s), the window keeps the larger of the two sizes, so the
  // whole change plays inside it instead of the window chasing it frame by frame. Room around it: see host.css.
  const PAD_X=40, PAD_Y=40, MORPH_MS=560;
  let hold=null, holdTimer=0;
  const post=(action,extra={}) => window.AshIslandNative?.postMessage(JSON.stringify({action,turn:snapshot?.turn,...extra}));
  const activeCard=() => snapshot?.cards.find(c=>c.id===selected);
  const pending=c=>c.state==='waiting';
  function display() {
    const c=activeCard();
    if(snapshot.stale) return {...snapshot,kind:'stale',form,body:plain(snapshot.reply)};
    if(!c) return {...snapshot,form,body:plain(snapshot.reply)};
    const approval=c.kind==='approval';
    const state=c.localState || c.state;
    const ap={waiting:'pending',sending:'pending',answered:'approved',denied:'denied',expired:'expired'}[state] || 'settled';
    // An approval reads as the reference lays it out: what Ash wants to do, then exactly what it would send, quoted.
    const quote=approval&&c.detail&&c.detail!==c.title?c.detail:'';
    const body=approval?c.title:plain([c.title,c.detail].filter(Boolean).join('\n\n'));
    return {...snapshot,kind:approval?'approval':'ask',form,body,quote,approval:ap,
      options:pending(c)&&!c.localState?c.options.map(o=>o.label):[],card:c};
  }
  function measure() {
    const rect=el.getBoundingClientRect();
    const w=hold?Math.max(rect.width,hold.w):rect.width, h=hold?Math.max(rect.height,hold.h):rect.height;
    const size={width:Math.ceil(w)+PAD_X,height:Math.ceil(h)+PAD_Y,form};
    const key=JSON.stringify(size);
    if(key!==lastSize) { lastSize=key; post('size',size); }
  }
  function draw() {
    if(!snapshot) return;
    const m=display(), c=m.card, wasInput=document.activeElement?.matches('input');
    const input=el.querySelector('input'), selection=input?[input.selectionStart,input.selectionEnd]:null;
    if(input) draft=input.value;
    const key=JSON.stringify({...m,elapsed:0,maxHeight:0,cardWidth:0,reduceMotion:false});
    el.style.setProperty('--card-width',snapshot.cardWidth+'px');
    el.style.setProperty('--max-height',snapshot.maxHeight+'px');
    el.dataset.motion=snapshot.reduceMotion?'reduce':'normal';
    const was=el.dataset.form; let before=null;
    if(key!==lastKey) {
      lastKey=key;
      before=was?el.getBoundingClientRect():null;
      el.dataset.form=form;
      el.style.setProperty('--tone',TONE[(KIND[m.kind]||KIND.working).tone]);
      // The vendor mount() redraws innerHTML every tick. Reuse the real input node instead,
      // preserving IME composition, selection, draft and focus across model/clock updates.
      const template=document.createElement('template'); template.innerHTML=renderIsland(m,{more});
      const oldCard=el.querySelector('.isl-card'), nextCard=template.content.querySelector('.isl-card');
      const oldFoot=oldCard?.querySelector('.foot');
      if(oldCard&&nextCard&&oldFoot) {
        // Do not detach the composer at all: even reinserting the same input cancels Android IME composition.
        for(const node of [...oldCard.children]) if(node!==oldFoot) node.remove();
        for(const node of [...nextCard.children]) if(!node.matches('.foot')) oldCard.insertBefore(node,oldFoot);
      } else el.replaceChildren(template.content);
      const fresh=el.querySelector('input');
      if(fresh && input && fresh!==input) fresh.replaceWith(input);
      const field=el.querySelector('input');
      if(field) {
        field.maxLength=4000; if(field.value!==draft) field.value=draft; field.disabled=busy;
        field.placeholder=answering()?(KIND.ask.ph):'回复 Ash…';
        if(wasInput && document.activeElement!==field) { field.focus({preventScroll:true}); if(selection) field.setSelectionRange(...selection); }
      }
      const card=el.querySelector('.isl-card');
      if(card) {
        const head=card.querySelector('.card-head'), foot=card.querySelector('.foot');
        const content=document.createElement('div'); content.className='island-content';
        for(const node of [...card.children]) if(node!==head&&node!==foot) content.append(node);
        card.insertBefore(content,foot);
        if(c && expandedOriginal) {
          const pre=document.createElement('pre'); pre.className='original'; pre.textContent=c.original;
          content.append(pre);
          content.querySelector('[data-act=original]').textContent='收起原文';
        }
        if((c && !pending(c) && c.kind!=='approval') || (c && m.approval==='settled')) {
          const status=document.createElement('div'); status.className='ap-final';
          status.textContent={answered:'已回答',withdrawn:'已撤回',skipped:'未执行',redeemed:'已提交执行，结果见后续回复',expired:'已过期',denied:'已拒绝'}[c.state]||'已处理';
          content.append(status);
        }
        if(c && snapshot.cards.length>1 && !snapshot.stale) {
          const nav=document.createElement('div'); nav.className='island-nav';
          nav.innerHTML='<button data-act="prev" aria-label="上一项">‹</button><span></span><button data-act="next" aria-label="下一项">›</button>';
          nav.querySelector('span').textContent=`${snapshot.cards.findIndex(x=>x.id===selected)+1} / ${snapshot.cards.length}`;
          content.prepend(nav);
        }
        if(!foot.querySelector('.send-notice')) {
          const status=document.createElement('p'); status.className='send-notice'; status.setAttribute('role','status'); foot.prepend(status);
        }
        const existingStop=el.querySelector('[data-act=stop]');
        if(snapshot.canStop && KIND[m.kind]?.run && !existingStop) {
          const stop=document.createElement('button'); stop.className='stop'; stop.dataset.act='stop'; stop.innerHTML='<i></i>停止任务';
          foot.querySelector('.foot-links').prepend(stop);
        } else if(!snapshot.canStop || !KIND[m.kind]?.run) existingStop?.remove();
        for(const b of el.querySelectorAll('[data-act=allow],[data-act=deny],[data-act=choose],[data-act=custom]'))
          b.disabled=!snapshot.interactive || !!c?.localState || !c || !pending(c);
        const stop=el.querySelector('[data-act=stop]'); if(stop) stop.disabled=!snapshot.interactive;
        const send=el.querySelector('[data-act=send]'); if(send) send.disabled=busy;
      }
    }
    if(before && was!==form) {
      const after=el.getBoundingClientRect(), target=form==='card'?snapshot.cardWidth:form==='edge'?52:236;
      hold={w:Math.max(before.width,after.width,target),h:Math.max(before.height,after.height)};
      clearTimeout(holdTimer); holdTimer=setTimeout(()=>{ hold=null; measure(); },snapshot.reduceMotion?0:MORPH_MS);
    }
    // Clock pulses never replace DOM, replay entrance animations, or dismiss the keyboard.
    const t=fmt(snapshot.elapsed), k=KIND[m.kind]||KIND.working;
    const time=el.querySelector('.isl-time'); if(time) time.textContent=t.short;
    const meta=el.querySelector('.card-meta'); if(meta) meta.textContent='Ash · '+(k.run?`已用 ${t.long}`:['result','reply','stopped','incomplete'].includes(m.kind)?`用时 ${t.long}`:'刚刚');
    const n=el.querySelector('.send-notice'); if(n) n.textContent=notice||snapshot.notice||'';
    measure();
  }
  function setForm(value) {
    if(form===value) return;
    if(value!=='card') { el.querySelector('input')?.blur(); post('focus',{value:false}); }
    form=value; lastKey=''; draw();
  }
  // While a question that takes free-form answers is open, what the owner types answers it.
  // While a question that takes free-form answers is open, what the owner types answers it.
  const openQuestion=c=>c && c.kind!=='approval' && c.allow_custom && pending(c) && !c.localState;
  function answering() { if(customTarget) return customTarget; const c=activeCard(); return openQuestion(c) ? c.id : null; }
  function send() {
    if(busy) return;
    const text=el.querySelector('input')?.value.trim()||'';
    if(!text) return;
    const requestId=answering();
    draft=text; customTarget=requestId; busy=true; notice='正在发送…'; lastKey=''; draw();
    post('send',{text,requestId});
  }
  let dragged=false;
  el.addEventListener('click',event=>{
    const button=event.target.closest('[data-act]'); if(!button||button.disabled||dragged) return;
    const action=button.dataset.act, c=activeCard();
    if(action==='tap') return setForm(form==='card'?'compact':'card');
    if(action==='close') { if(snapshot.mayClose) post('dismiss'); else setForm('compact'); return; }
    if(action==='more') { more=!more; lastKey=''; return draw(); }
    if(action==='original') { expandedOriginal=!expandedOriginal; lastKey=''; return draw(); }
    if(action==='prev'||action==='next') {
      const i=snapshot.cards.findIndex(x=>x.id===selected), delta=action==='next'?1:-1;
      selected=snapshot.cards[(i+delta+snapshot.cards.length)%snapshot.cards.length].id;
      expandedOriginal=false; more=false; lastKey=''; return draw();
    }
    if(action==='send') return send();
    if(action==='allow'||action==='deny'||action==='choose') {
      if(!c||!snapshot.interactive||!pending(c)) return;
      const choice=action==='choose'?c.options[+button.dataset.i]?.id:action==='allow'?'once':'deny';
      if(choice) post('answer',{requestId:c.id,choice});
      return;
    }
    if(action==='open') { el.querySelector('input')?.blur(); post('focus',{value:false}); return post('open'); }
    if(action==='stop' && snapshot.canStop && snapshot.interactive) post('stop');
  });
  // A draft started under an open question belongs to it, even if the question closes before it is sent.
  el.addEventListener('input',event=>{ if(!event.target.matches('input')) return; draft=event.target.value; if(!customTarget&&draft) customTarget=answering(); });
  el.addEventListener('pointerdown',event=>{
    if(event.target.matches('input')) { post('focus',{value:true}); return; }
    const area=event.target.closest('.isl-compact,.card-head');
    if(!area || event.target.closest('.icon-btn')) return;
    const x=event.screenX,y=event.screenY; dragged=false;
    const move=e=>{
      const dx=e.screenX-x,dy=e.screenY-y;
      if(!dragged&&Math.abs(dx)+Math.abs(dy)>8) { dragged=true; post('drag',{phase:'start'}); }
      if(dragged) post('drag',{phase:'move',dx,dy});
    };
    const up=()=>{ el.removeEventListener('pointermove',move); if(dragged) post('drag',{phase:'end'}); setTimeout(()=>dragged=false,0); };
    el.addEventListener('pointermove',move); el.addEventListener('pointerup',up,{once:true}); el.addEventListener('pointercancel',up,{once:true});
  });
  el.addEventListener('keydown',event=>{ if(event.key==='Enter'&&!event.isComposing&&event.target.matches('input')) { event.preventDefault(); send(); } });
  new ResizeObserver(measure).observe(el);
  window.AshIsland={
    receive(raw) {
      const next=typeof raw==='string'?JSON.parse(raw):raw;
      const newTurn=snapshot?.turn!==next.turn || snapshot?.session!==next.session;
      const incoming=next.cards.find(c=>pending(c)&&!c.localState);
      const nextEpisode=[next.session,next.turn,next.kind,incoming?.id||'',next.reply].join('|');
      if(newTurn) { selected=null; more=false; expandedOriginal=false; if(!busy) notice=''; if(!next.reply&&!incoming) form='compact'; }
      const current=next.cards.find(c=>c.id===selected);
      if(incoming && (!current || !pending(current) || current.localState)) selected=incoming.id;
      else if(!incoming && ((next.reply&&['reply','incomplete','stopped'].includes(next.kind)) ||
          (next.canStop&&!next.cards.some(pending)))) selected=null;
      else if(!current) selected=(incoming||next.cards.at(-1))?.id||null;
      if(nextEpisode!==episode && (incoming||next.reply||['reply','result','incomplete','stopped'].includes(next.kind))) form='card';
      episode=nextEpisode;
      snapshot=next;
      // An expired/replaced question must not silently turn its draft into an ordinary message.
      draw();
    },
    focusInput() { el.querySelector('input')?.focus({preventScroll:true}); },
    blurInput() { el.querySelector('input')?.blur(); },
    restoreDraft(text,target) { draft=text; customTarget=target||null; const input=el.querySelector('input'); if(input) input.value=text; },
    sent(ok,message) {
      busy=false; notice=message;
      if(ok) { draft=''; customTarget=null; const input=el.querySelector('input'); if(input) input.value=''; }
      // A question that closed under the draft refuses it once, with this notice; sending again is an ordinary message.
      else if(customTarget && !openQuestion(snapshot?.cards.find(x=>x.id===customTarget))) customTarget=null;
      lastKey=''; draw();
    },
    restored() { el.classList.remove('isl-restored'); void el.offsetWidth; el.classList.add('isl-restored'); lastSize=''; measure(); }
  };
  post('ready');
})();
