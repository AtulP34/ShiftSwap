const today=new Date();today.setHours(0,0,0,0);
const weekStart=date=>{const d=new Date(date);d.setDate(d.getDate()-(d.getDay()+6)%7);d.setHours(0,0,0,0);return d};
const addDays=(date,n)=>{const d=new Date(date);d.setDate(d.getDate()+n);return d};
const sameDay=(a,b)=>a.toDateString()===b.toDateString();
const formatTime=h=>`${h%12||12} ${h<12?"AM":"PM"}`;
const sampleWeek=weekStart(today);
const shifts=[
{id:1,day:0,title:"Opening shift",start:9,end:13,person:"Aditya",location:"Front counter",type:"mine"},
{id:2,day:1,title:"Front desk",start:12,end:17,person:"Jordan",location:"Reception",type:"team"},
{id:3,day:2,title:"Morning shift",start:10,end:16,person:"Aditya",location:"Main floor",type:"mine"},
{id:4,day:3,title:"Closing shift",start:14,end:20,person:"Kiran",location:"Main floor",type:"team"},
{id:5,day:3,title:"Cover needed",start:9,end:12,person:"Unassigned",location:"Front counter",type:"open"},
{id:6,day:4,title:"Customer care",start:9,end:15,person:"Aditya",location:"Service desk",type:"mine"},
{id:7,day:5,title:"Afternoon shift",start:11,end:17,person:"Aditya",location:"Main floor",type:"mine"},
{id:8,day:6,title:"Weekend close",start:12,end:18,person:"Ayesha",location:"Main floor",type:"team"}];
let visibleWeek=new Date(sampleWeek),activeFilter="all";
const get=id=>document.getElementById(id);
function openShift(shift){
const date=addDays(sampleWeek,shift.day);
get("dialogTitle").textContent=shift.title;
get("dialogDate").textContent=date.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});
get("dialogTime").textContent=`${formatTime(shift.start)} – ${formatTime(shift.end)}`;
get("dialogLocation").textContent=shift.location;
get("dialogAssignee").textContent=shift.type==="open"?"Available for coverage":`Assigned to ${shift.person}`;
get("shiftDialog").showModal();
}
function makeCard(shift){
const button=document.createElement("button");button.type="button";button.className=`shift-card ${shift.type}`;
button.innerHTML=`<span class="shift-time">${formatTime(shift.start)} – ${formatTime(shift.end)}</span><strong>${shift.title}</strong><span class="shift-person">${shift.person}</span>`;
button.setAttribute("aria-label",`${shift.title}, ${formatTime(shift.start)} to ${formatTime(shift.end)}, ${shift.person}. View details.`);
button.addEventListener("click",()=>openShift(shift));return button;
}
function renderNextShift(){
const upcoming=shifts.filter(shift=>shift.type==="mine"&&addDays(sampleWeek,shift.day)>=today);
if(!sameDay(visibleWeek,sampleWeek)||!upcoming.length){get("nextShiftContent").innerHTML='<div class="next-desc"><h3>No upcoming shifts this week</h3><p>Choose another week to explore the schedule.</p></div>';return;}
const shift=upcoming[0],date=addDays(sampleWeek,shift.day);
get("nextShiftContent").innerHTML=`<div class="next-date"><span>${date.toLocaleDateString("en-US",{month:"short"})}</span><strong>${date.getDate()}</strong></div><div class="next-desc"><h3>${shift.title}</h3><p>${date.toLocaleDateString("en-US",{weekday:"long"})} · ${formatTime(shift.start)} – ${formatTime(shift.end)} · ${shift.location}</p><span class="next-status"><svg class="icon"><use href="#i-check"></use></svg> Assigned to you</span></div>`;
}
function renderCalendar(){
const last=addDays(visibleWeek,6);
const start=visibleWeek.toLocaleDateString("en-US",{month:"short",day:"numeric"});
const end=last.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});
get("weekRange").textContent=`${start} – ${end}`;
const hasSamples=sameDay(visibleWeek,sampleWeek);
const all=hasSamples?shifts:[],shown=all.filter(s=>activeFilter==="all"||s.type==="mine");
const mine=all.filter(s=>s.type==="mine");
get("hoursValue").innerHTML=`${mine.reduce((total,s)=>total+s.end-s.start,0)}<span class="unit">hrs</span>`;
get("shiftsValue").textContent=mine.length;
get("openValue").textContent=all.filter(s=>s.type==="open").length;
get("calendarGrid").replaceChildren();
for(let day=0;day<7;day++){
const date=addDays(visibleWeek,day),column=document.createElement("div"),current=sameDay(date,today);
column.className=`day-column${current?" is-today":""}`;
column.innerHTML=`<div class="day-header"><div><span class="day-label">${date.toLocaleDateString("en-US",{weekday:"short"})}</span><span class="day-number">${date.getDate()}</span></div>${current?'<span class="today-tag">Today</span>':""}</div>`;
const entries=shown.filter(s=>s.day===day).sort((a,b)=>a.start-b.start);
if(!entries.length){const empty=document.createElement("div");empty.className="day-empty";empty.textContent="No shifts";column.append(empty);}
else entries.forEach(s=>column.append(makeCard(s)));
get("calendarGrid").append(column);
}
renderNextShift();
}
function closeNavigation(){get("sidebar").classList.remove("is-open");get("drawerBackdrop").hidden=true;get("menuToggle").setAttribute("aria-expanded","false");}
function showPage(page){
const titles={schedule:"Schedule",requests:"Requests",availability:"Availability",manager:"Manager"};
const descriptions={requests:"Swap requests and manager approvals will be built in the next phase.",availability:"Setting preferred working hours is planned for a later frontend update.",manager:"Manager tools and team approvals are not part of this first frontend pass."};
const selected=titles[page]?page:"schedule",isSchedule=selected==="schedule";
get("schedulePage").hidden=!isSchedule;get("placeholderPage").hidden=isSchedule;
get("breadcrumb").textContent=titles[selected];
if(!isSchedule){get("placeholderTitle").textContent=`${titles[selected]} is coming soon.`;get("placeholderDescription").textContent=descriptions[selected];}
document.querySelectorAll(".nav-link").forEach(link=>{const active=link.dataset.page===selected;link.classList.toggle("active",active);if(active)link.setAttribute("aria-current","page");else link.removeAttribute("aria-current");});
closeNavigation();
}
get("previousWeek").addEventListener("click",()=>{visibleWeek=addDays(visibleWeek,-7);renderCalendar()});
get("nextWeek").addEventListener("click",()=>{visibleWeek=addDays(visibleWeek,7);renderCalendar()});
get("todayButton").addEventListener("click",()=>{visibleWeek=weekStart(today);renderCalendar()});
document.querySelectorAll(".filter-button").forEach(button=>button.addEventListener("click",()=>{activeFilter=button.dataset.filter;document.querySelectorAll(".filter-button").forEach(option=>{const active=option===button;option.classList.toggle("active",active);option.setAttribute("aria-pressed",String(active))});renderCalendar()}));
document.querySelectorAll(".nav-link").forEach(link=>link.addEventListener("click",()=>showPage(link.dataset.page)));
get("backToSchedule").addEventListener("click",()=>{location.hash="schedule";showPage("schedule")});
get("menuToggle").addEventListener("click",()=>{const open=get("sidebar").classList.toggle("is-open");get("drawerBackdrop").hidden=!open;get("menuToggle").setAttribute("aria-expanded",String(open))});
get("drawerBackdrop").addEventListener("click",closeNavigation);
document.addEventListener("keydown",event=>{if(event.key==="Escape")closeNavigation()});
window.addEventListener("hashchange",()=>showPage(location.hash.slice(1).toLowerCase()));
renderCalendar();showPage(location.hash.slice(1).toLowerCase()||"schedule");