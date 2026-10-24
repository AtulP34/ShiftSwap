(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const ICON = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const STORAGE = 'shiftswap-editorial-demo-v1';
  const WEEK0 = '2026-10-19';
  const PEOPLE = [
    {name:'Aditya P.',role:'Front counter',initials:'AP',tone:''},
    {name:'Jordan Lee',role:'Front desk',initials:'JL',tone:'a2'},
    {name:'Kiran Patel',role:'Customer care',initials:'KP',tone:'a3'},
    {name:'Ayesha Khan',role:'Service desk',initials:'AK',tone:'a4'},
    {name:'Maya Chen',role:'Store manager',initials:'MC',tone:'a5',manager:true}
  ];
  const DEFAULT = {
    shifts:[
      {id:'s1',date:'2026-10-19',start:9,end:14,title:'Morning shift',person:'Kiran Patel'},
      {id:'s2',date:'2026-10-20',start:12,end:18,title:'Front desk',person:'Jordan Lee'},
      {id:'s3',date:'2026-10-21',start:10,end:16,title:'Customer service',person:'Ayesha Khan'},
      {id:'s4',date:'2026-10-22',start:14,end:20,title:'Closing shift',person:'Jordan Lee'},
      {id:'s5',date:'2026-10-23',start:9,end:15,title:'Opening shift',person:'Kiran Patel'},
      {id:'s6',date:'2026-10-24',start:12,end:18,title:'Afternoon shift',person:'Aditya P.'},
      {id:'s7',date:'2026-10-25',start:10,end:16,title:'Weekend shift',person:'Aditya P.'},
      {id:'s8',date:'2026-10-25',start:14,end:19,title:'Closing shift',person:'Ayesha Khan'}
    ],
    requests:[
      {id:'r1',kind:'coverage',shiftTitle:'Midday shift',date:'2026-10-27',from:'Jordan Lee',to:'Aditya P.',direction:'received',status:'awaiting_coworker',created:'Today'},
      {id:'r2',kind:'coverage',shiftTitle:'Afternoon shift',date:'2026-10-24',from:'Aditya P.',to:'Jordan Lee',direction:'sent',status:'awaiting_coworker',created:'Today'}
    ],
    decisions:[
      {id:'d1',kind:'coverage',shiftId:'s7',title:'Weekend shift',date:'2026-10-25',from:'Aditya P.',to:'Jordan Lee',status:'pending'},
      {id:'d2',kind:'swap',shiftId:'s4',title:'Closing shift',date:'2026-10-22',from:'Jordan Lee',to:'Kiran Patel',status:'pending'}
    ],
    availability:[
      {on:true,start:9,end:17},{on:true,start:9,end:17},{on:true,start:9,end:17},
      {on:true,start:9,end:17},{on:true,start:9,end:17},
      {on:false,start:9,end:17},{on:false,start:9,end:17}
    ],
    exceptions:[{id:'e1',date:'2026-10-28',start:9,end:18,kind:'unavailable'}],unread:true
  };
  const clone = x => JSON.parse(JSON.stringify(x));
  let state = clone(DEFAULT);
  try { const restored=JSON.parse(localStorage.getItem(STORAGE));if(restored&&Array.isArray(restored.shifts)&&Array.isArray(restored.requests)&&Array.isArray(restored.availability))state={...clone(DEFAULT),...restored}; } catch(e) {}
  const save=()=>{try{localStorage.setItem(STORAGE,JSON.stringify(state));}catch(e){}};
  let availableDraft=clone(state.availability),exceptionsDraft=clone(state.exceptions);
  let activePage='schedule',activeTab='received',scheduleFilter='all',shownWeek=WEEK0,selectedDay='2026-10-24',selectedShift=null,toastTimer=null,undoAction=null,noticeTimer=null,commandIndex=0,commands=[];
  let theme='system';try{theme=localStorage.getItem('shiftswap-editorial-theme')||'system'}catch(e){}
  const parseDate=s=>new Date(s+'T12:00:00');
  const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const addDays=(s,n)=>{const d=parseDate(s);d.setDate(d.getDate()+n);return iso(d)};
  const weekOf=s=>addDays(s,-(parseDate(s).getDay()+6)%7);
  const dayName=s=>parseDate(s).toLocaleDateString('en-US',{weekday:'short'});
  const longDay=s=>parseDate(s).toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric',year:'numeric'});
  const shortDay=s=>parseDate(s).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
  const time=h=>{const hours=Math.floor(h),mins=Math.round((h-hours)*60),suffix=hours>=12?'PM':'AM';return `${hours%12||12}:${String(mins).padStart(2,'0')} ${suffix}`};
  const shortTime=h=>{const a=time(h);return a.replace(':00','')};
  const span=(a,b)=>`${shortTime(a)} – ${shortTime(b)}`;
  const describeStatus=s=>({awaiting_coworker:'Waiting for coworker',awaiting_manager:'Waiting for manager',approved:'Approved',declined:'Declined',canceled:'Canceled',accepted:'Accepted',pending:'Pending'})[s]||s;
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const initials=name=>(PEOPLE.find(p=>p.name===name)||{initials:name.trim().split(' ').map(v=>v[0]).slice(0,2).join('')}).initials;
  const avatar=name=>{const p=PEOPLE.find(x=>x.name===name);return `<span class="avatar ${p?.tone||''}" aria-hidden="true">${esc(initials(name))}</span>`};
  const today=()=>iso(new Date());
  const formatRange=start=>{const end=addDays(start,6),d=parseDate(start),e=parseDate(end);const sm=d.toLocaleDateString('en-US',{month:'short'}),em=e.toLocaleDateString('en-US',{month:'short'});return `${sm} ${d.getDate()} – ${d.getMonth()===e.getMonth()?'':em+' '}${e.getDate()}, ${e.getFullYear()}`};
  function renderNavigation(){
    document.querySelectorAll('[data-nav]').forEach(a=>{const active=a.dataset.nav===activePage;a.classList.toggle('active',active);active?a.setAttribute('aria-current','page'):a.removeAttribute('aria-current')});
    $('requestNavCount').textContent=state.requests.filter(r=>r.direction==='received'&&r.status==='awaiting_coworker').length||'';
    $('managerNavCount').textContent=state.decisions.filter(d=>d.status==='pending').length||'';
    $('unreadDot').hidden=!state.unread;
  }
  function navigate(page,force=false){
    if(!['schedule','requests','availability','manager'].includes(page))page='schedule';
    if(activePage==='availability'&&page!=='availability'&&isDirty()&&!force){if(!confirm('Leave Availability without saving your changes?')){location.hash='#availability';return;} resetDraft();}
    activePage=page;
    document.querySelectorAll('.page').forEach(el=>{el.hidden=el.id!=='page-'+page});
    renderNavigation();closeMobile();
    if(page==='schedule')renderSchedule();if(page==='requests')renderRequests();if(page==='availability')renderAvailability();if(page==='manager')renderManager();
    document.title=`${{schedule:'Team schedule',requests:'Requests',availability:'Availability',manager:'Manager'}[page]} · ShiftSwap`;
  }
  const route=()=>navigate(location.hash.slice(1)||'schedule');
  window.addEventListener('hashchange',route);
  function closeMobile(){$('sidebar').classList.remove('is-open');$('mobileShade').hidden=true;$('mobileMenuButton').setAttribute('aria-expanded','false')}
  $('mobileMenuButton').onclick=()=>{const open=$('sidebar').classList.toggle('is-open');$('mobileShade').hidden=!open;$('mobileMenuButton').setAttribute('aria-expanded',String(open))};
  $('mobileShade').onclick=closeMobile;
  $('workspaceButton').onclick=()=>toast('This preview has one sample workspace.');
  function showToast(message,undo){clearTimeout(toastTimer);$('toastText').textContent=message;$('toast').hidden=false;undoAction=undo||null;$('toastUndo').hidden=!undo;toastTimer=setTimeout(hideToast,5000)}
  const toast=message=>showToast(message,null);
  function hideToast(){$('toast').hidden=true;undoAction=null}
  $('toastUndo').onclick=()=>{if(undoAction){const fn=undoAction;hideToast();fn();toast('Change undone.')}};
  function undoable(message,fn){const before=clone(state);fn();save();renderAll();showToast(message,()=>{state=before;save();renderAll()})}
  const openDialog=(id)=>{const el=$(id);if(!el.open)el.showModal()};
  const closeDialog=id=>{if($(id).open)$(id).close()};
  document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>closeDialog(b.dataset.close)));
  document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d)d.close()}));
  function renderAll(){renderNavigation();if(activePage==='schedule')renderSchedule();if(activePage==='requests')renderRequests();if(activePage==='availability')renderAvailability();if(activePage==='manager')renderManager()}
  function renderSchedule(){
    $('weekLabel').textContent=formatRange(shownWeek);
    const inWeek=state.shifts.filter(s=>weekOf(s.date)===shownWeek);
    const mine=inWeek.filter(s=>s.person==='Aditya P.');
    const hours=mine.reduce((sum,s)=>sum+s.end-s.start,0);
    $('scheduleOverview').textContent=`${mine.length} shift${mine.length===1?'':'s'} · ${Math.round(hours*4)/4} hour${hours===1?'':'s'}`;
    document.querySelectorAll('[data-schedule-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.scheduleFilter===scheduleFilter)));
    const filtered=inWeek.filter(s=>scheduleFilter==='all'||s.person==='Aditya P.');
    const visibleDay=date=>filtered.filter(s=>s.date===date);
    const cal=$('calendar');cal.replaceChildren();
    let corner=document.createElement('div');corner.className='calendar-corner';cal.append(corner);
    for(let i=0;i<7;i++){
      const date=addDays(shownWeek,i),head=document.createElement('div');head.className='day-head';head.style.gridColumn=String(i+2);
      head.innerHTML=`<span>${dayName(date)}</span><span class="date-number numeric ${date===today()?'today':''}">${parseDate(date).getDate()}</span>`;
      cal.append(head);
    }
    const axis=document.createElement('div');axis.className='time-axis';
    for(let h=8;h<=21;h++){const mark=document.createElement('span');mark.className='time-mark numeric'+(h===8?' first':'');mark.textContent=shortTime(h);mark.style.top=`${(h-8)*56}px`;axis.append(mark)}
    cal.append(axis);
    for(let day=0;day<7;day++){
      const date=addDays(shownWeek,day),column=document.createElement('div');column.className='cal-day'+(date===today()?' today-col':'');column.style.gridColumn=String(day+2);
      for(let h=0;h<=13;h++){const line=document.createElement('div');line.className='hour-grid-line';line.style.top=`${h*56}px`;line.setAttribute('aria-hidden','true');column.append(line)}
      const records=visibleDay(date).sort((a,b)=>a.start-b.start||a.end-b.end);
      const groups=[];
      records.forEach(s=>{let group=groups.find(g=>g.some(t=>s.start<t.end&&t.start<s.end));if(!group){group=[];groups.push(group)}group.push(s)});
      groups.forEach(group=>{
        const lanes=[];
        group.forEach(s=>{let lane=lanes.findIndex(t=>t<=s.start);if(lane<0){lane=lanes.length;lanes.push(s.end)}else lanes[lane]=s.end;s.lane=lane});
        group.forEach(s=>{
          const button=document.createElement('button'),mine=s.person==='Aditya P.',open=isCoverageOpen(s.id);
          button.className='shift-block'+(mine?' mine':'')+(open?' open':'');button.type='button';
          button.style.top=`${(s.start-8)*56+2}px`;button.style.height=`${(s.end-s.start)*56-4}px`;
          button.style.width=`calc(${100/lanes.length}% - 4px)`;button.style.left=`calc(${s.lane*100/lanes.length}% + 2px)`;
          button.title=`${s.title} · ${span(s.start,s.end)} · ${s.person}`;
          button.setAttribute('aria-label',button.title+'. View details');
          button.innerHTML=`<span class="shift-title">${esc(s.title)}</span><span class="shift-meta">${esc(span(s.start,s.end))} · ${esc(s.person)}</span>`;
          button.onclick=()=>openShift(s.id);column.append(button);
        });
      });
      const now=new Date();const h=now.getHours()+now.getMinutes()/60;
      if(date===today()&&h>=8&&h<=21){const line=document.createElement('div');line.className='now-line';line.style.top=`${(h-8)*56}px`;line.setAttribute('aria-hidden','true');column.append(line)}
      cal.append(column);
    }
    if(weekOf(selectedDay)!==shownWeek)selectedDay=shownWeek;
    renderAgenda(filtered);
  }
  function isCoverageOpen(id){return state.requests.some(r=>r.shiftId===id&&r.status==='awaiting_coworker')}
  function renderAgenda(shifts){
    $('dateStrip').innerHTML=Array.from({length:7},(_,i)=>{const date=addDays(shownWeek,i);return `<button type="button" class="date-choice numeric" data-agenda-date="${date}" aria-pressed="${date===selectedDay}"><span>${dayName(date)}</span><strong>${parseDate(date).getDate()}</strong></button>`}).join('');
    $('dateStrip').querySelectorAll('[data-agenda-date]').forEach(b=>b.onclick=()=>{selectedDay=b.dataset.agendaDate;renderAgenda(shifts)});
    const dayShifts=shifts.filter(s=>s.date===selectedDay).sort((a,b)=>a.start-b.start);
    $('agendaEntries').innerHTML=dayShifts.length?dayShifts.map(s=>`<button class="agenda-shift" data-open-shift="${esc(s.id)}"><span class="agenda-time numeric">${esc(shortTime(s.start))}</span><span class="agenda-info"><strong>${esc(s.title)}</strong><small>${esc(span(s.start,s.end))} · ${esc(s.person)}</small></span></button>`).join(''):`<div class="empty agenda-empty">No shifts on ${dayName(selectedDay)}.</div>`;
    $('agendaEntries').querySelectorAll('[data-open-shift]').forEach(b=>b.onclick=()=>openShift(b.dataset.openShift));
  }
  function openShift(id){const s=state.shifts.find(s=>s.id===id);if(!s)return;selectedShift=id;
    $('sheetTitle').textContent=s.title;$('sheetDate').textContent=longDay(s.date);$('sheetTime').textContent=span(s.start,s.end);$('sheetPerson').textContent=s.person;$('sheetStatus').textContent=isCoverageOpen(id)?'Coverage requested':'Scheduled';
    $('requestCoverageFromSheet').disabled=s.person!=='Aditya P.';$('requestCoverageFromSheet').title=s.person!=='Aditya P.'?'Coverage requests can only be made for your shifts':'';
    openDialog('shiftSheet');
  }
  $('requestCoverageFromSheet').onclick=()=>{const id=selectedShift;closeDialog('shiftSheet');openRequestDialog(id)};
  $('weekPrev').onclick=()=>{shownWeek=addDays(shownWeek,-7);selectedDay=shownWeek;renderSchedule()};
  $('weekNext').onclick=()=>{shownWeek=addDays(shownWeek,7);selectedDay=shownWeek;renderSchedule()};
  $('todayButton').onclick=()=>{shownWeek=weekOf(today());selectedDay=today();renderSchedule()};
  document.querySelectorAll('[data-schedule-filter]').forEach(b=>b.onclick=()=>{scheduleFilter=b.dataset.scheduleFilter;renderSchedule()});
  function statusStyle(s){return s==='approved'||s==='accepted'?'approved':s==='declined'||s==='canceled'?'declined':'pending'}
  function requestTitle(r){return r.kind==='swap'?'Shift swap':'Shift coverage'}
  function tabsData(){return {received:state.requests.filter(r=>r.direction==='received'&&r.status==='awaiting_coworker'),sent:state.requests.filter(r=>r.direction==='sent'&&r.status.startsWith('awaiting_')),history:state.requests.filter(r=>!r.status.startsWith('awaiting_'))}}
  function renderRequests(){
    const tabs=tabsData();
    Object.keys(tabs).forEach(k=>{$(k+'Count').textContent=tabs[k].length});
    document.querySelectorAll('[data-tab]').forEach(b=>{const chosen=b.dataset.tab===activeTab;b.setAttribute('aria-selected',String(chosen));b.tabIndex=chosen?0:-1});
    $('requestsList').setAttribute('aria-labelledby',activeTab+'Tab');
    const list=tabs[activeTab];
    if(!list.length){$('requestsList').innerHTML=`<div class="empty">${ICON('inbox')}<span>${{received:'No requests to review.',sent:'You have no outgoing requests.',history:'No completed requests yet.'}[activeTab]}</span></div>`;return}
    $('requestsList').innerHTML=list.map(r=>{
      const pending=r.status.startsWith('awaiting_');
      const subtitle=`${esc(r.shiftTitle)} · ${esc(shortDay(r.date))}`;
      const line=activeTab==='received'?`${esc(r.from)} → you · ${esc(r.created)}`:activeTab==='sent'?`You → ${esc(r.to)} · ${esc(r.created)}`:`${esc(r.from)} → ${esc(r.to)} · ${esc(r.created)}`;
      return `<div class="request-row"><div class="request-main"><span class="status-dot ${statusStyle(r.status)}"></span><div><strong>${requestTitle(r)}</strong><p>${subtitle}</p><small>${line}</small></div></div><span class="tag ${statusStyle(r.status)}">${esc(describeStatus(r.status))}</span>${activeTab==='received'&&pending?`<div class="row-actions"><button type="button" class="button ghost small" data-request-action="decline" data-id="${esc(r.id)}">Decline</button><button type="button" class="button small sm-primary" data-request-action="accept" data-id="${esc(r.id)}">Accept</button></div>`:activeTab==='sent'&&pending?`<div class="row-actions"><button type="button" class="button ghost small" data-request-action="cancel" data-id="${esc(r.id)}">Cancel</button></div>`:''}</div>`
    }).join('');
    $('requestsList').querySelectorAll('[data-request-action]').forEach(b=>b.onclick=()=>{
      const id=b.dataset.id,action=b.dataset.requestAction;
      undoable(action==='accept'?'Request accepted.':action==='decline'?'Request declined.':'Request canceled.',()=>{const r=state.requests.find(t=>t.id===id);r.status=action==='accept'?'accepted':action==='decline'?'declined':'canceled';});
    });
  }
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{activeTab=b.dataset.tab;renderRequests()});
  $('requestTabs').addEventListener('keydown',e=>{if(!['ArrowRight','ArrowLeft','Home','End'].includes(e.key))return;e.preventDefault();const arr=[...document.querySelectorAll('[data-tab]')],i=arr.findIndex(b=>b.dataset.tab===activeTab);let j=e.key==='Home'?0:e.key==='End'?arr.length-1:(i+(e.key==='ArrowRight'?1:-1)+arr.length)%arr.length;activeTab=arr[j].dataset.tab;renderRequests();arr[j].focus()});
  function openRequestDialog(preselect){
    $('requestForm').reset();$('requestFormError').hidden=true;
    const mine=state.shifts.filter(s=>s.person==='Aditya P.').sort((a,b)=>a.date.localeCompare(b.date));
    $('requestShift').innerHTML=mine.map(s=>`<option value="${esc(s.id)}">${esc(s.title)} · ${esc(shortDay(s.date))}</option>`).join('');
    if(preselect&&mine.some(s=>s.id===preselect))$('requestShift').value=preselect;
    $('requestForm').querySelector('[type=submit]').disabled=!mine.length;
    if(!mine.length){$('requestFormError').textContent='You have no shifts to request coverage for.';$('requestFormError').hidden=false}
    openDialog('requestDialog');
  }
  $('newRequestButton').onclick=()=>openRequestDialog();
  $('requestForm').onsubmit=e=>{e.preventDefault();const shift=state.shifts.find(s=>s.id===$('requestShift').value);if(!shift)return;
    const teammate=$('requestTeammate').value;
    if(teammate===shift.person){$('requestFormError').hidden=false;$('requestFormError').textContent='Choose a different team member.';return}
    undoable('Request added to Sent.',()=>state.requests.unshift({id:'r'+Date.now(),kind:$('requestKind').value,shiftId:shift.id,shiftTitle:shift.title,date:shift.date,from:'Aditya P.',to:teammate,direction:'sent',status:'awaiting_coworker',created:'Just now'}));
    closeDialog('requestDialog');activeTab='sent';location.hash='#requests';renderRequests();
  };
  function renderManager(){
    const pending=state.decisions.filter(d=>d.status==='pending');$('managerCount').textContent=pending.length;
    $('managerDecisions').innerHTML=pending.length?pending.map(d=>`<div class="decision-row"><div class="decision-main"><div class="decision-top"><strong>${d.kind==='swap'?'Shift swap':'Coverage request'}</strong><span class="tag plain">${d.kind==='swap'?'Swap':'Coverage'}</span></div><p>${esc(d.title)} · ${esc(shortDay(d.date))}</p><small class="decision-meta"><span class="tiny-avatars">${avatar(d.from)}${avatar(d.to)}</span>${esc(d.from)} → ${esc(d.to)}</small></div><div class="row-actions"><button class="button secondary small" data-decision="reject" data-id="${esc(d.id)}">Reject</button><button class="button approve-button small" data-decision="approve" data-id="${esc(d.id)}">Approve</button></div></div>`).join(''):`<div class="empty">${ICON('check')}<span>No approvals are waiting.</span></div>`;
    $('managerDecisions').querySelectorAll('[data-decision]').forEach(b=>b.onclick=()=>{
      const id=b.dataset.id,action=b.dataset.decision;
      undoable(action==='approve'?'Request approved.':'Request rejected.',()=>{
        const d=state.decisions.find(x=>x.id===id);d.status=action==='approve'?'approved':'declined';
        if(action==='approve'&&d.kind==='coverage'){const s=state.shifts.find(x=>x.id===d.shiftId);if(s)s.person=d.to}
      });
    });
    $('peopleList').innerHTML=PEOPLE.map(p=>`<div class="person-row">${avatar(p.name)}<div class="person-text"><strong>${esc(p.name)}</strong><small>${esc(p.role)}</small></div>${p.manager?'<span class="tag plain">Manager</span>':''}</div>`).join('');
  }
  $('addShiftButton').onclick=()=>{const form=$('addShiftForm');form.reset();$('addShiftError').hidden=true;$('addShiftDate').value=selectedDay;$('addShiftPerson').innerHTML=PEOPLE.map(p=>`<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');$('addShiftStart').value='9';$('addShiftEnd').value='17';openDialog('addShiftDialog')};
  $('addShiftForm').onsubmit=e=>{e.preventDefault();const start=+$('addShiftStart').value,end=+$('addShiftEnd').value;if(end<=start){$('addShiftError').textContent='End time must be after start time.';$('addShiftError').hidden=false;return}
    const date=$('addShiftDate').value;if(!date){$('addShiftError').textContent='Choose a date.';$('addShiftError').hidden=false;return}
    undoable('Shift added to the schedule.',()=>state.shifts.push({id:'s'+Date.now(),date,start,end,title:$('addShiftTitle').value.trim(),person:$('addShiftPerson').value}));
    closeDialog('addShiftDialog');shownWeek=weekOf(date);selectedDay=date;location.hash='#schedule';renderSchedule();
  };
  function resetDraft(){availableDraft=clone(state.availability);exceptionsDraft=clone(state.exceptions);setDirty(false)}
  function isDirty(){return JSON.stringify(availableDraft)!==JSON.stringify(state.availability)||JSON.stringify(exceptionsDraft)!==JSON.stringify(state.exceptions)}
  function setDirty(dirty){$('dirtyNotice').hidden=!dirty;$('saveAvailability').disabled=!dirty}
  const DAYS=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  function optionTimes(){let html='';for(let h=0;h<24;h+=.25){html+=`<option value="${h}">${time(h)}</option>`}html+='<option value="24">12:00 AM (next day)</option>';return html}
  const OPTIONS=optionTimes();
  ['exceptionStart','exceptionEnd','addShiftStart','addShiftEnd'].forEach(id=>{$(id).innerHTML=OPTIONS});
  function renderAvailability(){renderWeekly();renderExceptions();setDirty(isDirty())}
  function renderWeekly(){
    $('weeklyRows').innerHTML=availableDraft.map((row,i)=>`<div class="weekly-row ${row.on?'':'off'}" data-weekday="${i}"><span class="weekday">${DAYS[i]}</span><div class="time-container">${row.on?`<button type="button" class="hours-button" data-edit="${i}" aria-label="Edit ${DAYS[i]} hours">${esc(span(row.start,row.end))}</button><div class="hours-inputs" hidden><select aria-label="${DAYS[i]} start time" data-start="${i}">${OPTIONS}</select><span>–</span><select aria-label="${DAYS[i]} end time" data-end="${i}">${OPTIONS}</select></div>`:'<span class="muted">Unavailable</span>'}</div><button type="button" class="switch" role="switch" aria-label="${DAYS[i]} availability" aria-checked="${row.on}" data-toggle="${i}"><span class="thumb"></span></button></div>`).join('');
    $('weeklyRows').querySelectorAll('[data-toggle]').forEach(b=>b.onclick=()=>{const i=+b.dataset.toggle;availableDraft[i].on=!availableDraft[i].on;renderWeekly();setDirty(isDirty())});
    $('weeklyRows').querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{const i=+b.dataset.edit,par=b.parentElement;par.querySelector('.hours-button').hidden=true;const edit=par.querySelector('.hours-inputs');edit.hidden=false;const start=edit.querySelector('[data-start]'),end=edit.querySelector('[data-end]');start.value=String(availableDraft[i].start);end.value=String(availableDraft[i].end);start.focus();});
    $('weeklyRows').querySelectorAll('[data-start],[data-end]').forEach(s=>s.onchange=()=>{const i=+(s.dataset.start??s.dataset.end),par=s.closest('.hours-inputs'),start=+par.querySelector('[data-start]').value,end=+par.querySelector('[data-end]').value;if(end<=start){toast('End time must be after the start time.');s.value=String(availableDraft[i][s.dataset.start!==undefined?'start':'end']);return}availableDraft[i].start=start;availableDraft[i].end=end;setDirty(isDirty());par.parentElement.querySelector('.hours-button').textContent=span(start,end)});
    $('weeklyRows').querySelectorAll('.hours-inputs').forEach(el=>el.addEventListener('focusout',e=>{if(el.contains(e.relatedTarget))return;setTimeout(()=>{if(!el.contains(document.activeElement)){el.hidden=true;el.parentElement.querySelector('.hours-button').hidden=false}},80)}));
  }
  function renderExceptions(){
    $('exceptionRows').innerHTML=exceptionsDraft.length?exceptionsDraft.map(e=>{const d=parseDate(e.date);return `<div class="exception-row"><span class="date-chip numeric"><small>${d.toLocaleDateString('en-US',{month:'short'}).toUpperCase()}</small><strong>${d.getDate()}</strong></span><div class="exception-detail"><strong>${esc(shortDay(e.date))}</strong><small>${esc(span(e.start,e.end))} · ${e.kind==='unavailable'?'Unavailable':'Available'}</small></div><span class="tag ${e.kind==='unavailable'?'declined':'approved'}">${e.kind==='unavailable'?'Unavailable':'Available'}</span><button class="icon-button exception-remove" data-remove-exception="${esc(e.id)}" type="button" aria-label="Remove override for ${esc(shortDay(e.date))}">${ICON('x')}</button></div>`}).join(''):`<div class="empty">${ICON('calendar')}<span>No date overrides added.</span></div>`;
    $('exceptionRows').querySelectorAll('[data-remove-exception]').forEach(b=>b.onclick=()=>{exceptionsDraft=exceptionsDraft.filter(x=>x.id!==b.dataset.removeException);renderExceptions();setDirty(isDirty())});
  }
  $('copyMonday').onclick=()=>{for(let i=1;i<5;i++)availableDraft[i]=clone(availableDraft[0]);renderWeekly();setDirty(isDirty());toast('Monday hours copied to weekdays.')};
  $('saveAvailability').onclick=()=>{if(!isDirty())return;for(const [i,r] of availableDraft.entries()){if(r.on&&r.end<=r.start){toast(`${DAYS[i]} has an invalid time range.`);return}}state.availability=clone(availableDraft);state.exceptions=clone(exceptionsDraft);save();setDirty(false);toast('Availability saved on this device.')};
  $('addExceptionButton').onclick=()=>{$('exceptionForm').reset();$('exceptionDate').value='2026-10-28';$('exceptionStart').value='9';$('exceptionEnd').value='18';$('exceptionFormError').hidden=true;openDialog('exceptionDialog')};
  $('exceptionForm').onsubmit=e=>{e.preventDefault();const start=+$('exceptionStart').value,end=+$('exceptionEnd').value;if(end<=start){$('exceptionFormError').textContent='End time must be after start time.';$('exceptionFormError').hidden=false;return}const date=$('exceptionDate').value;if(!date)return;
    exceptionsDraft.push({id:'e'+Date.now(),date,kind:$('exceptionKind').value,start,end});renderExceptions();setDirty(isDirty());closeDialog('exceptionDialog');toast('Override added. Save your changes.');
  };
  function applyTheme(){if(theme==='system')document.documentElement.removeAttribute('data-theme');else document.documentElement.dataset.theme=theme;$('themeName').textContent=theme[0].toUpperCase()+theme.slice(1)}
  applyTheme();
  $('profileButton').onclick=()=>{const shown=$('userMenu').hidden;$('userMenu').hidden=!shown;$('profileButton').setAttribute('aria-expanded',String(shown))};
  $('themeButton').onclick=()=>{theme=theme==='system'?'light':theme==='light'?'dark':'system';try{localStorage.setItem('shiftswap-editorial-theme',theme)}catch(e){}applyTheme()};
  $('signoutButton').onclick=()=>{$('userMenu').hidden=true;openDialog('signoutDialog')};
  $('resetDemoButton').onclick=()=>{state=clone(DEFAULT);save();resetDraft();closeDialog('signoutDialog');shownWeek=WEEK0;selectedDay='2026-10-24';activeTab='received';renderAll();location.hash='#schedule';toast('Example data reset.')};
  $('notificationButton').onclick=()=>{const show=$('notificationMenu').hidden;$('notificationMenu').hidden=!show;$('notificationButton').setAttribute('aria-expanded',String(show))};
  $('markReadButton').onclick=()=>{state.unread=false;save();renderNavigation();$('notificationMenu').hidden=true;toast('Notification marked as read.')};
  const commandDefs=[
    {label:'Team schedule',hint:'G S',run:()=>location.hash='#schedule'},
    {label:'Requests',hint:'G R',run:()=>location.hash='#requests'},
    {label:'Availability',hint:'G A',run:()=>location.hash='#availability'},
    {label:'Manager',hint:'G M',run:()=>location.hash='#manager'},
    {label:'New request',hint:'',run:()=>{location.hash='#requests';openRequestDialog()}},
    {label:'Add exception',hint:'',run:()=>{location.hash='#availability';$('addExceptionButton').click()}}
  ];
  function renderCommands(){const term=$('commandInput').value.trim().toLowerCase();commands=commandDefs.filter(c=>c.label.toLowerCase().includes(term));commandIndex=Math.min(commandIndex,Math.max(0,commands.length-1));$('commandResults').innerHTML=commands.length?commands.map((c,i)=>`<button type="button" class="command-option" role="option" aria-selected="${i===commandIndex}" data-command="${i}">${ICON('search')}<span>${esc(c.label)}</span><small>${esc(c.hint)}</small></button>`).join(''):'<div class="empty command-empty">No matches.</div>';
    $('commandResults').querySelectorAll('[data-command]').forEach(b=>b.onclick=()=>runCommand(+b.dataset.command));}
  function runCommand(i){const c=commands[i];if(!c)return;closeDialog('commandDialog');$('commandInput').value='';c.run()}
  function showPalette(){commandIndex=0;$('commandInput').value='';renderCommands();openDialog('commandDialog');$('commandInput').focus()}
  $('commandTrigger').onclick=showPalette;
  $('commandInput').oninput=()=>{commandIndex=0;renderCommands()};
  $('commandInput').onkeydown=e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();commandIndex=(commandIndex+(e.key==='ArrowDown'?1:-1)+commands.length)%Math.max(1,commands.length);renderCommands()}else if(e.key==='Enter'){e.preventDefault();runCommand(commandIndex)}};
  let awaitingG=false,awaitGTimer=null;
  document.addEventListener('keydown',e=>{
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();showPalette();return}
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'&&activePage==='availability'){e.preventDefault();$('saveAvailability').click();return}
    const tag=document.activeElement?.tagName;
    if(e.key==='Escape'){$('userMenu').hidden=true;$('notificationMenu').hidden=true;closeMobile();return}
    if(['INPUT','TEXTAREA','SELECT'].includes(tag)||document.querySelector('dialog[open]'))return;
    if(awaitingG){const page={s:'schedule',r:'requests',a:'availability',m:'manager'}[e.key.toLowerCase()];awaitingG=false;clearTimeout(awaitGTimer);if(page){e.preventDefault();location.hash='#'+page}return}
    if(e.key.toLowerCase()==='g'&&!e.metaKey&&!e.ctrlKey){awaitingG=true;awaitGTimer=setTimeout(()=>awaitingG=false,900)}
  });
  $('mainNav').onkeydown=e=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;e.preventDefault();const links=[...$('mainNav').querySelectorAll('.nav-item')];let i=links.indexOf(document.activeElement);i=e.key==='Home'?0:e.key==='End'?links.length-1:(i+(e.key==='ArrowDown'?1:-1)+links.length)%links.length;links[i].focus()};
  document.addEventListener('click',e=>{if(!$('profileButton').contains(e.target)&&!$('userMenu').contains(e.target)){$('userMenu').hidden=true;$('profileButton').setAttribute('aria-expanded','false')}
    if(!$('notificationButton').contains(e.target)&&!$('notificationMenu').contains(e.target)){$('notificationMenu').hidden=true;$('notificationButton').setAttribute('aria-expanded','false')}});
  window.addEventListener('beforeunload',e=>{if(activePage==='availability'&&isDirty()){e.preventDefault();e.returnValue=''}});
  $('privacyLink').onclick=e=>{e.preventDefault();$('legalTitle').textContent='Privacy';$('legalContent').textContent='This preview stores example shifts, requests, and availability in your browser’s local storage. It does not send this data to a server. Delete the data by resetting the preview or clearing this site’s storage. A production privacy policy must be provided before public launch.';openDialog('legalDialog')};
  $('termsLink').onclick=e=>{e.preventDefault();$('legalTitle').textContent='Terms';$('legalContent').textContent='This is an interactive prototype for evaluation only. It is not connected to an employer or scheduling service, and example actions are not communicated to coworkers. Production terms must be reviewed and published by the project team before public launch.';openDialog('legalDialog')};
  route();renderNavigation();
  // Set native date/time controls to their sample state without relying on a build step.
})();
