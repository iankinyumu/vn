document.addEventListener('DOMContentLoaded',async()=>{
    const el=id=>document.getElementById(id);
    const workspace=new window.SupportWorkspace(el('supportPanel'),false);
    let client,user,epoch=0,pending=false,key=null,subscription;
    function update(next){
        if(user?.id===next?.id&&user!==undefined)return;
        user=next;epoch++;workspace.clear();pending=false;key=null;el('newSupport').reset();el('newSupportStatus').textContent='';
        el('newSupportFields').disabled=!user;el('supportEmail').value=user?.email||'';
        el('supportSignIn').hidden=Boolean(user);el('supportSignOut').hidden=!user;
        el('supportSession').textContent=user?`Signed in as ${user.email}.`:'Sign in to read and reply to your requests.';
        if(user){const generation=epoch;setTimeout(()=>{if(generation===epoch)void workspace.open(client,{user_id:user.id,capabilities:[]});},0);}
    }
    el('newSupport').addEventListener('submit',async event=>{
        event.preventDefault();if(!user||pending||!el('newSupport').reportValidity())return;
        const generation=epoch;
        const payload={p_first_name:el('supportFirstName').value.trim(),p_last_name:el('supportLastName').value.trim(),p_email:el('supportEmail').value.trim(),p_phone:'',p_subject:el('supportTopic').value,p_message:el('supportMessage').value.trim(),p_consent:el('supportConsent').checked};
        const fingerprint=JSON.stringify(payload);if(!key||key.fingerprint!==fingerprint)key={fingerprint,id:crypto.randomUUID()};
        pending=true;el('newSupportFields').disabled=true;el('newSupportStatus').textContent='Saving request…';
        try{
            const {data,error}=await client.rpc('submit_support_ticket',{p_id:key.id,...payload});
            if(generation!==epoch)return;if(error)throw error;
            if(data?.id!==key.id||!/^SP-\d+$/.test(data.reference))throw new Error('unconfirmed');
            el('newSupportStatus').textContent=`Request ${data.reference} received.`;el('newSupport').reset();el('supportEmail').value=user.email||'';key=null;
            await workspace.loadList();
        }catch(error){if(generation===epoch)el('newSupportStatus').textContent=error.message==='support_rate_limit'?'You have submitted 5 requests in the last hour. Please wait before sending another.':'We could not confirm your request. Your draft is preserved; retry without editing to avoid duplication.';}
        finally{if(generation===epoch){pending=false;el('newSupportFields').disabled=!user;}}
    });
    el('supportSignOut').addEventListener('click',async()=>{
        workspace.clear();el('newSupportFields').disabled=true;
        const generation=epoch;
        try{const {error}=await client.auth.signOut();if(generation!==epoch)return;if(error)throw error;update(null);}catch(_){if(generation===epoch)el('supportSession').textContent='Sign-out could not be confirmed. Please try again.';}
    });
    try{
        client=await window.getSupabaseClient();
        subscription=client.auth.onAuthStateChange((_event,session)=>{update(session?.user||null);}).data?.subscription;
        const generation=epoch;const {data,error}=await client.auth.getSession();if(generation!==epoch)return;if(error)throw error;update(data.session?.user||null);
    }catch(_){el('supportSession').textContent='Your session could not be checked. Reload to try again.';}
    window.addEventListener('pagehide',()=>{epoch++;workspace.clear();subscription?.unsubscribe();});
    window.addEventListener('pageshow',event=>{if(event.persisted)window.location.reload();});
});
