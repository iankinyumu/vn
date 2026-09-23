/* Shared conversation UI; every request is independently authorized by the database. */
(() => {
    const states = { open: 'Received', in_progress: 'In progress', waiting_for_customer: 'Waiting for customer', resolved: 'Resolved', closed: 'Closed' };
    const topics = { general: 'General inquiry', account: 'Account help', deposit: 'Deposit inquiry', withdrawal: 'Withdrawal inquiry', trading: 'Trading support', security: 'Security concern', bug: 'Bug report', partnership: 'Business inquiry', other: 'Other' };
    const roleLabel = { support_agent: 'Support agent', administrator: 'Administrator', owner: 'Owner' };
    const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
    class SupportWorkspace {
        constructor(root, staff) {
            this.root = root; this.staff = staff; this.epoch = 0; this.selection = 0; this.listVersion = 0; this.detailVersion=0;
            // This is a constant template. Record values are always inserted using textContent.
            root.innerHTML = `<h2>${staff ? 'Support inbox' : 'Your requests'}</h2>
              <p data-ui="summary" class="support-summary" hidden></p>
              <form data-ui="filters" class="support-filters">
                <label>Ticket reference<input data-ui="reference" placeholder="SP-1001" maxlength="30"></label>
                <label>Status<select data-ui="filterStatus"><option value="">All statuses</option></select></label>
                <label>Topic<select data-ui="filterTopic"><option value="">All topics</option></select></label>
                <label data-ui="assignmentFilterWrap" hidden>Assignment<select data-ui="assignmentFilter"><option value="">All assignments</option><option value="unassigned">Unassigned</option></select></label>
                <button type="submit">Search / refresh</button>
              </form>
              <p data-ui="listStatus" role="status" aria-live="polite"></p>
              <div class="support-layout"><div><ul data-ui="list" class="support-list"></ul><button data-ui="more" hidden>Load more requests</button></div>
              <div data-ui="thread" class="support-thread" hidden>
                <h2 data-ui="title" tabindex="-1"></h2><p data-ui="context" class="support-context"></p>
                <button data-ui="refreshTicket">Refresh conversation</button><p data-ui="status" role="status" aria-live="polite"></p>
                <button data-ui="older" hidden>Load older messages</button><div data-ui="messages"></div>
                <fieldset data-ui="replyFields"><legend>Reply to the customer</legend>
                  <label>Public message<textarea data-ui="reply" maxlength="5000" aria-label="Public reply"></textarea></label>
                  <label data-ui="replyStatusWrap" hidden>After sending<select data-ui="replyStatus"><option value="">Keep current status</option><option value="waiting_for_customer">Wait for customer</option><option value="resolved">Resolve with this explanation</option></select></label>
                  <button data-ui="send">Send reply</button></fieldset>
                <div data-ui="staffTools" hidden>
                  <fieldset data-ui="noteFields"><legend>Internal note — staff only</legend><label>Note<textarea data-ui="note" maxlength="5000"></textarea></label>
                    <label><input data-ui="escalate" type="checkbox"> Flag for administrator attention</label><button data-ui="addNote">Add internal note</button></fieldset>
                  <fieldset data-ui="handlingFields"><legend>Ticket handling</legend><label>Next status<select data-ui="nextStatus"></select></label>
                    <label>Reason<input data-ui="reason" maxlength="500"></label><p>Waiting and resolution changes also save the public message above.</p><button data-ui="transition">Change status</button>
                    <div data-ui="assignmentWrap" hidden><label>Assign to<select data-ui="assignee"><option value="">Unassigned</option></select></label><button data-ui="assign">Save assignment</button></div></fieldset>
                  <h3>Staff activity and internal notes</h3><div data-ui="activity" class="support-activity"></div><button data-ui="moreActivity" hidden>Load older activity</button>
                </div>
              </div></div>`;
            this.el = name => root.querySelector(`[data-ui="${name}"]`);
            for (const [value,label] of Object.entries(states)) this.option('filterStatus',value,this.label(value));
            for (const [value,label] of Object.entries(topics)) this.option('filterTopic',value,label);
            this.el('replyFields').querySelector('legend').textContent = staff ? 'Reply to the customer' : 'Reply to support';
            this.el('filters').addEventListener('submit', event => { event.preventDefault(); this.loadList(); });
            this.el('more').addEventListener('click', () => this.loadList(true));
            this.el('older').addEventListener('click', () => this.loadTicket(true));
            this.el('refreshTicket').addEventListener('click', () => this.loadTicket());
            this.el('moreActivity').addEventListener('click', () => this.loadActivity(true));
            this.el('send').addEventListener('click', () => this.mutate('send_support_reply', {
                p_body:this.el('reply').value.trim(),p_staff:staff,p_status:staff ? this.el('replyStatus').value || null : this.ticket.status==='resolved' ? 'in_progress' : null
            },'reply'));
            this.el('addNote').addEventListener('click', () => this.mutate('add_support_note', { p_body:this.el('note').value.trim(),p_escalate:this.el('escalate').checked },'note'));
            this.el('assign').addEventListener('click', () => this.mutate('assign_support_ticket', { p_assignee:this.el('assignee').value || null,p_reason:this.el('reason').value.trim() }));
            this.el('transition').addEventListener('click', () => this.mutate('change_support_status', {
                p_status:this.el('nextStatus').value,p_body:this.el('reply').value.trim(),p_reason:this.el('reason').value.trim()
            },'reply'));
            this.clear();
        }
        label(status) { return !this.staff && status==='waiting_for_customer' ? 'Waiting for you' : states[status] || status; }
        option(name,value,label) { const option=node('option',label); option.value=value; this.el(name).append(option); }
        async rpc(name,payload={}) { const result=await this.client.rpc(name,payload); if(result.error) throw result.error; return result.data; }
        clear() {
            this.epoch++; this.selection++; this.listVersion++; this.detailVersion++; this.client=null; this.access=null; this.ticket=null; this.key=null; this.busy=false;
            this.listCursor=null;this.activityCursor=null;this.messageCursor=null;this.assignees=new Map();
            this.el('assignee').replaceChildren();this.option('assignee','','Unassigned');
            this.el('assignmentFilter').replaceChildren();this.option('assignmentFilter','','All assignments');this.option('assignmentFilter','unassigned','Unassigned');
            this.root.hidden=true; this.el('thread').hidden=true;
            for(const name of ['list','messages','activity']) this.el(name).replaceChildren();
            for(const name of ['reply','note','reason','reference']) this.el(name).value='';
            for(const name of ['status','context','title','summary','listStatus']) this.el(name).textContent='';
            this.el('filterStatus').value=''; this.el('filterTopic').value='';
            this.el('more').hidden=true; this.el('moreActivity').hidden=true;
        }
        async open(client,access) {
            this.clear(); this.client=client; this.access=access; this.root.hidden=false;
            const epoch=this.epoch;
            this.el('staffTools').hidden=!this.staff; this.el('replyStatusWrap').hidden=!this.staff;
            this.el('assignmentWrap').hidden=!access?.capabilities?.includes('support.assign');
            this.el('assignmentFilterWrap').hidden=this.el('assignmentWrap').hidden;
            this.assignees=new Map();
            if(this.staff && access.capabilities.includes('support.assign')) {
                try {
                    const rows=await this.rpc('list_support_assignees'); if(epoch!==this.epoch)return;
                    this.el('assignee').replaceChildren();this.option('assignee','','Unassigned');
                    this.el('assignmentFilter').replaceChildren();this.option('assignmentFilter','','All assignments');this.option('assignmentFilter','unassigned','Unassigned');
                    for(const row of rows) {
                        const label=`${roleLabel[row.role]} (account …${row.id.slice(-6)})`;this.assignees.set(row.id,label);
                        this.option('assignee',row.id,label);this.option('assignmentFilter',row.id,label);
                    }
                } catch(error) { if(epoch===this.epoch)this.error(error,'listStatus'); }
            }
            if(epoch===this.epoch)await this.loadList();
        }
        error(error,target='status') {
            if(['forbidden','unauthenticated','mfa_required'].includes(error?.message)) {
                this.clear();
                if(this.staff)window.dispatchEvent(new CustomEvent('staff-access-lost'));
                else { this.root.hidden=false;this.el('listStatus').textContent='Your session is no longer available. Sign in again.'; }
                return;
            }
            if(error?.message==='not_found') { this.ticket=null;this.selection++;this.el('thread').hidden=true;this.el('reply').value='';this.el('note').value='';target='listStatus'; }
            const messages={ conflict:'This ticket changed. Refresh the conversation, review the current state and try again. Your draft is preserved.',
                rate_limited:'Too many requests. Wait a moment before trying again.', invalid_transition:'That status change or reply is not available for the current ticket state.',
                validation_failed:'Check the message, reason and selected action.',not_found:'This ticket is no longer available to you.' };
            this.el(target).textContent=messages[error?.message] || 'This request could not be confirmed. Your draft is preserved. Please retry.';
        }
        async loadList(more=false) {
            if(!this.client)return;
            const epoch=this.epoch, request=++this.listVersion;
            const reference=this.el('reference').value.trim().toUpperCase();
            if(reference && !/^SP-\d+$/.test(reference)){this.el('listStatus').textContent='Enter a reference such as SP-1001.';return;}
            this.el('listStatus').textContent='Loading requests…';this.el('more').disabled=true;
            const filter=this.el('assignmentFilter').value;
            try {
                const data=await this.rpc('list_support_tickets',{p_staff:this.staff,p_status:this.el('filterStatus').value||null,p_subject:this.el('filterTopic').value||null,
                    p_reference:reference||null,...(this.staff && this.access.capabilities.includes('support.assign') ? {p_unassigned:filter==='unassigned',p_assignee:filter && filter!=='unassigned' ? filter : null}:{}),
                    ...(more&&this.listCursor?{p_before_time:this.listCursor.time,p_before_id:this.listCursor.id}:{})});
                if(epoch!==this.epoch||request!==this.listVersion)return;
                if(!more){this.el('list').replaceChildren();this.listIds=new Set();}
                for(const row of data.items){
                    if(this.listIds.has(row.id))continue;this.listIds.add(row.id);
                    const item=node('li'),button=node('button',`${row.reference} · ${topics[row.subject]}`);
                    const detail=node('small',`${this.label(row.status)}${row.unread?' · Unread':''}${row.escalated?' · Escalated':''} · ${new Date(row.last_activity).toLocaleString()}`);
                    button.append(detail);
                    if(this.staff)button.append(node('small',`${row.customer_name} · ${row.assignee_id ? this.assignees.get(row.assignee_id)||'Assigned to you' : 'Unassigned'}`));
                    button.addEventListener('click',()=>this.select(row));item.append(button);this.el('list').append(item);
                }
                this.listCursor=data.next;this.el('more').hidden=!data.next;
                this.el('listStatus').textContent=data.items.length?'Requests loaded.':more?'No older requests.':reference||this.el('filterStatus').value||this.el('filterTopic').value||filter?'No requests match these filters.':'No requests yet.';
                if(this.staff){
                    const summary=await this.rpc('get_support_summary');if(epoch!==this.epoch||request!==this.listVersion)return;
                    this.el('summary').hidden=false;
                    this.el('summary').textContent=`Received: ${summary.received} · Waiting: ${summary.waiting} · Assigned to you: ${summary.assigned_to_me}${summary.unassigned===null?'':` · Unassigned: ${summary.unassigned}`} · Resolved in last 7 days (UTC): ${summary.resolved_last_7_days}. Updated ${new Date(summary.observed_at).toLocaleString()}.`;
                }
            }catch(error){if(epoch===this.epoch&&request===this.listVersion)this.error(error,'listStatus');}
            finally{if(epoch===this.epoch&&request===this.listVersion)this.el('more').disabled=false;}
        }
        async select(row){this.selection++;this.ticket=row;this.key=null;this.busy=false;this.el('reply').value='';this.el('note').value='';this.el('reason').value='';this.el('escalate').checked=false;await this.loadTicket();}
        async loadTicket(older=false){
            if(!this.ticket||this.busy)return;
            const epoch=this.epoch,selection=this.selection,id=this.ticket.id,request=++this.detailVersion;
            this.el('thread').hidden=false;this.el('status').textContent='Loading conversation…';
            try{
                const data=await this.rpc('get_support_ticket',{p_ticket_id:id,p_staff:this.staff,...(older?{p_before_sequence:this.messageCursor}:{})});
                if(epoch!==this.epoch||selection!==this.selection||request!==this.detailVersion)return;
                this.ticket=data.ticket;this.messageCursor=data.next;
                this.el('title').textContent=`${data.ticket.reference} · ${this.label(data.ticket.status)}`;
                this.el('context').textContent=this.staff?`${data.contact.name} · ${data.contact.email}${data.contact.phone?' · '+data.contact.phone:''}. ${data.contact.notice}`:'Your conversation with support.';
                if(!older)this.el('messages').replaceChildren();
                const fragment=document.createDocumentFragment();
                for(const message of data.messages){const item=node('article');item.append(node('strong',`${message.author_kind==='staff'?'Support representative':'Customer'} · ${new Date(message.created_at).toLocaleString()}`),node('p',message.body));fragment.append(item);}
                if(older)this.el('messages').prepend(fragment);else this.el('messages').append(fragment);
                this.el('older').hidden=data.next===null;
                this.controls(true);this.el('status').textContent=data.ticket.status==='closed'?'This conversation is closed. You can submit a new request referencing this ticket.':'Conversation loaded.';
                if(data.messages.length)await this.rpc('mark_support_read',{p_ticket_id:id,p_sequence:Math.max(...data.messages.map(m=>m.sequence)),p_staff:this.staff});
                if(epoch!==this.epoch||selection!==this.selection||request!==this.detailVersion)return;
                if(this.staff&&!older)await this.loadActivity();
                return true;
            }catch(error){if(epoch===this.epoch&&selection===this.selection&&request===this.detailVersion)this.error(error);return false;}
        }
        controls(rebuild=false){
            const state=this.ticket.status;
            this.el('replyFields').disabled=this.busy||state==='closed'||(this.staff&&state==='resolved');
            this.el('noteFields').disabled=this.busy;this.el('handlingFields').disabled=this.busy;
            this.el('send').textContent=!this.staff&&state==='resolved'?'Reopen with reply':'Send reply';
            if(!rebuild)return;
            this.el('assignee').value=this.ticket.assignee_id||'';
            const allowed={open:['in_progress','waiting_for_customer','resolved'],in_progress:['waiting_for_customer','resolved'],waiting_for_customer:['in_progress','resolved'],resolved:['in_progress'],closed:[]}[state]||[];
            if(this.access?.capabilities?.includes('support.close')){if(state==='resolved')allowed.push('closed');if(state==='closed')allowed.push('in_progress');}
            this.el('nextStatus').replaceChildren();for(const value of allowed)this.option('nextStatus',value,this.label(value));
            this.el('transition').disabled=!allowed.length;
        }
        async loadActivity(more=false){
            const epoch=this.epoch,selection=this.selection;
            try{
                const data=await this.rpc('list_support_activity',{p_ticket_id:this.ticket.id,...(more&&this.activityCursor?{p_before_time:this.activityCursor.time,p_before_id:this.activityCursor.id}:{})});
                if(epoch!==this.epoch||selection!==this.selection)return;
                if(!more)this.el('activity').replaceChildren();
                for(const row of data.items){const item=node('article');if(row.kind==='note')item.className='support-note';
                    item.append(node('strong',`${row.kind==='note'?'Internal note':row.kind==='assignment'?'Assignment changed':row.kind==='status'?'Status changed':'Escalated'} · ${new Date(row.created_at).toLocaleString()}`));
                    item.append(node('p',row.kind==='note'?row.detail.body:row.kind==='status'?`${this.label(row.detail.from)} → ${this.label(row.detail.to)}${row.detail.reason?' · '+row.detail.reason:''}`:row.detail.reason||'Handling updated.'));
                    this.el('activity').append(item);}
                this.activityCursor=data.next;this.el('moreActivity').hidden=!data.next;
            }catch(error){if(epoch===this.epoch&&selection===this.selection)this.error(error);}
        }
        async mutate(operation,payload,field){
            if(!this.ticket||this.busy)return;
            if(field&&(!payload.p_body||payload.p_body.length>5000)&&operation!=='change_support_status'){this.el('status').textContent='Enter a message of 1–5,000 characters.';return;}
            const epoch=this.epoch,selection=this.selection,id=this.ticket.id;
            const draft=field?this.el(field).value:null;
            const input={p_ticket_id:id,p_expected_version:this.ticket.version,...payload};
            const fingerprint=JSON.stringify({operation,input});
            if(!this.key||this.key.fingerprint!==fingerprint)this.key={fingerprint,id:window.crypto.randomUUID()};
            this.busy=true;this.controls();this.el('status').textContent='Saving…';
            try{
                const result=await this.rpc(operation,{...input,p_request_id:this.key.id});
                if(epoch!==this.epoch||selection!==this.selection)return;
                if(result?.id!==id||!result.version)throw new Error('unconfirmed');
                if(field&&this.el(field).value===draft)this.el(field).value='';
                this.key=null;this.busy=false;const refreshed=await this.loadTicket();
                if(epoch!==this.epoch||selection!==this.selection||!this.ticket)return;
                this.el('status').textContent=refreshed?'Saved. The server confirmed this update.':'Saved. The conversation could not be refreshed; use Refresh conversation to load it.';
                await this.loadList();
            }catch(error){if(epoch===this.epoch&&selection===this.selection)this.error(error);}
            finally{if(epoch===this.epoch&&selection===this.selection&&this.ticket){this.busy=false;this.controls();}}
        }
    }
    window.SupportWorkspace=SupportWorkspace;
})();
