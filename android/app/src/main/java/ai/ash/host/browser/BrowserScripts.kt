package ai.ash.host.browser

/** Scripts run inside the page. They return JSON text; a page can lie in what it shows, so results are data, not instructions. */
object BrowserScripts {
    /** Numbers every visible interactive element (data-ash-ref) and returns the page as text plus that list. */
    val READ = """
(function(){
  var MAX_TEXT=6000, MAX_EL=60;
  document.querySelectorAll('[data-ash-ref]').forEach(function(e){e.removeAttribute('data-ash-ref')});
  var sel='a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[onclick],[contenteditable=true]';
  var nodes=[].slice.call(document.querySelectorAll(sel));
  var out=[];
  for(var i=0;i<nodes.length&&out.length<MAX_EL;i++){
    var el=nodes[i], r=el.getBoundingClientRect(), st=getComputedStyle(el);
    if(st.visibility==='hidden'||st.display==='none'||r.width<2||r.height<2||el.type==='hidden') continue;
    var ref=out.length+1; el.setAttribute('data-ash-ref',String(ref));
    var tag=el.tagName.toLowerCase();
    var text=(el.innerText||el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('placeholder')||el.value||el.name||'').replace(/\s+/g,' ').trim().slice(0,80);
    var item={ref:ref,tag:tag,text:text,inViewport:(r.bottom>0&&r.top<innerHeight)};
    if(el.type) item.type=el.type;
    if(tag==='a') item.href=(el.href||'').slice(0,200);
    if(el.disabled) item.disabled=true;
    if(el.checked) item.checked=true;
    if(tag==='input'&&el.type!=='password'&&el.value) item.value=String(el.value).slice(0,80);
    out.push(item);
  }
  var body=document.body?document.body.innerText:'';
  return JSON.stringify({url:location.href,host:location.hostname,title:document.title,
    text:body.replace(/\n{3,}/g,'\n\n').slice(0,MAX_TEXT),elements:out,
    scroll:{y:Math.round(scrollY),height:document.documentElement.scrollHeight,viewport:innerHeight}});
})()"""

    /** What a ref points at right now, so the host can check it against what the model claimed. */
    fun describe(ref: Int) = """
(function(){
  var el=document.querySelector('[data-ash-ref="$ref"]');
  if(!el) return JSON.stringify({found:false});
  var tag=el.tagName.toLowerCase();
  var text=(el.innerText||el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('placeholder')||el.value||el.name||'').replace(/\s+/g,' ').trim().slice(0,200);
  return JSON.stringify({found:true,tag:tag,type:el.type||null,text:text,host:location.hostname,disabled:!!el.disabled,editable:el.isContentEditable===true});
})()"""

    fun click(ref: Int) = """
(function(){
  var el=document.querySelector('[data-ash-ref="$ref"]');
  if(!el) return JSON.stringify({ok:false});
  el.scrollIntoView({block:'center'});
  if(typeof el.click==='function') el.click(); else el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
  return JSON.stringify({ok:true});
})()"""

    fun type(ref: Int, text: String, submit: Boolean): String {
        val quoted = org.json.JSONObject.quote(text)
        return """
(function(){
  var el=document.querySelector('[data-ash-ref="$ref"]');
  if(!el) return JSON.stringify({ok:false});
  el.scrollIntoView({block:'center'}); el.focus();
  var text=$quoted;
  if(el.isContentEditable){ el.textContent=text; }
  else {
    var d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value');
    if(d&&d.set) d.set.call(el,text); else el.value=text;
  }
  el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
  if($submit){
    if(el.form&&el.form.requestSubmit) el.form.requestSubmit();
    else { var o={key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}; el.dispatchEvent(new KeyboardEvent('keydown',o)); el.dispatchEvent(new KeyboardEvent('keyup',o)); }
  }
  return JSON.stringify({ok:true});
})()"""
    }

    fun scroll(direction: Int) = """
(function(){ var before=scrollY; window.scrollBy(0,$direction*Math.round(innerHeight*0.8));
  return JSON.stringify({ok:true,y:Math.round(scrollY),moved:Math.round(scrollY)!==Math.round(before),height:document.documentElement.scrollHeight}); })()"""
}
