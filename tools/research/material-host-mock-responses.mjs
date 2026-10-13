import http from 'node:http';
export const TOOL = { type: 'function', name: 'ash_material_probe', description: 'isolated probe', inputSchema: {type:'object',properties:{nonce:{type:'string'}},required:['nonce'],additionalProperties:false} };
export async function createMock(record = () => {}) {
  let active = null;
  const server = http.createServer(async (req,res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/v1/responses' || !active) throw Error('unapproved mock route');
      let raw=''; for await (const chunk of req) { raw+=chunk; if(raw.length>1024*1024) throw Error('body limit'); }
      const body=JSON.parse(raw); if(body.model!=='fixture' || ++active.count>3) throw Error('model/count limit');
      const flat=(body.tools??[]).flatMap(t=>t.type==='namespace'?(t.tools??[]).map(x=>({...x,namespace:t.name})): [t]);
      const probe=flat.find(t=>t.name==='ash_material_probe');
      if(probe) {
        const s=probe.parameters??probe.input_schema;
        if(!s || s.type!=='object' || Object.keys(s.properties??{}).join()!=='nonce' || s.properties.nonce.type!=='string' || Object.keys(s.properties.nonce).join()!=='type' || JSON.stringify(s.required)!=='["nonce"]' || s.additionalProperties!==false) throw Error('unsafe probe schema');
      }
      const outputs=(body.input??[]).filter(x=>x.type==='function_call_output');
      const tool=!!probe && !outputs.some(x=>String(x.call_id).startsWith(active.nonce));
      record({kind:'mock',case:active.nonce,count:active.count,toolDeclared:!!probe,toolName:probe?.name,namespace:probe?.namespace,toolOutput:outputs.map(x=>({call_id:x.call_id,output:x.output}))});
      const id='resp_'+active.nonce+'_'+active.count;
      const item=tool?{type:'function_call',id:'fc_'+active.nonce,call_id:active.nonce+'_call',name:probe.name,...(probe.namespace?{namespace:probe.namespace}:{}),arguments:JSON.stringify({nonce:active.nonce}),status:'completed'}:{type:'message',id:'msg_'+active.nonce,role:'assistant',status:'completed',content:[{type:'output_text',text:'fixture complete',annotations:[]}]};
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      let seq=0; const emit=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,sequence_number:seq++,...data})}\n\n`);
      const response={id,object:'response',created_at:1,model:'fixture',status:'in_progress',output:[]};
      emit('response.created',{response});
      emit('response.output_item.added',{output_index:0,item:tool?{...item,arguments:'',status:'in_progress'}:{...item,status:'in_progress',content:[]}});
      if(tool) {emit('response.function_call_arguments.delta',{item_id:item.id,output_index:0,delta:item.arguments});emit('response.function_call_arguments.done',{item_id:item.id,output_index:0,arguments:item.arguments});}
      else {emit('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});emit('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:'fixture complete'});emit('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text:'fixture complete'});}
      emit('response.output_item.done',{output_index:0,item});emit('response.completed',{response:{...response,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
    } catch(e) {record({kind:'mock_rejection',reason:e.message});res.writeHead(400);res.end(JSON.stringify({error:{message:e.message}}));}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {server,port:server.address().port,arm(nonce){active={nonce,count:0};},async close(){server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
