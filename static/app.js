'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = {todo:'Not started',in_progress:'In progress',pending:'Needs review',verified:'Verified',rework:'Rework needed'};
const points = {easy:25,medium:50,hard:75};
const titles = {floor:'Shift overview',records:'Activity & records',team:'Team progress',admin:'Admin workspace'};
let state, view='floor', shift=sessionStorage.getItem('shift') || 'Day', person=Number(sessionStorage.getItem('person')) || 0;
let filter='all', search='', adminTab='review', recordStatus='all', recordDate='', recordSearch='', lastState='', toastTimer;
const dateTime = t => t ? new Date(t).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit'}) : '—';
const badge = status => `<span class="badge ${status}">${labels[status] || status[0].toUpperCase()+status.slice(1)}</span>`;
const activeUsers = () => state.users.filter(u=>u.active);
const userOptions = selected => `<option value="">Choose your name</option>${activeUsers().map(u=>`<option value="${u.id}" ${u.id===selected?'selected':''}>${esc(u.name)}</option>`).join('')}`;
const currentRuns = () => state.runs.filter(r=>r.work_day===state.day && r.shift===shift);
const machineRun = id => currentRuns().find(r=>r.machine_id===id);
const allocation = id => state.assignments.find(a=>a.shift===shift && a.machine_id===id);
const assignedUser = id => state.users.find(u=>u.id===allocation(id)?.user_id);
const earned = id => state.runs.filter(r=>r.user_id===id && r.status==='verified').reduce((s,r)=>s+r.points,0);
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),4500);}
async function api(path, data){
  const response=await fetch(path, data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result=await response.json();
  if(!response.ok) throw new Error(result.error || 'Could not complete the request.');
  return result;
}
async function refresh(force=false){
  try{
    const next=await api('/api/state');
    const changed=JSON.stringify(next)!==lastState;
    state=next;
    if(!state.shifts.includes(shift)) shift='Day';
    if(!activeUsers().some(u=>u.id===person)) person=0;
    $('#connection-label').textContent='Local server connected';$('#connection-label').classList.remove('offline');
    $('#review-count').textContent=state.runs.filter(r=>r.status==='pending').length;
    $('#date-label').textContent=new Date(state.day+'T12:00:00').toLocaleDateString([], {weekday:'short',month:'short',day:'numeric',year:'numeric'});
    const editing=$('#main').contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if(force || (changed && !$('#modal').open && !editing)) render();
  }catch(error){
    $('#connection-label').textContent='Server disconnected · retrying';$('#connection-label').classList.add('offline');
    if(!state) $('#main').innerHTML='<div class="empty">The local server is unavailable. Start STARTSERVER.bat, then refresh this page.</div>';
    if(force && state) toast(error.message);
  }
}
function heading(title, subtitle, right=''){return `<div class="page-heading"><div><div class="eyebrow">A little care. Every shift.</div><h1>${title}</h1><p>${subtitle}</p></div>${right}</div>`;}
function render(){
  if(!state) return;
  lastState=JSON.stringify(state);
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  $('#page-label').textContent=titles[view];
  $('#main').innerHTML=({floor:floorView,records:recordsView,team:teamView,admin:adminView}[view])();
  if(view==='floor'){
    $('.content-grid').insertAdjacentHTML('beforebegin', workloadBoard());
    $('.filters').insertAdjacentHTML('afterbegin', `<button class="filter ${filter==='mine'?'active':''}" data-filter="mine">My tasks</button>`);
    const shiftSelect=$('#shift');
    shiftSelect.innerHTML=state.shifts.map(s=>`<option ${s===shift?'selected':''}>${s}</option>`).join('');
  }
  if(view==='admin' && state.admin && $('.admin-tabs')) $('.admin-tabs').insertAdjacentHTML('afterbegin','<button class="btn" data-admin-tab="roster">Shift assignments</button>');
}
function workloadBoard(){
  const assignments=state.assignments.filter(a=>a.shift===shift);
  const ids=new Set([...state.roster.filter(r=>r.shift===shift).map(r=>r.user_id),...assignments.filter(a=>a.user_id).map(a=>a.user_id)]);
  return `<section class="panel workload"><div class="section-head"><div><h2>One shift. A shared workload.</h2><p>The same ${state.machines.length} tasks repeat each Day and Night. Easy = 1, medium = 2, hard = 3 workload units.</p></div>${state.admin?'<button class="btn" data-action="roster">Set shift crew</button>':''}</div><div class="workload-grid">${[...ids].map(id=>{
    const u=state.users.find(u=>u.id===id), tasks=state.machines.filter(m=>allocation(m.id)?.user_id===id), load=tasks.reduce((s,m)=>s+points[m.difficulty]/25,0);
    return `<button class="workload-person ${person===id?'selected':''}" data-action="my-work" data-id="${id}"><strong>${esc(u?.name || 'Archived member')}</strong><span>${tasks.length} tasks · ${load} workload units</span><small>${['hard','medium','easy'].map(d=>`${tasks.filter(m=>m.difficulty===d).length} ${d}`).join(' · ')}</small></button>`;
  }).join('') || '<p class="empty">No crew selected. An admin needs to set this shift’s roster.</p>'}</div>${assignments.some(a=>!a.user_id)?'<p class="error">Some tasks are unassigned. Add people to this shift in Admin → Shift assignments.</p>':''}<p class="mini-note">Balanced by difficulty, with daily rotation. Work one task at a time; submitted tasks can wait for review while you start your next assignment.</p></section>`;
}
function machineIcon(id){
  const paths=[
    '<ellipse cx="20" cy="9" rx="9" ry="4"/><path d="M11 9v20c0 5 18 5 18 0V9M11 23h18M15 33v4m10-4v4M20 3v2"/>',
    '<rect x="7" y="10" width="26" height="21" rx="3"/><path d="M12 12v17m5-17v17m6-17v17m5-17v17M3 15h4m26 11h4M11 31v5m18-5v5"/>',
    '<rect x="5" y="18" width="30" height="14" rx="3"/><path d="M12 18V9h16v9M9 32v4m22-4v4M19 6v3"/><circle cx="14" cy="25" r="3"/><circle cx="27" cy="25" r="3"/>',
    '<path d="M9 12h22v14c0 10-22 10-22 0V12M13 33v4m14-4v4M20 4v23m-5-4 10 5m-10 0 10-5"/><path d="M7 12h26M16 5h8"/>',
    '<path d="M8 6h24v26H8zM4 34h32M13 11h14M14 11v8m12-8v8M12 24h5v7h-5zm11 0h5v7h-5z"/>',
    '<rect x="3" y="23" width="34" height="8" rx="4"/><path d="M9 31v5m22-5v5M9 23V12h10v11m3 0V9h10v14"/><circle cx="10" cy="27" r="1"/><circle cx="20" cy="27" r="1"/><circle cx="30" cy="27" r="1"/>'
  ];
  return `<svg viewBox="0 0 40 40" aria-hidden="true">${paths[(id-1)%paths.length]}</svg>`;
}
function floorView(){
  const runs=currentRuns(), current=state.machines.map(m=>machineRun(m.id)).filter(Boolean);
  const verified=current.filter(r=>r.status==='verified').length, pending=current.filter(r=>r.status==='pending').length;
  const remaining=state.machines.length-current.filter(r=>['verified','pending'].includes(r.status)).length;
  const xp=runs.filter(r=>r.status==='verified').reduce((s,r)=>s+r.points,0);
  return heading('Make this a clean shift.', 'Your equipment, your checklist, a job well done.', `<label class="shift-picker">◷ Shift <select id="shift" aria-label="Current shift">${['Day','Evening','Night'].map(s=>`<option ${s===shift?'selected':''}>${s}</option>`).join('')}</select></label>`)+`
  <section class="hero"><div class="hero-content"><div class="eyebrow">THE CLEANSHIFT CHALLENGE</div><h2>Small actions. A higher standard.</h2><p>Every completed checklist is a step toward a cleaner facility.<br>Choose your name, follow the steps, and make your work count.</p><div class="hero-badges"><span>✓ Guided cleaning</span><span>◷ Timestamped records</span><span>✧ Earn recognition</span></div></div><div class="hero-art" aria-hidden="true"><span class="spark">✧</span><div class="shield">✓</div></div></section>
  <section class="stats" aria-label="Current shift progress">${[
    ['Verified tasks',`${verified} <small>/ ${state.machines.length}</small>`,'✓','<b>Supervisor checked</b> this shift'],
    ['Ready for review',pending,'◷','Submitted · awaiting verification'],
    ['Still to complete',remaining,'▦','Not started, in progress, or rework'],
    ['Team points',`${xp} <small>XP</small>`,'✧','Awarded for verified work only']
  ].map(([label,value,icon,foot])=>`<div class="stat"><div class="stat-label">${label}<span class="stat-icon">${icon}</span></div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></div>`).join('')}</section>
  <div class="content-grid"><section><div class="section-head"><div><h2>Your cleaning board</h2><p>${state.machines.length} machines · ${esc(shift)} shift · ${esc(state.day)}</p></div><button class="text-link" data-action="refresh">Refresh ↻</button></div><div class="filters">${[['all','All machines'],['todo','To do'],['in_progress','In progress'],['verified','Verified']].map(([v,l])=>`<button class="filter ${filter===v?'active':''}" data-filter="${v}">${l}</button>`).join('')}<input class="search" id="machine-search" aria-label="Search machines" placeholder="Search equipment…" value="${esc(search)}"></div><div class="machines" id="machine-grid">${machineCards()}</div><p class="mini-note">Difficulty: <span class="badge easy">Easy · 25 XP</span> <span class="badge medium">Medium · 50 XP</span> <span class="badge hard">Hard · 75 XP</span></p></section>
  <aside class="rail"><section class="rail-card"><div class="rail-title"><h3>Who's on the task?</h3><span>♧</span></div><select class="person-select" id="person" aria-label="Your name">${userOptions(person)}</select>${personalProgress()}<p class="mini-note">No employee login. Select your own name before starting a task.</p></section><section class="rail-card"><div class="rail-title"><h3>Latest activity</h3><button class="text-link" data-view="records">View all ↗</button></div>${activity()}</section><section class="quality-card"><span class="quality-icon">♧</span><h3>Quality comes before points.</h3><p>Take the time to do it right. Your supervisor verifies the work before XP is awarded.</p></section></aside></div>`;
}
function machineCards(){
  const machines=state.machines.filter(m=>{
    const r=machineRun(m.id), status=r?.status || 'todo';
    return (filter==='all' || (filter==='mine'?!!person && allocation(m.id)?.user_id===person:filter==='todo'?['todo','rework'].includes(status):filter===status)) && (m.name+' '+m.area).toLowerCase().includes(search.toLowerCase());
  });
  return machines.map(m=>{
    const r=machineRun(m.id), status=r?.status || 'todo';
    let text='Start task', action='machine', id=m.id;
    if(r && ['pending','verified'].includes(status)){text='View record';action='record';id=r.id;}
    if(status==='in_progress'){text='Resume task';action='resume';id=r.id;}
    if(status==='rework') text='Try again';
    const owner=assignedUser(m.id);
    const blocked=['todo','rework'].includes(status) && (!person || owner?.id!==person || state.runs.some(r=>r.user_id===person && r.status==='in_progress'));
    return `<article class="machine-card"><div class="machine-top"><div class="machine-icon">${machineIcon(m.id)}</div>${badge(m.difficulty)}</div><div class="machine-body"><h3>${esc(m.name)}</h3><div class="machine-area">${esc(m.area)}</div><p class="machine-desc">${esc(m.description)}</p><p class="assigned-label">Assigned to <strong>${esc(owner?.name || 'Unassigned')}</strong></p><div class="machine-meta"><span>☷ ${m.steps.length} steps</span><span>◉ 3 questions</span><span class="points">✧ ${points[m.difficulty]} XP</span></div></div><div class="machine-bottom">${badge(status)}<button class="btn small ${['todo','rework'].includes(status)?'primary':''}" data-action="${action}" data-id="${id}" ${blocked?'disabled title="Select your own name and complete any in-progress task first. You can start only your assigned tasks."':''}>${text} <span>↗</span></button></div></article>`;
  }).join('') || '<div class="empty">No machines match this view.</div>';
}
function personalProgress(){
  const u=state.users.find(u=>u.id===person), xp=earned(person), level=Math.floor(xp/250)+1;
  return `<div class="member-summary"><span class="avatar">${u?esc(initials(u.name)):'?'}</span><div><strong>${u?esc(u.name):'Your next good habit'}</strong><small>Level ${level} · ${xp>=500?'Kleanup champion':xp>=250?'Quality keeper':'Care crew'}</small></div></div><progress value="${xp%250}" max="250" aria-label="Progress to next level"></progress><div class="progress-copy"><span>${xp} lifetime XP</span><span>${250-xp%250} to level ${level+1}</span></div><div class="level-message">✧ ${xp?'Keep building on your verified work.':'Your first verified task earns your first XP.'}</div>`;
}
function initials(name){return name.split(' ').filter(Boolean).map(s=>s[0]).slice(0,2).join('').toUpperCase();}
function activity(){return state.runs.slice(0,4).map(r=>`<div class="activity-item"><span class="activity-dot">${r.status==='verified'?'✓':'◷'}</span><div><strong>${esc(r.person)} · ${labels[r.status]}</strong><p>${esc(r.machine)}</p><small>${dateTime(r.reviewed || r.submitted || r.started)}</small></div></div>`).join('') || '<div class="empty">A fresh start for the team.<br>Your first task will appear here.</div>';}
function recordsView(){return heading('Every task has a story.', 'See who started, what was submitted, and what your supervisor verified.',state.admin?'<a class="btn" href="/api/export">↓ Export CSV</a>':'')+`<div class="toolbar"><input class="search" id="record-search" placeholder="Search name or equipment…" aria-label="Search records" value="${esc(recordSearch)}"><select class="input" id="record-status" aria-label="Record status"><option value="all">All statuses</option>${Object.entries(labels).filter(([k])=>k!=='todo').map(([k,v])=>`<option value="${k}" ${recordStatus===k?'selected':''}>${v}</option>`).join('')}</select><input class="input" id="record-date" type="date" value="${recordDate}" aria-label="Work date"><button class="btn" data-action="clear-records">Clear filters</button></div><div class="records-wrap" id="records-table">${recordTable()}</div><p class="mini-note">Times shown in your browser’s local time. Dates and shifts are assigned by the server. Employee names are self-selected.</p>`;}
function recordTable(){
  const rows=state.runs.filter(r=>(recordStatus==='all'||r.status===recordStatus)&&(!recordDate||r.work_day===recordDate)&&(r.person+' '+r.machine).toLowerCase().includes(recordSearch.toLowerCase()));
  return rows.length?`<table><thead><tr><th>EQUIPMENT / RECORD</th><th>TEAM MEMBER</th><th>SHIFT DATE</th><th>STARTED</th><th>STATUS</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${esc(r.machine)}</strong><small>CS-${String(r.id).padStart(4,'0')}</small></td><td>${esc(r.person)}</td><td>${r.work_day}<small>${r.shift} shift</small></td><td>${dateTime(r.started)}</td><td>${badge(r.status)}</td><td><button class="btn small" data-action="${r.status==='in_progress'?'resume':'record'}" data-id="${r.id}">${r.status==='in_progress'?'Resume':'Details'} ↗</button></td></tr>`).join('')}</tbody></table>`:'<div class="empty">No records yet in this view. Start a task from the shift overview.</div>';
}
function teamView(){return heading('Good work adds up.', 'Individual milestones. One shared standard.')+`<div class="notice green">Earn 25 / 50 / 75 XP for verified easy / medium / hard tasks. Every 250 XP unlocks a level. There are no speed bonuses.</div><div class="team-grid">${activeUsers().map(u=>{
  const xp=earned(u.id), runs=state.runs.filter(r=>r.user_id===u.id && r.status==='verified');
  return `<article class="team-card"><span class="avatar">${esc(initials(u.name))}</span><h3>${esc(u.name)}</h3><span class="badge verified">Level ${Math.floor(xp/250)+1} · ${xp>=500?'Kleanup champion':xp>=250?'Quality keeper':'Care crew'}</span><div class="score">${xp} <small>lifetime XP</small></div><progress value="${xp%250}" max="250" aria-label="${esc(u.name)} level progress"></progress><div class="progress-copy"><span>${runs.length} verified tasks</span><span>${250-xp%250} XP to next level</span></div><div class="level-message">${runs.length?'✧ First clean earned':'○ First clean · complete one verified task'}<br>${runs.length>=5?'✧ Helping hand earned':'○ Helping hand · complete five verified tasks'}</div></article>`;
  }).join('') || '<div class="empty">An admin can add your first team members.</div>'}</div>`;}
function adminView(){
  if(state.admin && adminTab==='roster') return heading('Share the work fairly.', 'Set the recurring Day and Night crews. Unstarted tasks are balanced automatically.', '<button class="btn" data-action="logout">Lock admin ↗</button>')+'<div class="admin-tabs"><button class="btn primary" data-admin-tab="review">Back to reviews</button></div>'+rosterPanel();
  if(!state.admin) return heading('A higher standard starts here.', 'Manage your team, equipment, and verification queue.')+`<form class="panel login-panel" id="login-form"><span class="quality-icon">⚙</span><h2>Admin workspace</h2><p>Enter the admin password to review work and manage the facility.</p><label class="form-label" for="password">Admin password</label><input class="input" id="password" name="password" type="password" autocomplete="current-password" required><p class="error" role="alert"></p><div class="modal-actions"><button class="btn primary">Unlock workspace ↗</button></div><p class="mini-note">Employees use the name picker. Only admins need a password.</p></form>`;
  return heading('Keep the whole shift on track.', 'Review completed work and manage your facilities workspace.', '<button class="btn" data-action="logout">Lock admin ↗</button>')+`<div class="admin-tabs">${[['review','Review queue'],['machines','Equipment'],['users','Team members'],['audit','Audit trail'],['settings','Settings']].map(([id,label])=>`<button class="btn ${adminTab===id?'primary':''}" data-admin-tab="${id}">${label}${id==='review'?' · '+state.runs.filter(r=>r.status==='pending').length:''}</button>`).join('')}<a href="/api/export" class="btn">↓ Export CSV</a></div>${({review:reviewPanel,machines:machinesPanel,users:usersPanel,audit:auditPanel,settings:settingsPanel}[adminTab])()}`;
}
function reviewPanel(){
  const runs=state.runs.filter(r=>['pending','in_progress'].includes(r.status));
  return '<div class="notice green">Verification is a separate admin decision. Inspect the work and any referenced site records, then add your verification note. Returning a task keeps the original record and allows a fresh attempt.</div>'+ (runs.map(r=>`<article class="review-card"><div class="review-card-header"><div><h3>${esc(r.machine)}</h3><p>${esc(r.person)} · ${r.work_day} · ${r.shift} shift · CS-${String(r.id).padStart(4,'0')}</p></div>${badge(r.status)}</div><p>Started ${dateTime(r.started)}${r.submitted?' · Submitted '+dateTime(r.submitted):''}</p><div class="review-note">${esc(r.note || 'Task is in progress. If it was abandoned, return it for a new attempt.')}</div><details class="review-details"><summary>Inspect checklist & knowledge check</summary>${runEvidence(r)}</details><div class="review-actions">${r.status==='pending'?`<button class="btn primary" data-action="review" data-id="${r.id}" data-decision="verified">✓ Verify · award ${r.points} XP</button>`:''}<button class="btn danger" data-action="review" data-id="${r.id}" data-decision="rework">Return for rework</button></div></article>`).join('') || '<div class="panel empty">You’re all caught up. Submitted checklists will appear here for verification.</div>');
}
function rosterPanel(){return `<div class="notice green">Only selected people receive new assignments. Existing in-progress, submitted, and verified work stays with its original person. New team members must be added to a shift here. These rosters repeat daily until changed.</div><div class="admin-grid">${state.shifts.map(s=>`<form class="panel roster-form" data-shift="${s}"><h3>${s} shift crew</h3>${activeUsers().map(u=>`<label class="check-row"><input type="checkbox" name="user" value="${u.id}" ${state.roster.some(r=>r.shift===s && r.user_id===u.id)?'checked':''}><span>${esc(u.name)}</span></label>`).join('')}<p class="mini-note">Saving an empty crew leaves unstarted tasks visibly unassigned.</p><p class="error" role="alert"></p><button class="btn primary">Save ${s} crew & balance tasks</button></form>`).join('')}</div>`;}
function runEvidence(r){return `<ol>${r.steps.map(s=>`<li>${esc(s)} ${r.submitted?'✓':''}</li>`).join('')}</ol>${r.answers?state.questions.map((q,i)=>`<p><strong>${esc(q.q)}</strong><br>${esc(q.options[r.answers[i]])} ✓</p>`).join(''):'<p>Checklist and answers have not been submitted.</p>'}`;}
function machinesPanel(){return `<div class="admin-grid"><section class="panel"><h3>Facility equipment · ${state.machines.length}</h3>${state.machines.map(m=>`<div class="admin-list-item"><div>${esc(m.name)}<small>${esc(m.area)} · ${m.difficulty} · ${m.steps.length} steps</small></div><button class="btn small danger" data-action="delete-machine" data-id="${m.id}">Delete</button></div>`).join('')}<p class="mini-note">Deleting equipment removes it from the board. Its historical records remain available.</p></section><form class="panel" id="machine-form"><h3>Add equipment</h3><label class="form-label" for="m-name">Equipment name</label><input class="input" name="name" id="m-name" maxlength="80" required><div class="form-grid"><div><label class="form-label" for="m-area">Area / zone</label><input class="input" name="area" id="m-area" maxlength="80" required></div><div><label class="form-label" for="m-difficulty">Difficulty</label><select class="input" name="difficulty" id="m-difficulty"><option value="easy">Green · Easy · 25 XP</option><option value="medium">Yellow · Medium · 50 XP</option><option value="hard">Red · Hard · 75 XP</option></select></div></div><label class="form-label" for="m-description">Short description</label><input class="input" name="description" id="m-description" maxlength="300" required><label class="form-label" for="m-steps">Cleaning checklist · one step per line</label><textarea class="input" name="steps" id="m-steps" rows="6" placeholder="Enter 2–15 site-approved steps" required></textarea><p class="mini-note">The three general cleaning knowledge questions are included with each machine.</p><p class="error" role="alert"></p><div class="modal-actions"><button class="btn primary">Add machine +</button></div></form></div>`;}
function usersPanel(){return `<div class="admin-grid"><section class="panel"><h3>Active team members · ${activeUsers().length}</h3>${activeUsers().map(u=>`<div class="admin-list-item"><div>${esc(u.name)}<small>${earned(u.id)} verified XP</small></div><button class="btn small danger" data-action="delete-user" data-id="${u.id}">Remove</button></div>`).join('')}<p class="mini-note">Removed people disappear from the name picker. Their past records are retained.</p></section><form class="panel" id="user-form"><h3>Add a team member</h3><label class="form-label" for="u-name">Display name</label><input class="input" id="u-name" name="name" maxlength="60" required placeholder="e.g. Alex Morgan"><p class="mini-note">This person can select their name immediately. No employee password is created.</p><p class="error" role="alert"></p><div class="modal-actions"><button class="btn primary">Add team member +</button></div></form></div>`;}
function auditPanel(){return `<section class="panel"><h3>Server audit trail</h3><p class="mini-note">Latest 100 events · timestamps recorded by the server · admin actions use the shared admin identity.</p>${state.audit.map(a=>`<div class="admin-list-item"><div><strong>${esc(a.action)}</strong><small class="wrap">${esc(a.detail)}</small></div><small>${dateTime(a.at)}</small></div>`).join('') || '<div class="empty">No events yet.</div>'}</section>`;}
function settingsPanel(){return `<form class="panel login-panel" id="password-form"><h3>Change admin password</h3><label class="form-label" for="current-password">Current password</label><input class="input" id="current-password" name="current_password" type="password" autocomplete="current-password" required><label class="form-label" for="new-password">New password · at least 12 characters</label><input class="input" id="new-password" name="new_password" type="password" autocomplete="new-password" minlength="12" maxlength="200" required><p class="mini-note">Changing the password locks all admin sessions.</p><p class="error" role="alert"></p><div class="modal-actions"><button class="btn primary">Update password</button></div></form>`;}
function modal(title, subtitle, body){$('#modal-content').innerHTML=`<div class="modal-header"><div><div class="eyebrow">KANPAK CLEANSHIFT</div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="close" data-action="close" aria-label="Close dialog">×</button></div><div class="modal-body">${body}</div>`;if(!$('#modal').open) $('#modal').showModal();$('#modal').scrollTop=0;}
function openMachine(id){
  const m=state.machines.find(m=>m.id===id);if(!m) return;
  if(!person || allocation(id)?.user_id!==person){toast('Select your own name. You can start only tasks assigned to you.');return;}
  modal(m.name,`${m.area} · ${shift} shift · ${points[m.difficulty]} XP after verification`, `<div class="notice">Sample workflow for this demo. Use KanPak’s approved SOP for the actual cleaning method, settings, chemicals, isolation, and release requirements.</div><p class="muted">${esc(m.description)}</p><h3 class="subhead">Your cleaning checklist</h3><ol class="review-details">${m.steps.map(s=>`<li>${esc(s)}</li>`).join('')}</ol><form id="start-form" data-id="${id}"><label class="form-label" for="start-person">Who is doing this task?</label><select class="person-select" id="start-person" name="user_id" required>${userOptions(person)}</select><p class="mini-note">Starting records the server time and assigns this task to the selected person.</p><p class="error" role="alert"></p><div class="modal-actions"><button type="button" class="btn" data-action="close">Not now</button><button class="btn primary">Start checklist →</button></div></form>`);
}
function resume(id){
  const r=state.runs.find(r=>r.id===id);if(!r)return;
  if(r.status!=='in_progress')return record(id);
  modal(r.machine,`${r.person} · Started ${dateTime(r.started)} · ${r.shift} shift`, `<div class="notice">Demo checklist only. Follow the current site-approved procedure. Submission requests a supervisor review; it does not release equipment.</div><form id="task-form" data-id="${id}"><label class="form-label" for="task-person">Confirm your name</label><select class="person-select" id="task-person" name="user_id" required>${userOptions(person)}</select><h3 class="subhead">01 / Cleaning checklist</h3>${r.steps.map((s,i)=>`<label class="check-row"><input type="checkbox" name="step${i}" required><span><span class="step-number">${String(i+1).padStart(2,'0')}</span>${esc(s)}</span></label>`).join('')}<h3 class="subhead">02 / Quick knowledge check</h3>${state.questions.map((q,i)=>`<fieldset class="question"><legend>${i+1}. ${esc(q.q)}</legend>${q.options.map((o,j)=>`<label class="radio-row"><input type="radio" name="q${i}" value="${j}" required>${esc(o)}</label>`).join('')}</fieldset>`).join('')}<h3 class="subhead">03 / Leave a useful record</h3><label class="form-label" for="task-note">Cleaning record reference & observations</label><textarea class="input" id="task-note" name="note" maxlength="2000" required placeholder="e.g. Cleaning log reference, what you checked, and anything your supervisor should inspect."></textarea><p class="mini-note">The start time is saved. Checklist selections are kept in this tab until submitted.</p><p class="error" role="alert"></p><div class="modal-actions"><button class="btn" type="button" data-action="close">Continue later</button><button class="btn primary">Submit for verification →</button></div></form>`);
  const draft=JSON.parse(sessionStorage.getItem('draft-'+id)||'null');
  if(draft){const f=$('#task-form');r.steps.forEach((_,i)=>f.elements['step'+i].checked=!!draft.checks[i]);draft.answers.forEach((v,i)=>{if(v!==null && f.querySelector(`[name="q${i}"][value="${v}"]`))f.querySelector(`[name="q${i}"][value="${v}"]`).checked=true;});f.elements.note.value=draft.note || '';}
}
function record(id){
  const r=state.runs.find(r=>r.id===id);if(!r)return;
  modal(r.machine,`CS-${String(r.id).padStart(4,'0')} · ${r.work_day} · ${r.shift} shift`, `${badge(r.status)}${[['Team member',r.person],['Started',dateTime(r.started)],['Submitted',dateTime(r.submitted)],['Reviewed',dateTime(r.reviewed)],['Awarded XP',r.status==='verified'?r.points:0]].map(([k,v])=>`<div class="detail-pair"><span>${k}</span><strong>${esc(v)}</strong></div>`).join('')}<h3 class="subhead">Cleaning notes & reference</h3><div class="review-note">${esc(r.note || 'Not submitted yet.')}</div>${r.review_note?`<h3 class="subhead">Supervisor note</h3><div class="review-note">${esc(r.review_note)}</div>`:''}<details class="review-details"><summary>Checklist & knowledge answers</summary>${runEvidence(r)}</details><div class="modal-actions"><button class="btn primary" data-action="close">Done</button></div>`);
}
function openReview(id, decision){const r=state.runs.find(r=>r.id===id);modal(decision==='verified'?'Verify completed work':'Return for rework', `${r.machine} · ${r.person}`, `<form id="review-form" data-id="${id}" data-decision="${decision}"><div class="notice green">${decision==='verified'?`Confirm you have checked the work and its supporting record. This will award ${r.points} XP.`:'Explain what needs attention. The original record will remain and the task can be started again.'}</div><label class="form-label" for="review-note">${decision==='verified'?'Verification evidence / inspection note':'Reason and next steps'}</label><textarea class="input" id="review-note" name="review_note" required maxlength="2000"></textarea><p class="error" role="alert"></p><div class="modal-actions"><button class="btn" type="button" data-action="close">Cancel</button><button class="btn ${decision==='verified'?'primary':'danger'}">${decision==='verified'?'Confirm verification':'Return task'}</button></div></form>`);}
function confirmDelete(type,id){const item=(type==='machine'?state.machines:state.users).find(x=>x.id===id);modal(type==='machine'?'Delete machine?':'Remove team member?', item.name, `<form id="delete-form" data-type="${type}" data-id="${id}"><p>This removes ${esc(item.name)} from active selections. Existing task history will be preserved.</p><p class="error" role="alert"></p><div class="modal-actions"><button class="btn" type="button" data-action="close">Cancel</button><button class="btn danger">Confirm removal</button></div></form>`);}
document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.view){view=b.dataset.view;render();return;}
  if(b.dataset.filter){filter=b.dataset.filter;render();return;}
  if(b.dataset.adminTab){adminTab=b.dataset.adminTab;render();return;}
  const id=Number(b.dataset.id);
  try{switch(b.dataset.action){
    case 'roster':view='admin';adminTab='roster';render();break;
    case 'my-work':person=id;sessionStorage.setItem('person',person);filter='mine';render();break;
    case 'close':$('#modal').close();break;
    case 'refresh':await refresh(true);break;
    case 'machine':openMachine(id);break;
    case 'resume':resume(id);break;
    case 'record':record(id);break;
    case 'review':openReview(id,b.dataset.decision);break;
    case 'delete-machine':confirmDelete('machine',id);break;
    case 'delete-user':confirmDelete('user',id);break;
    case 'logout':await api('/api/logout',{});await refresh(true);toast('Admin workspace locked.');break;
    case 'clear-records':recordStatus='all';recordDate='';recordSearch='';render();break;
  }}catch(err){toast(err.message);}
});
document.addEventListener('input',e=>{
  if(e.target.id==='machine-search'){search=e.target.value;$('#machine-grid').innerHTML=machineCards();}
  if(e.target.id==='record-search'){recordSearch=e.target.value;$('#records-table').innerHTML=recordTable();}
  const f=e.target.closest('#task-form');
  if(f){const r=state.runs.find(r=>r.id===Number(f.dataset.id));sessionStorage.setItem('draft-'+r.id,JSON.stringify({checks:r.steps.map((_,i)=>f.elements['step'+i].checked),answers:state.questions.map((_,i)=>{const v=f.querySelector(`[name="q${i}"]:checked`);return v?Number(v.value):null;}),note:f.elements.note.value}));}
});
document.addEventListener('change',e=>{
  if(e.target.id==='person'){person=Number(e.target.value);sessionStorage.setItem('person',person);filter=person?'mine':'all';render();}
  if(e.target.id==='shift'){shift=e.target.value;sessionStorage.setItem('shift',shift);render();}
  if(e.target.id==='record-status'){recordStatus=e.target.value;$('#records-table').innerHTML=recordTable();}
  if(e.target.id==='record-date'){recordDate=e.target.value;$('#records-table').innerHTML=recordTable();}
});
document.addEventListener('submit',async e=>{
  e.preventDefault();const f=e.target, button=e.submitter;const data=Object.fromEntries(new FormData(f));
  const error=f.querySelector('.error');if(error)error.textContent='';if(button)button.disabled=true;
  try{
    let message='Saved successfully.';
    if(f.classList.contains('roster-form')){await api('/api/admin/roster',{shift:f.dataset.shift,user_ids:new FormData(f).getAll('user').map(Number)});message='Shift crew saved. Unstarted tasks balanced.';}
    else if(f.id==='login-form'){await api('/api/login',data);message='Admin workspace unlocked.';}
    else if(f.id==='start-form'){
      const result=await api('/api/start',{machine_id:Number(f.dataset.id),user_id:Number(data.user_id),shift});
      person=Number(data.user_id);sessionStorage.setItem('person',person);await refresh(true);resume(result.id);return;
    }else if(f.id==='task-form'){
      const r=state.runs.find(r=>r.id===Number(f.dataset.id));
      const answers=state.questions.map((_,i)=>Number(data['q'+i]));
      const wrong=state.questions.findIndex((q,i)=>q.answer!==answers[i]);
      if(wrong>=0)throw new Error(`Question ${wrong+1}: ${state.questions[wrong].options[state.questions[wrong].answer]}. Review your answer and try again.`);
      await api('/api/submit',{id:r.id,user_id:Number(data.user_id),checks:r.steps.map((_,i)=>!!data['step'+i]),answers,note:data.note});
      sessionStorage.removeItem('draft-'+r.id);message='Submitted! Your supervisor can now verify the work.';
    }else if(f.id==='review-form'){await api('/api/admin/review',{id:Number(f.dataset.id),decision:f.dataset.decision,review_note:data.review_note});message=f.dataset.decision==='verified'?'Work verified. XP awarded!':'Task returned with your feedback.';}
    else if(f.id==='machine-form'){await api('/api/admin/machine',{...data,steps:data.steps.split('\n').map(s=>s.trim()).filter(Boolean)});message='Machine added to the cleaning board.';}
    else if(f.id==='user-form'){await api('/api/admin/user',data);message='Team member added.';}
    else if(f.id==='delete-form'){await api('/api/admin/'+f.dataset.type+'-delete',{id:Number(f.dataset.id)});message='Removed from active selections. History preserved.';}
    else if(f.id==='password-form'){await api('/api/admin/password',data);message='Password changed. Unlock admin with your new password.';}
    else return;
    if($('#modal').open)$('#modal').close();await refresh(true);toast(message);
  }catch(err){if(error)error.textContent=err.message;else toast(err.message);}
  finally{if(button)button.disabled=false;}
});
$('#modal').addEventListener('click',e=>{if(e.target===$('#modal')){const r=$('#modal').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('#modal').close();}});
refresh(true);setInterval(()=>refresh(false),5000);
