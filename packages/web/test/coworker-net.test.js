import test from 'node:test';
import assert from 'node:assert/strict';
import { installCoworkerNet } from '../js/coworker-net.js';
const fixture=()=>{const calls=[];const net={session:'connection-a',generation:1,binding(){return {session:this.session,generation:this.generation};},same(b){return b.session===this.session&&b.generation===this.generation;},async data(to,word,body,options){calls.push({to,word,body,options});return {ok:true,auth_scope:'pairing-scope',targets:[]};}};installCoworkerNet(net);return {net,calls};};
test('stable pairing scope is distinct from connection guard and no credential enters words',async()=>{
 const {net,calls}=fixture();await net.refreshCoworkerScope();assert.equal(net.currentScope,'pairing-scope');assert.equal(net.connectionId,'connection-a');assert.equal(net.token,undefined);
 await net.collaborationRead({device_id:'device:mac',endpoint_id:'mac',authorization_generation:'g',authorization_revision:'r'},null,null);
 assert.equal(calls[1].to,'service:collaboration');assert.equal(calls[1].word,'collaboration.read');assert.equal(JSON.stringify(calls[1]).includes('connection-a'),false);
 net.session='connection-b';net.generation++;assert.equal(net.currentScope,'pairing-scope');assert.equal(net.connectionId,'connection-b');
});
test('a late word reply after reconnect is fenced even with the same pairing',async()=>{
 const {net}=fixture();await net.refreshCoworkerScope();let done;net.data=()=>new Promise(r=>done=r);const p=net.collaborationControl('state',{});net.session='new';done({ok:true,auth_scope:'pairing-scope'});await assert.rejects(p,{code:'permission_denied'});
});
test('grant detail error codes retain authorization and precondition meaning',async()=>{
 const {net}=fixture();net.data=async()=>{throw Object.assign(new Error('forbidden'),{code:'forbidden',detail:{code:'permission_denied'}});};await assert.rejects(net.collaborationEndpoints(),{code:'permission_denied'});
});
