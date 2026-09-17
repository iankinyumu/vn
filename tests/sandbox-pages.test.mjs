import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, CookieJar, ResourceLoader, VirtualConsole } from 'jsdom';
import { startSandbox } from '../sandbox/server.mjs';
import { identities } from '../sandbox/database.mjs';
import { randomUUID } from 'node:crypto';

// DOM execution is deliberately separate from visual-browser verification: jsdom has no layout engine.
test('actual sandbox pages complete customer → administrator → agent → customer workflow', { timeout: 90000 }, async()=>{
    const server=await startSandbox({port:0});const windows=[];const errors=[];
    class LocalResources extends ResourceLoader{fetch(url,options){if(!url.startsWith(server.url+'/'))throw new Error('External resource forbidden in sandbox test');return super.fetch(url,options);}}
    async function persona(identity,page){
        const jar=new CookieJar();
        async function request(route,payload){
            const response=await fetch(new URL(route,server.url),{method:'POST',signal:AbortSignal.timeout(10000),headers:{Origin:server.url,'Content-Type':'application/json',Cookie:jar.getCookieStringSync(server.url)},body:JSON.stringify(payload||{})});
            const cookie=response.headers.get('set-cookie');if(cookie)jar.setCookieSync(cookie,server.url);return response.json();
        }
        await request('/sandbox-api/signin',{identity});
        const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',error=>errors.push(error.message));
        const dom=await JSDOM.fromURL(server.url+page,{cookieJar:jar,runScripts:'dangerously',resources:new LocalResources(),virtualConsole,
            beforeParse(window){window.crypto.randomUUID=randomUUID;window.fetch=async(url,options={})=>({json:async()=>request(url,JSON.parse(options.body||'{}'))});}});
        windows.push(dom.window);
        return {window:dom.window,doc:dom.window.document,request,ui:name=>dom.window.document.querySelector(`[data-ui="${name}"]`)};
    }
    async function wait(check,label){for(let i=0;i<500;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Timed out: '+label);}
    function submit(person,id){person.doc.getElementById(id).dispatchEvent(new person.window.Event('submit',{bubbles:true,cancelable:true}));}
    async function staff(identity){const person=await persona(identity,'/pages/admin.html');await wait(()=>!person.doc.getElementById('adminMfa').hidden,'MFA form');person.doc.getElementById('mfaCode').value='123456';submit(person,'mfaForm');await wait(()=>['No requests yet.','Requests loaded.'].includes(person.ui('listStatus')?.textContent),'staff inbox');return person;}
    try{
        const customer=await persona('customer','/pages/support.html');
        await wait(()=>!customer.doc.getElementById('newSupportFields').disabled,'customer session');
        for(const [id,value] of Object.entries({supportFirstName:'Sandbox',supportLastName:'Customer',supportEmail:'contact@example.test',supportMessage:'Please investigate this synthetic support issue.'}))customer.doc.getElementById(id).value=value;
        customer.doc.getElementById('supportConsent').checked=true;submit(customer,'newSupport');
        await wait(()=>customer.doc.getElementById('newSupportStatus').textContent.includes('SP-1001 received'),'persisted request');
        const admin=await staff('administrator');
        admin.ui('list').querySelector('button').click();await wait(()=>admin.ui('status').textContent==='Conversation loaded.','admin detail');
        admin.ui('assignee').value=identities.agent.id;admin.ui('assign').click();await wait(()=>admin.ui('status').textContent.startsWith('Saved.'),'assignment');
        const agent=await staff('agent');agent.ui('list').querySelector('button').click();await wait(()=>agent.ui('status').textContent==='Conversation loaded.','assigned detail');
        assert.equal(agent.ui('assignmentWrap').hidden,true);
        agent.ui('note').value='INTERNAL-ONLY sandbox evidence';agent.ui('addNote').click();await wait(()=>agent.ui('status').textContent.startsWith('Saved.'),'internal note');
        agent.ui('reply').value='Please provide a few more details.';agent.ui('replyStatus').value='waiting_for_customer';agent.ui('send').click();
        await wait(()=>agent.ui('title').textContent.includes('Waiting for customer')&&agent.ui('status').textContent.startsWith('Saved.'),'staff reply');
        customer.ui('list').querySelector('button').click();await wait(()=>customer.ui('status').textContent==='Conversation loaded.','customer detail');
        assert.match(customer.ui('messages').textContent,/Please provide a few more details/);
        assert.doesNotMatch(customer.doc.body.textContent,/INTERNAL-ONLY/);
        assert.equal(customer.ui('staffTools').hidden,true);
        customer.ui('reply').value='Here are the additional synthetic details.';customer.ui('send').click();
        await wait(()=>customer.ui('title').textContent.includes('In progress')&&customer.ui('status').textContent.startsWith('Saved.'),'customer reply');
        agent.ui('refreshTicket').click();await wait(()=>agent.ui('messages').textContent.includes('additional synthetic details'),'agent sees customer reply');
        agent.ui('reply').value='The synthetic issue is resolved.';agent.ui('replyStatus').value='resolved';agent.ui('send').click();
        await wait(()=>agent.ui('title').textContent.includes('Resolved')&&agent.ui('status').textContent.startsWith('Saved.'),'resolution');
        customer.ui('refreshTicket').click();await wait(()=>customer.ui('send').textContent==='Reopen with reply','reopening control');
        customer.ui('reply').value='This synthetic issue needs another look.';customer.ui('send').click();
        await wait(()=>customer.ui('title').textContent.includes('In progress')&&customer.ui('status').textContent.startsWith('Saved.'),'customer reopening');
        customer.doc.getElementById('supportSignOut').click();await wait(()=>customer.doc.getElementById('supportPanel').hidden,'signed out');
        assert.equal(customer.ui('messages').textContent,'');assert.deepEqual(errors,[]);
    }finally{for(const window of windows){window.dispatchEvent(new window.Event('pagehide'));window.close();}await server.close();}
});
