// ===== Firebase Initialization =====
if (!firebase.apps || !firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();
const auth = firebase.auth();

// ▼▼▼ 修正点2: 欠けていた drawDataURL 関数を追加 ▼▼▼
function drawDataURL(ctx, url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.drawImage(img, 0, 0);
      resolve();
    };
    img.onerror = (e) => {
      console.error("Failed to load image from data URL", e);
      reject(e);
    };
    img.src = url;
  });
}

handleStartupVideo(); // 動画は引き続きオフにしておきます

async function handleStartupVideo() {
  const container = document.getElementById('startup-video-container');
  const video = document.getElementById('startup-video');

  // コンテナやビデオ要素がなければ、ここで処理を終了
  if (!container || !video) {
    return;
  }

  video.playbackRate = 2.0; // 再生速度を2倍に

  // ビデオを非表示にするための関数
  const hideVideo = () => {
    container.style.opacity = '0';
    setTimeout(() => {
      container.style.display = 'none';
    }, 500); // 0.5秒かけてフェードアウト
  };

  // ビデオの再生が終了したことを知らせるPromise
  const videoEndedPromise = new Promise(resolve => {
    video.addEventListener('ended', resolve, { once: true }); // イベントリスナーを一度だけ実行
  });

  // 動画の再生を試みる
  video.play().catch(error => {
    // 自動再生がブロックされた場合は、すぐにビデオを非表示にする
    console.warn("Startup video autoplay was blocked.", error);
    hideVideo();
  });

  // --- ▼ここからが修正箇所▼ ---
  try {
    // 動画の再生終了を待つ
    await videoEndedPromise;
  } catch (e) {
    console.error("Error waiting for video to end:", e);
  } finally {
    // 待機後、ビデオがまだ表示されていれば非表示にする
    if (container.style.display !== 'none') {
        hideVideo();
    }
  }
  // --- ▲ここまでが修正箇所▲ ---
}

// ===== Utilities =====
const $  = (q, el = document) => el.querySelector(q);
const $$ = (q, el = document) => Array.from(el.querySelectorAll(q));

function ymd(d){
  const date = new Date(d.getTime() - d.getTimezoneOffset()*60000);
  return date.toISOString().slice(0,10);
}
function parseDateInput(value){
  const [y,m,d] = value.split("-").map(Number);
  return new Date(y, (m||1)-1, d||1);
}
function startOfWeek(d){ const x=new Date(d); const day=(x.getDay()+6)%7; x.setDate(x.getDate()-day); x.setHours(0,0,0,0); return x; }
function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
function getMonthStr(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; }
function endOfMonth(d){ return new Date(d.getFullYear(), d.getMonth()+1, 0); }
function getWeekDates(d){ const s=startOfWeek(d); return [...Array(7).keys()].map(i=>addDays(s,i)); }

function openLtimer() {
  if (teamId && memberId) {
    const encodedTeamId = encodeURIComponent(teamId);
    const encodedMemberId = encodeURIComponent(memberId);
    const ltimerUrl = `https://gddgfr4.github.io/Ltimer/?team=${encodedTeamId}&member=${encodedMemberId}`;
    window.open(ltimerUrl, '_blank');
  } else {
    window.open('https://gddgfr4.github.io/Ltimer/', '_blank');
  }
}

function openStadiumMap() {
  if (teamId && memberId) {
    const encodedTeamId = encodeURIComponent(teamId);
    const encodedMemberId = encodeURIComponent(memberId);
    const stadiumMapUrl = `https://gddgfr4.github.io/stadiummap/?team=${encodedTeamId}&member=${encodedMemberId}`;
    window.open(stadiumMapUrl, '_blank');
  } else {
    window.open('https://gddgfr4.github.io/stadiummap/', '_blank');
  }
}


async function sumWeekKm(d){
  const dates=getWeekDates(d);
  let s=0;
  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
  for(const dt of dates){
    const doc=await getJournalRef(srcTeam, viewingMemberId, dt).get();
    if(doc.exists) s+=Number(doc.data().dist||0);
  }
  return s;
}

const MT = { pointers: new Set() };
function setOverlayTouchAction(mode){
  const ov = document.getElementById('mmOverlay');
  if (ov) ov.style.touchAction = mode;
}


// ===== Main/Sub helpers =====
function getProfiles(){
  try{ return JSON.parse(localStorage.getItem('athlog:profiles')||'[]'); }
  catch{ return []; }
}
function upsertProfile(team, member){
  const arr=getProfiles();
  if(!arr.some(p=>p.team===team && p.member===member)){
    arr.push({team,member});
    localStorage.setItem('athlog:profiles', JSON.stringify(arr));
  }
}
function getMainTeamOf(user){
  try{
    const map=JSON.parse(localStorage.getItem('athlog:mainTeamByUser')||'{}');
    return map[user]||null;
  }catch{ return null; }
}
function setMainTeamOf(user, team){
  const map=JSON.parse(localStorage.getItem('athlog:mainTeamByUser')||'{}');
  map[user]=team;
  localStorage.setItem('athlog:mainTeamByUser', JSON.stringify(map));
}
async function applyMirrorFlagsForUser(user, mainTeam){
  const myTeams=getProfiles().filter(p=>p.member===user).map(p=>p.team);
  for(const t of myTeams){
    const ref=getMembersRef(t).doc(user);
    if(t===mainTeam){
      await ref.set({ mirrorFromTeamId: firebase.firestore.FieldValue.delete() }, { merge:true });
    }else{
      await ref.set({ mirrorFromTeamId: mainTeam }, { merge:true });
    }
  }
}
async function getViewSourceTeamId(currTeam, member){
  try{
    const snap=await getMembersRef(currTeam).doc(member).get();
    return snap.data()?.mirrorFromTeamId || currTeam;
  }catch{ return currTeam; }
}
function isEditableHere(currTeam, myUser, viewingUser){
  if(viewingUser!==myUser) return false;
  const main=getMainTeamOf(myUser);
  if(!main) return true;
  return currTeam===main;
}
async function chooseMainTeam(newMainTeam){
  if(!memberId || !newMainTeam) return;
  setMainTeamOf(memberId, newMainTeam);
  await applyMirrorFlagsForUser(memberId, newMainTeam);
  switchTab($(".tab.active")?.dataset.tab, true);
}
function refreshBadges(){
  const mainTeamBadge = $("#mainTeamBadge");
  const readonlyBadge = $("#readonlyBadge");
  if(mainTeamBadge){
    const main = getMainTeamOf(memberId);
    mainTeamBadge.classList.toggle("hidden", teamId!==main);
  }
  if(readonlyBadge){
    const editable = isEditableHere(teamId, memberId, viewingMemberId);
    readonlyBadge.classList.toggle("hidden", editable);
  }
}

// ===== Team Memo paging state =====
let memoPageSize=30, memoOldestDoc=null, memoLatestTs=0, memoLiveUnsub=null, memoLoadingOlder=false;
const memoLastViewKey = () => `athlog:${teamId}:${memberId}:lastMemoView`;
async function markMemoRead(){
  const snap=await getTeamMemoCollectionRef(teamId).orderBy('ts','desc').limit(1).get();
  const latestTs = snap.empty ? Date.now() : (snap.docs[0].data().ts || Date.now());
  localStorage.setItem(memoLastViewKey(), String(latestTs));
  const memoTab=document.querySelector('[data-tab="memo"]');
  memoTab?.classList.remove('new-message');
}

// ===== App State =====
let teamId=null, memberId=null, viewingMemberId=null;
let currentUser = null; // ★ ログイン中のユーザー情報を保持
let selDate=new Date();
let brush={ lvl:1, erase:false };
let distanceChart=null, conditionChart=null;
let dashboardOffset=0, dashboardMode='month';
let conditionChartOffset=0;
let unsubscribePlans, unsubscribeMemo, unsubscribeMonthChat, unsubscribeJournal;
let dirty={ dist:false, train:false, feel:false };
let lastJournal=null;
let unsubscribeNotify = null;


// ===== Data Access Layer =====
const getJournalRef  = (team,member,day)=> db.collection('teams').doc(team).collection('members').doc(member).collection('journal').doc(ymd(day));
const getGoalsRef    = (team,member,month)=> db.collection('teams').doc(team).collection('members').doc(member).collection('goals').doc(month);
const getPlansCollectionRef=(team)=> db.collection('teams').doc(team).collection('plans');
const getTeamMemoCollectionRef=(team)=> db.collection('teams').doc(team).collection('memo');
const getMonthChatCollectionRef=(team,month)=> db.collection('teams').doc(team).collection('chat').doc(month).collection('messages');
const getMembersRef=(team)=> db.collection('teams').doc(team).collection('members');

// ===== UI Boot & Tab Control (showAppの変更) =====
async function showApp(user) {
  currentUser = user;
  memberId = user.uid; // ★ Authの表示名をmemberIdとして使用
  viewingMemberId = user.uid;

  // teamIdをFirestoreから取得する
  const userProfile = await db.collection('users').doc(user.uid).get();
  teamId = userProfile.data()?.teamId || null;

  if (!teamId) {
    alert("チーム情報が見つかりません。アカウントを再作成する必要があるかもしれません。");
    auth.signOut();
    return;
  }
  const memberDoc = await getMembersRef(teamId).doc(user.uid).get();
  const memberName = memberDoc.data()?.name || user.displayName;


  $("#teamLabel").textContent = teamId;
  $("#memberLabel").textContent = memberName;
  $("#memberLabel").title = `UID: ${user.uid}`;
  // ★ ログイン/アプリ画面の表示切り替え
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  
  // (以降の showApp の処理は元のまま)
  const __nowMon=getMonthStr(new Date());
  if($("#monthPick") && !$("#monthPick").value) $("#monthPick").value=__nowMon;
  if($("#planMonthPick") && !$("#planMonthPick").value) $("#planMonthPick").value=__nowMon;

  await populateMemberSelect();
  const memberSelect=$("#memberSelect");
  if(memberSelect) memberSelect.addEventListener('change', ()=>{
    viewingMemberId = $("#memberSelect").value; // ここは uid のまま
    // ▼▼▼ 修正点: 選択されたメンバー名を表示 ▼▼▼
    const selectedOption = memberSelect.options[memberSelect.selectedIndex];
    $("#memberLabel").textContent = selectedOption.text;
    
    selDate=new Date();
    const dp=$("#datePicker"); if(dp) dp.value=ymd(selDate);
    refreshBadges();
    switchTab($(".tab.active")?.dataset.tab, true);
  });
  
  $("#migrateBtn").addEventListener("click", migrateDataFromNameToUid);

  initJournal(); initMonth(); initPlans(); initDashboard(); initMemo();

  selDate=new Date();
  const dp=$("#datePicker"); if(dp) dp.value=ymd(selDate);
  refreshBadges();
  await switchTab("journal");
  checkNewMemo();
  initTeamSwitcher();
  initGlobalTabSwipe();
}

function initTeamSwitcher(){
  const wrap   = $("#teamSwitchWrap");
  const sel    = $("#teamSwitchSelect");
  const btnMain= $("#setAsMainBtn");
  const btnAdd = $("#addTeamBtn");
  if(!wrap || !sel || !btnMain) return;

  wrap.style.display = 'flex';

  if (teamId && !getProfiles().some(p => p.team===teamId && p.member===memberId)){
    upsertProfile(teamId, memberId);
  }
  const profiles = getProfiles().filter(p => p.member===memberId);

  sel.innerHTML = (profiles.length ? profiles : [{team:teamId, member:memberId}])
    .map(p=>{
      const isMain = getMainTeamOf(memberId) === p.team;
      const label  = isMain ? `${p.team}（メイン）` : p.team;
      return `<option value="${p.team}" ${p.team===teamId?'selected':''}>${label}</option>`;
    }).join('');

  sel.onchange = async (e)=>{
    teamId = e.target.value;
    $("#teamLabel").textContent = teamId;
    await populateMemberSelect();
    refreshBadges();
    switchTab($(".tab.active")?.dataset.tab, true);
  };

  if(btnAdd){
    btnAdd.onclick = async ()=>{
      const t = prompt("追加する Team ID を入力:");
      if(!t) return;
      upsertProfile(t, memberId);
      teamId = t;
      localStorage.setItem("athlog:last", JSON.stringify({ team:teamId, member:memberId }));
      $("#teamLabel").textContent = teamId;
      await getMembers_Ref(teamId).doc(memberId).set({ name: currentUser.displayName }, { merge:true }); // 修正前: { name:memberId }
      await populateMemberSelect();
      refreshBadges();
      initTeamSwitcher();
      switchTab($(".tab.active")?.dataset.tab, true);
    };
  }

  btnMain.onclick = async ()=>{
    const newMain = sel.value;
    await chooseMainTeam(newMain);
    refreshBadges();
    initTeamSwitcher();
  };
}

async function switchTab(id, forceRender=false){
  if (id === 'clock') {
    openLtimer();
    return;
  }
  if (id === 'stadium') {
    openStadiumMap();
    return;
  }
  if(!forceRender && $(".tab.active")?.dataset.tab===id) return;

  $$(".tab").forEach(btn=>btn.classList.toggle("active", btn.dataset.tab===id));
  $$(".tabpanel").forEach(p=>p.classList.toggle("active", p.id===id));
  if(unsubscribePlans) unsubscribePlans();
  if(unsubscribeMemo) unsubscribeMemo();
  if(unsubscribeMonthChat) unsubscribeMonthChat();
  if(unsubscribeJournal) unsubscribeJournal();

  if(id==="journal") await renderJournal();
  if(id==="month") await renderMonth();
  if(id==="plans") await renderPlans();
  if(id==="dashboard") await renderDashboard();
  if(id==="memo"){ await renderMemo(); markMemoRead(); }
  if(id==="notify"){ await renderNotify(); } 
}

// ===== Login & Logout =====
$("#logoutBtn")?.addEventListener("click", ()=>{
  localStorage.removeItem("athlog:last");
  teamId=null; memberId=null; viewingMemberId=null;
  window.location.reload();
});
$$(".tab").forEach(b=>{
  if(b.dataset.tab) {
    b.addEventListener("click",()=>switchTab(b.dataset.tab));
  }
});

function renderRegions(regions={}){
  document.querySelectorAll('#bodyMap .region').forEach(el=>{
    el.classList.remove('f1','f2','f3');
    const lvl=regions[el.dataset.id];
    if(lvl) el.classList.add(`f${lvl}`);
  });
}
function initRegionMap(){
  const svg=document.getElementById('bodyMap');
  if(!svg) return;
  svg.addEventListener('click', async (e)=>{
    const target=e.target.closest('.region'); if(!target) return;
    if(!isEditableHere(teamId,memberId,viewingMemberId)) return;
    const id=target.dataset.id;
    const docRef=getJournalRef(teamId,memberId,selDate);
    const payload= brush.erase
      ? { [`regions.${id}`]: firebase.firestore.FieldValue.delete() }
      : { [`regions.${id}`]: (brush.lvl||1) };
    await docRef.set(payload,{merge:true});
  });
}

function makeJournalAutoSaver(delayMs=700){
  let t=null;
  return function(){
    clearTimeout(t);
    t=setTimeout(()=>saveJournal(), delayMs);
  };
}

// ===== JOURNAL =====
async function saveJournal(){
  const activeCond=$('#conditionBtns button.active');
  const docRef=getJournalRef(teamId,memberId,selDate);
  const journalData={
    dist: Number($("#distInput").value||0),
    train: $("#trainInput").value,
    feel:  $("#feelInput").value,
    condition: activeCond ? Number(activeCond.dataset.val) : null,
  };
  await docRef.set(journalData,{merge:true});
  dirty={ dist:false, train:false, feel:false };
  renderWeek();
}
function initJournal(){
  const scheduleAutoSave = makeJournalAutoSaver(700);
  $("#distInput")?.addEventListener("input", ()=>{ dirty.dist=true; scheduleAutoSave(); });
  $("#trainInput")?.addEventListener("input", ()=>{ dirty.train=true; scheduleAutoSave(); });
  $("#feelInput")?.addEventListener("input", ()=>{ dirty.feel=true; scheduleAutoSave(); });
  const brushBtns=$$('.palette .lvl, .palette #eraser');
  brushBtns.forEach(b=>b.addEventListener('click',()=>{
    brush.lvl=Number(b.dataset.lvl)||1;
    brush.erase=b.id==='eraser';
    brushBtns.forEach(btn=>btn.classList.remove('active'));
    b.classList.add('active');
  }));
  if(brushBtns.length) $('.palette .lvl[data-lvl="1"]')?.classList.add('active');

  $$(".qbtn").forEach(b=>b.addEventListener("click", async ()=>{
    const docRef=getJournalRef(teamId,memberId,selDate);
    await db.runTransaction(async (tx)=>{
      const snap=await tx.get(docRef);
      const base=snap.data()||{};
      const curr=Array.isArray(base.tags)?[...base.tags]:[];
      const tag=b.textContent.trim();
      const idx=curr.indexOf(tag);
      if(idx>=0) curr.splice(idx,1);
      else { if(curr.length>=2) curr.shift(); curr.push(tag); }
      const activeCondBtn=$('#conditionBtns button.active');
      tx.set(docRef,{
        dist:Number($("#distInput").value||0),
        train:$("#trainInput").value,
        feel: $("#feelInput").value,
        condition: activeCondBtn ? Number(activeCondBtn.dataset.val) : null,
        tags:curr
      },{merge:true});
    });
    dirty={dist:false,train:false,feel:false};
  }));

  $("#weekPrev")?.addEventListener("click",()=>{ selDate=addDays(selDate,-7); renderJournal(); });
  $("#weekNext")?.addEventListener("click",()=>{ selDate=addDays(selDate, 7); renderJournal(); });
  $("#gotoToday")?.addEventListener("click",()=>{ selDate=new Date(); renderJournal(); });
  $("#datePicker")?.addEventListener("change",(e)=>{ selDate=parseDateInput(e.target.value); renderJournal(); });

  $("#mergeBtn")?.addEventListener("click", async ()=>{
    const scope  = $("#mergeScope").value;
    const tagCSV = ($("#mergeTagFilter")?.value || "").trim();
  
    const text  = await collectPlansTextForDay(selDate, scope, tagCSV);
    if(text){
      $("#trainInput").value = ($("#trainInput").value ? ($("#trainInput").value+"\n") : "") + text;
    }
  
    const types = await collectPlansTypesForDay(selDate, scope, tagCSV);
    if(types.length){
      const docRef=getJournalRef(teamId,memberId,selDate);
      await docRef.set({ tags: types.slice(0,2) },{merge:true});
      renderWeek();
    }
  });


  $$('#conditionBtns button').forEach(btn=>{
    btn.addEventListener('click',()=>{
      $$('#conditionBtns button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const scheduleAutoSave = makeJournalAutoSaver(500);
      scheduleAutoSave();
    });
  });

  initMuscleMap();
  initRegionMap();
  initJournalSwipeNav();
}


function initJournalSwipeNav(){
  const root = document.getElementById('journal');
  if (!root) return;

  const isEditableEl = (el) => {
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  };

  const shouldIgnore = (el) => {
    return el.closest?.('#mmWrap') || isEditableEl(el);
  };

  const SW = { x0:0, y0:0, active:false, moved:false };
  const THRESH = 50;
  const V_TOL  = 40;

  root.addEventListener('touchstart', (e)=>{
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    SW.x0 = t.clientX; SW.y0 = t.clientY;
    SW.active = !shouldIgnore(e.target);
    SW.moved = false;
  }, { passive:true });

  root.addEventListener('touchmove', (e)=>{
    if (!SW.active || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - SW.x0;
    const dy = t.clientY - SW.y0;
    if (Math.abs(dx) > 10 && Math.abs(dy) < V_TOL) {
      e.preventDefault();
      SW.moved = true;
    }
  }, { passive:false });

  root.addEventListener('touchend', (e)=>{
    if (!SW.active) return;
    SW.active = false;
    if (!SW.moved) return;

    const t = e.changedTouches[0];
    const dx = t.clientX - SW.x0;
    const dy = t.clientY - SW.y0;

    if (Math.abs(dx) >= THRESH && Math.abs(dy) < V_TOL) {
      selDate = addDays(selDate, dx < 0 ? +1 : -1);
      const dp = document.getElementById('datePicker');
      if (dp) dp.value = ymd(selDate);
      renderJournal();
    }
  }, { passive:true });

  root.addEventListener('wheel', (e)=>{
    if (shouldIgnore(e.target)) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 20) {
      e.preventDefault();
      selDate = addDays(selDate, e.deltaX > 0 ? +1 : -1);
      const dp = document.getElementById('datePicker');
      if (dp) dp.value = ymd(selDate);
      renderJournal();
    }
  }, { passive:false });
}

async function renderJournal(){
  if (unsubscribeJournal) unsubscribeJournal();
  if (!viewingMemberId) viewingMemberId = memberId;

  dirty = { dist:false, train:false, feel:false };

  const editableHere = isEditableHere(teamId, memberId, viewingMemberId);
  $$('#journal input, #journal textarea, #journal .qbtn, #saveBtn, #mergeBtn, #conditionBtns button, .palette button')
    .forEach(el=>{
      const isNavControl = ['weekPrev','weekNext','gotoToday','datePicker'].includes(el.id);
      if (!isNavControl) el.disabled = !editableHere;
    });
  $("#teamSharedComment")?.removeAttribute("disabled");
  refreshBadges();

  const mergeScopeSelect = $("#mergeScope");
  if (mergeScopeSelect){
    mergeScopeSelect.innerHTML =
      `<option value="auto">予定から追加(自動)</option>
       <option value="${memberId}">${memberId}の予定</option>
       <option value="team">全員の予定</option>`;
  }

  $("#datePicker").value = ymd(selDate);

  await renderWeek();

  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
  
  const docRef = getJournalRef(srcTeam, viewingMemberId, selDate);
  const unsub = docRef.onSnapshot(doc => {
    const j = doc.data() || { dist:0, train:"", feel:"", tags:[], condition:null, regions:{} };
    lastJournal = j;
    drawMuscleFromDoc(j);

    if (!dirty.dist)  $("#distInput").value  = j.dist ?? "";
    if (!dirty.train) $("#trainInput").value = j.train ?? "";
    if (!dirty.feel)  $("#feelInput").value  = j.feel ?? "";

    $$('#conditionBtns button').forEach(b=>b.classList.remove('active'));
    if (j.condition) $(`#conditionBtns button[data-val="${j.condition}"]`)?.classList.add('active');

    renderRegions(j.regions || {});
    renderQuickButtons(j);
    tscInitOnce();
    tscRefresh();

    updateDistanceSummary();
  });
  unsubscribeJournal = unsub;
}

async function renderWeek(){
  const chips=$("#weekChips"); if(!chips) return;
  chips.innerHTML="";
  const days=getWeekDates(selDate);
  const srcTeam=await getViewSourceTeamId(teamId, viewingMemberId);

  for(const d of days){
    const key=ymd(d);
    const doc=await getJournalRef(srcTeam, viewingMemberId, d).get();
    const j=doc.data()||{};
    const btn=document.createElement("button");
    btn.className="chip"+(ymd(selDate)===key?" active":"");
    const tags=j.tags||[];
    btn.innerHTML=`<div>${["日","月","火","水","木","金","土"][d.getDay()]} ${d.getDate()}</div><div class="km">${(j.dist||0)}km</div>`;
    btn.style.background=''; btn.style.color='';
    if(tags.length){
      const map={ ジョグ:"var(--q-jog)", ポイント:"var(--q-point)", 補強:"var(--q-sup)", オフ:"var(--q-off)", その他:"var(--q-other)" };
      btn.style.color='#1f2937';
      if(tags.length===1) btn.style.backgroundColor=map[tags[0]];
      else btn.style.background=`linear-gradient(90deg, ${map[tags[0]]} 50%, ${map[tags[1]]} 50%)`;
    }
    btn.addEventListener("click",()=>{ selDate=d; renderJournal(); });
    chips.appendChild(btn);
  }
}

function renderQuickButtons(j){
  const currentTags=j?.tags||[];
  $$(".qbtn").forEach(b=>{
    const tag=b.textContent.trim();
    b.classList.toggle('active', currentTags.includes(tag));
  });
}

// ===== MONTH LIST =====
function initMonth(){
  $("#mPrev")?.addEventListener("click",()=>{ const m=$("#monthPick").value.split("-"); const d=new Date(Number(m[0]), Number(m[1])-2, 1); $("#monthPick").value=getMonthStr(d); renderMonth(); });
  $("#mNext")?.addEventListener("click",()=>{ const m=$("#monthPick").value.split("-"); const d=new Date(Number(m[0]), Number(m[1]), 1); $("#monthPick").value=getMonthStr(d); renderMonth(); });
  $("#monthPick")?.addEventListener("change", renderMonth);
  
   const goalInput=$("#monthGoalInput");
   if(goalInput){
     let t=null;
     goalInput.addEventListener('input', ()=>{
       clearTimeout(t);
       t=setTimeout(async ()=>{
         const monthStr=$("#monthPick").value;
         await getGoalsRef(teamId,memberId,monthStr).set({ goal: goalInput.value }, { merge:true });
       }, 500);
     });
   }                                                
}

async function renderMonth(){
  const editableHere = isEditableHere(teamId,memberId,viewingMemberId);
  const goalInputEl = document.getElementById("monthGoalInput");
  if (goalInputEl) goalInputEl.disabled = !editableHere;
  
  const box=$("#monthList"); if(!box) return;
  box.innerHTML="";

  const mp=$("#monthPick");
  const monStr=(mp && mp.value) ? mp.value : getMonthStr(new Date());
  if(mp && !mp.value) mp.value=monStr;

  const [yy,mm]=monStr.split("-").map(Number);
  const lastDay=endOfMonth(new Date(yy, mm-1, 1)).getDate();
  const srcTeam=await getViewSourceTeamId(teamId, viewingMemberId);

  let sum=0;
  for (let d = 1; d <= lastDay; d++) {
    const dt = new Date(yy, mm - 1, d);
    const dayKey = ymd(dt);
    const dow = ["SU","MO","TU","WE","TH","FR","SA"][dt.getDay()];
  
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="dow">
        <div class="date-box" id="db_${dayKey}">${dow}${d}</div>
      </div>
      <div class="txt"><div>—</div></div>
    `;
    row.addEventListener("click", () => { selDate = dt; switchTab("journal"); });
    box.appendChild(row);
  
    (async (dtLocal, key) => {
      try {
        const snap = await getJournalRef(srcTeam, viewingMemberId, dtLocal).get();
        const j = snap.data() || {};
  
        const add = Number(j.dist || 0);
        if (!Number.isNaN(add)) {
          sum += add;
          const sumEl = document.getElementById("monthSum");
          if (sumEl) sumEl.textContent = `月間走行距離: ${sum.toFixed(1)} km`;
        }
  
        const dateBox = document.getElementById(`db_${key}`);
        const tags = Array.isArray(j.tags) ? j.tags.slice(0, 2) : [];
        const colorMap = {
          ジョグ:   'var(--q-jog)',
          ポイント: 'var(--q-point)',
          補強:     'var(--q-sup)',
          オフ:     'var(--q-off)',
          その他:   'var(--q-other)'
        };

        if (dateBox) {
          if (tags.length === 0) {
            dateBox.style.background = 'transparent';
            dateBox.style.color = 'var(--muted)';
          } else {
            dateBox.style.color = '#1f2937'; // Darker text for colored backgrounds
            if (tags.length === 1) {
              dateBox.style.background = colorMap[tags[0]] || 'transparent';
            } else {
              const c1 = colorMap[tags[0]] || '#e5e7eb';
              const c2 = colorMap[tags[1]] || '#e5e7eb';
              dateBox.style.background = `linear-gradient(180deg, ${c1} 50%, ${c2} 50%)`;
            }
          }
        }
  
        const cond = (j.condition != null) ? Number(j.condition) : null;
        const condHtml = (cond && cond >= 1 && cond <= 5)
          ? `<span class="cond-pill cond-${cond}">${cond}</span>`
          : '';
  
        const txt = row.querySelector(".txt");
        if (txt) {
          txt.innerHTML = `
            <div class="month-one-line">
              ${condHtml}
              <span class="month-train-ellipsis">${(j.train || "—")}</span>
              <span class="km">${j.dist ? ` / ${j.dist}km` : ""}</span>
            </div>`;
        }
      } catch (err) {
        console.error("renderMonth day read error:", yy, mm, d, err);
        const txt = row.querySelector(".txt");
        if (txt) txt.textContent = "—";
      }
    })(dt, dayKey);
  }

  try{
    const goalDoc=await getGoalsRef(srcTeam,viewingMemberId,monStr).get();
    $("#monthGoalInput").value=goalDoc.data()?.goal || "";
  }catch(e){ console.error("read goal error:", e); }
}

// ===== Team Memo =====
function renderMemoItem(m){
  const div=document.createElement("div");
  div.className="msg";
  const time=new Date(m.ts).toLocaleString("ja-JP");
  div.innerHTML=`<span class="name">${m.mem}</span><span class="txt">${m.txt}</span><span class="muted">  ${time}</span>`;
  return div;
}
async function renderMemo(){
  if(unsubscribeMemo){ try{ unsubscribeMemo(); }catch{} }
  if(memoLiveUnsub){ try{ memoLiveUnsub(); }catch{} memoLiveUnsub=null; }

  const box=$("#memoChatLog"); if(!box) return;
  box.innerHTML=""; memoOldestDoc=null; memoLatestTs=0;

  const col=getTeamMemoCollectionRef(teamId);
  const initSnap=await col.orderBy('ts','desc').limit(memoPageSize).get();
  if(initSnap.empty){
    box.innerHTML=`<div class="muted">まだメモはありません</div>`;
  }else{
    const docsDesc=initSnap.docs;
    memoOldestDoc=docsDesc[docsDesc.length-1];
    memoLatestTs =(docsDesc[0].data().ts)||0;
    docsDesc.slice().reverse().forEach(d=> box.appendChild( renderMemoItem(d.data()) ));
    box.scrollTop=box.scrollHeight;
  }

  box.onscroll=async ()=>{
    if(box.scrollTop<=0 && !memoLoadingOlder && memoOldestDoc){
      memoLoadingOlder=true;
      const prevHeight=box.scrollHeight;
      const olderSnap=await col.orderBy('ts','desc').startAfter(memoOldestDoc).limit(memoPageSize).get();
      if(!olderSnap.empty){
        const frag=document.createDocumentFragment();
        olderSnap.docs.slice().reverse().forEach(d=> frag.appendChild( renderMemoItem(d.data()) ));
        box.insertBefore(frag, box.firstChild);
        memoOldestDoc=olderSnap.docs[olderSnap.docs.length-1];
        const newHeight=box.scrollHeight;
        box.scrollTop=newHeight-prevHeight;
      }
      memoLoadingOlder=false;
    }
  };

  memoLiveUnsub=col.orderBy('ts','desc').limit(1).onSnapshot(snap=>{
    const d=snap.docs[0]; if(!d) return;
    const data=d.data();
    if(data.ts>memoLatestTs){
      box.appendChild( renderMemoItem(data) );
      memoLatestTs=data.ts;
      box.scrollTop=box.scrollHeight;
    }
  });

  unsubscribeMemo=()=>{
    if(memoLiveUnsub){ try{ memoLiveUnsub(); }catch{} memoLiveUnsub=null; }
    box.onscroll=null;
  };
}

// ===== PLANS =====
function createPlanTagHtml(type){
  const classMap={ ジョグ:"jog", ポイント:"point", 補強:"sup", オフ:"off", その他:"other" };
  const className=classMap[type]||'';
  return `<span class="cat-tag ${className}">${type}</span>`;
}
function populatePlanScopeSelect(){
  const select=$("#planScope"); if(!select) return;
  const currentVal=select.value;
  select.innerHTML=`
    <option value="all">全件</option>
    <option value="team">全員</option>
    <option value="${viewingMemberId}">${viewingMemberId}</option>
  `;
  select.value=currentVal || 'all';
}
function initPlans(){
  $("#pPrev")?.addEventListener("click",()=>{ const m=$("#planMonthPick").value.split("-"); const d=new Date(Number(m[0]), Number(m[1])-2, 1); $("#planMonthPick").value=getMonthStr(d); renderPlans(); });
  $("#pNext")?.addEventListener("click",()=>{ const m=$("#planMonthPick").value.split("-"); const d=new Date(Number(m[0]), Number(m[1]), 1); $("#planMonthPick").value=getMonthStr(d); renderPlans(); });
  $("#planMonthPick")?.addEventListener("change", renderPlans);
  $("#planScope")?.addEventListener("change", renderPlans);
  $("#tagFilter")?.addEventListener("input", renderPlans);
  $("#toggleChat")?.addEventListener("click",()=>$("#chatBox").classList.toggle("hidden"));
  const chatInput=$("#chatInput");
  if(chatInput) chatInput.addEventListener("keydown", async (e)=>{
    if(e.key==="Enter"){
      const txt=e.target.value.trim(); if(!txt) return;
      const mon=$("#planMonthPick").value;
      await getMonthChatCollectionRef(teamId, mon).add({ mem:memberId, txt, ts:Date.now() });
      e.target.value="";
    }
  });
}
async function renderPlans(){
  populatePlanScopeSelect();
  const editableHere=isEditableHere(teamId,memberId,viewingMemberId);
  const srcTeam=await getViewSourceTeamId(teamId, viewingMemberId);
  if(unsubscribePlans) unsubscribePlans();
  const mon=$("#planMonthPick")?.value || getMonthStr(new Date());
  if($("#planMonthPick") && !$("#planMonthPick").value) $("#planMonthPick").value=mon;

  const box=$("#planList"); if(!box) return;
  box.innerHTML="";

  const [yy,mm]=mon.split("-").map(Number);
  const daysInMonth=endOfMonth(new Date(yy, mm-1, 1)).getDate();
  const unsubs=[]; unsubscribePlans=()=>{ unsubs.forEach(fn=>{ try{ fn&&fn(); }catch{} }); };

  const classMap={ ジョグ:"jog", ポイント:"point", 補強:"sup", オフ:"off", その他:"other" };

  for(let d=1; d<=daysInMonth; d++){
    const dt=new Date(yy, mm-1, d);
    const dayKey=ymd(dt);
    const row=document.createElement("div");
    row.className="row";
    row.innerHTML=`
      <div class="dow">${["SU","MO","TU","WE","TH","FR","SA"][dt.getDay()]}${d}</div>
      <div class="txt" id="pl_${dayKey}" style="flex-wrap:wrap; flex-direction:row; align-items:center;">—</div>
    `;
    if(editableHere) row.addEventListener("click", ()=>openPlanModal(dt));
    box.appendChild(row);

    const unsub = getPlansCollectionRef(srcTeam).doc(dayKey).collection('events')
      .onSnapshot(snapshot=>{
        const scope=$("#planScope")?.value || "all";
        const tagText=$("#tagFilter")?.value.trim() || "";
        const tagSet=new Set(tagText ? tagText.split(",").map(s=>s.trim()).filter(Boolean) : []);
        const arr=[];
        snapshot.docs.forEach(doc=>{
          const it=doc.data();
          if(scope==="team" && it.scope!=="team") return;
          if(scope!=="all" && scope!=="team" && it.mem!==scope) return;
          if(tagSet.size && !(it.tags||[]).some(t=>tagSet.has(t))) return;
          arr.push(it);
        });

        arr.sort((a, b) => (a.mem || "").localeCompare(b.mem || ""));

        const targetEl=document.getElementById("pl_"+dayKey);
        if(!targetEl) return;
        targetEl.innerHTML = arr.length
          ? arr.map(x=>`
              <span style="display:inline-flex; align-items:center; gap:6px; margin:2px 8px 2px 0;">
                <span class="cat-tag ${classMap[x.type]||""}">${x.type}</span>
                <span>${x.content}</span>
              </span>`).join("")
          : "—";
      }, (err)=>{
        const targetEl=document.getElementById("pl_"+dayKey);
        if(targetEl) targetEl.textContent="—";
        console.error("plans onSnapshot error:", err);
      });
    
    unsubs.push(unsub);
  }

  renderChat();
}
function renderChat(){
  if(unsubscribeMonthChat) unsubscribeMonthChat();
  const mon=$("#planMonthPick").value;
  unsubscribeMonthChat = getMonthChatCollectionRef(teamId,mon).orderBy('ts').onSnapshot(snapshot=>{
    const box=$("#chatLog"); if(!box) return;
    box.innerHTML="";
    snapshot.docs.forEach(doc=>{
      const m=doc.data();
      const div=document.createElement("div"); div.className="msg";
      const time=new Date(m.ts).toLocaleString("ja-JP");
      div.innerHTML=`<span class="name">${m.mem}</span><span class="txt">${m.txt}</span><span class="muted">  ${time}</span>`;
      box.appendChild(div);
    });
    box.scrollTop=box.scrollHeight;
  });
}
let modalDiv=null;

function openPlanModal(dt){
  closePlanModal();
  const mon=getMonthStr(dt);
  const dayKey=ymd(dt);
  let editingId=null;

  modalDiv=document.createElement("div");
  modalDiv.style.cssText="position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:100;";
  modalDiv.innerHTML=`<div style="background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;max-width:520px;margin:10vh auto;">
    <h3 style="margin:0 0 12px;">${mon} / ${dt.getDate()} の予定</h3>
    <div style="background:var(--bg);padding:10px;border-radius:8px; border:1px solid var(--line);">
      <div style="display:flex;gap:6px;margin-bottom:6px">
        <select id="ptype" class="form-control"><option>ジョグ</option><option>ポイント</option><option>補強</option><option>オフ</option><option>その他</option></select>
        <select id="pscope" class="form-control"><option value="self">${memberId}</option><option value="team">全員</option></select>
        <input id="ptags" placeholder="タグ(,区切り)" class="form-control" />
      </div>
      <textarea id="pcontent" rows="3" style="width:100%" class="form-control"></textarea>
      <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:8px">
        <button id="p_delete" class="ghost" style="color:red; display:none; margin-right:auto;">削除</button>
        <button id="p_new" class="ghost">新規</button>
        <button id="p_action" class="primary">追加</button>
      </div>
    </div>
    <div id="plist" style="margin-top:8px; display:flex; flex-direction:column; gap:4px;"></div>
    <button id="p_close" class="ghost" style="width:100%; margin-top:12px;">閉じる</button>
  </div>`;
  document.body.appendChild(modalDiv);

  const pActionBtn=$("#p_action",modalDiv), pDeleteBtn=$("#p_delete",modalDiv);
  const pType=$("#ptype",modalDiv), pScope=$("#pscope",modalDiv), pTags=$("#ptags",modalDiv), pContent=$("#pcontent",modalDiv);

  const resetForm=()=>{
    editingId=null;
    pType.value="ジョグ"; pScope.value="self"; pTags.value=""; pContent.value="";
    pActionBtn.textContent="追加"; pDeleteBtn.style.display="none";
    $$("#plist .row",modalDiv).forEach(r=>r.style.outline='none');
  };
  const editItem=(id,targetRow)=>{
    const planDocRef=getPlansCollectionRef(teamId).doc(dayKey).collection('events').doc(id);
    planDocRef.get().then(doc=>{
      const item=doc.data();
      if(!item || item.mem!==memberId) return;
      editingId=id;
      pType.value=item.type; pScope.value=item.scope; pTags.value=(item.tags||[]).join(","); pContent.value=item.content;
      pActionBtn.textContent="更新"; pDeleteBtn.style.display="block";
      $$("#plist .row",modalDiv).forEach(r=>r.style.outline='none');
      targetRow.style.outline=`2px solid var(--primary)`;
    });
  };
  renderPlanListInModal(mon, dayKey, editItem);
  $("#p_close",modalDiv).addEventListener("click", closePlanModal);
  $("#p_new",modalDiv).addEventListener("click", resetForm);
  pDeleteBtn.addEventListener("click", async ()=>{
    if(!editingId || !confirm("この予定を削除しますか？")) return;
    await getPlansCollectionRef(teamId).doc(dayKey).collection('events').doc(editingId).delete();
    resetForm();
  });
  pActionBtn.addEventListener("click", async ()=>{
    const content=pContent.value.trim(); if(!content) return;
    const planData={
      type:pType.value, scope:pScope.value, content, mem:memberId,
      tags:(pTags.value||"").split(",").map(s=>s.trim()).filter(Boolean),
      month:mon, day:dayKey, team:teamId
    };
    
    if(editingId){
      await getPlansCollectionRef(teamId).doc(dayKey).collection('events').doc(editingId).set(planData);
    }else{
      await getPlansCollectionRef(teamId).doc(dayKey).collection('events').add(planData);
    }
    resetForm();
  });
}

function renderPlanListInModal(mon, dayKey, editCallback){
  const cont=$("#plist",modalDiv); cont.innerHTML='';
  getPlansCollectionRef(teamId).doc(dayKey).collection('events').get().then(snapshot=>{
    if(snapshot.empty){ cont.innerHTML='<div class="muted" style="text-align:center;">予定はありません</div>'; return; }

    const sortedDocs = snapshot.docs.sort((a, b) => {
        const memA = a.data().mem || "";
        const memB = b.data().mem || "";
        return memA.localeCompare(memB);
    });

    sortedDocs.forEach((doc,i)=>{
      const x=doc.data();
      const isMyPlan=x.mem===memberId;
      const row=document.createElement("div"); row.className="row";
      let ownerText=x.scope==='team' ? ' (全員)' : ` (${x.mem})`;
      if(isMyPlan){
        row.style.cursor="pointer";
        row.addEventListener("click",()=>editCallback(doc.id,row));
      }
      row.innerHTML=`<div class="dow">${i+1}</div>
        <div class="txt" style="flex-direction:row; gap:8px; align-items:center;">
          ${createPlanTagHtml(x.type)}
          <span>${x.content}<span class="muted">${ownerText}</span></span>
        </div>`;
      cont.appendChild(row);
    });
  });
}

function closePlanModal(){ if(modalDiv){ modalDiv.remove(); modalDiv=null; } }

async function collectPlansTextForDay(day, scopeSel){
  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
  const dayKey  = ymd(day);
  const plansRef = getPlansCollectionRef(srcTeam).doc(dayKey).collection('events');

  let query = plansRef;
  if (scopeSel === memberId) query = query.where('mem','==',memberId);
  if (scopeSel === 'team')   query = query.where('scope','==','team');

  const snap = await query.get();
  const lines = [];
  snap.docs.forEach(doc=>{
    const it = doc.data();
    const content = (it.content || '').trim();
    if (content) lines.push(content);
  });
  return lines.join('\n');
}


async function collectPlansTypesForDay(day, scopeSel, tagCSV=""){
  const srcTeam=await getViewSourceTeamId(teamId, viewingMemberId);
  const dayKey=ymd(day);
  let query=getPlansCollectionRef(srcTeam).doc(dayKey).collection('events');
  if(scopeSel===memberId) query=query.where('mem','==',memberId);
  if(scopeSel==='team')   query=query.where('scope','==','team');

  const tagSet = new Set(tagCSV.split(",").map(s=>s.trim()).filter(Boolean));

  const snapshot=await query.get();
  const types=[];
  snapshot.docs.forEach(doc=>{
    const it=doc.data();
    if(tagSet.size){
      const arr=Array.isArray(it.tags)?it.tags:[];
      if(!arr.some(t=>tagSet.has(t))) return;
    }
    const t=it.type;
    if(t && !types.includes(t)) types.push(t);
  });
  return types;
}


let chartDay=null, chartWeek=null, chartMonth=null;

const distOffset = { day: 0, week: 0, month: 0 };

// ===== Dashboard =====
function initDashboard(){
  document.getElementById('distDayPrev')  ?.addEventListener('click', ()=>{ distOffset.day--;   renderAllDistanceCharts(); });
  document.getElementById('distDayNext')  ?.addEventListener('click', ()=>{ distOffset.day++;   renderAllDistanceCharts(); });

  document.getElementById('distWeekPrev') ?.addEventListener('click', ()=>{ distOffset.week--;  renderAllDistanceCharts(); });
  document.getElementById('distWeekNext') ?.addEventListener('click', ()=>{ distOffset.week++;  renderAllDistanceCharts(); });

  document.getElementById('distMonthPrev')?.addEventListener('click', ()=>{ distOffset.month--; renderAllDistanceCharts(); });
  document.getElementById('distMonthNext')?.addEventListener('click', ()=>{ distOffset.month++; renderAllDistanceCharts(); });
  
  const condPrevBtn=$("#condChartPrev");
  const condNextBtn=$("#condChartNext");
  if(condPrevBtn) condPrevBtn.addEventListener('click',()=>{ conditionChartOffset-=7; renderConditionChart(); });
  if(condNextBtn) condNextBtn.addEventListener('click',()=>{ conditionChartOffset+=7; renderConditionChart(); });
}
function renderDashboard(){ renderAllDistanceCharts(); renderConditionChart(); }

async function renderConditionChart(){
  const ctx=$('#conditionChart')?.getContext('2d'); if(!ctx) return;
  const labels=[], chartData=[];
  const journalSnaps=await db.collection('teams').doc(teamId).collection('members').doc(viewingMemberId).collection('journal').get();
  const journal={}; journalSnaps.forEach(doc=>journal[doc.id]=doc.data());
  const today=new Date();
  const endDate=addDays(today, conditionChartOffset);

  for(let i=13;i>=0;i--){
    const day=addDays(endDate,-i);
    labels.push(`${day.getMonth()+1}/${day.getDate()}`);
    const dayData=journal[ymd(day)];
    chartData.push(dayData?.condition || null);
  }
  const rangeStart=addDays(endDate,-13);
  $("#condChartRange").textContent=`${ymd(rangeStart)} ~ ${ymd(endDate)}`;

  if(conditionChart) conditionChart.destroy();
  conditionChart=new Chart(ctx,{
    type:'line',
    data:{ labels, datasets:[{ label:'コンディション (1-5)', data:chartData, borderColor:'rgba(22,163,74,1)', tension:0.1, spanGaps:true }] },
    options:{ responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true, max:5, ticks:{ stepSize:1 } } } }
  });
}

chartDay = null;
chartWeek = null;
chartMonth = null;


async function renderAllDistanceCharts(){
  const snaps=await db.collection('teams').doc(teamId).collection('members').doc(viewingMemberId).collection('journal').get();
  const journal={}; snaps.forEach(doc=>journal[doc.id]=doc.data());

  {
    const cvs=document.getElementById('distanceChartDay');
    if(cvs){
      const ctx=cvs.getContext('2d');
      const labels=[], data=[];
      const windowLen=14;

      const today = new Date(); today.setHours(0,0,0,0);
      const end   = addDays(today, distOffset.day * windowLen);
      const start = addDays(end, -(windowLen-1));

      for(let i=0;i<windowLen;i++){
        const d=addDays(start,i);
        labels.push(`${d.getMonth()+1}/${d.getDate()}`);
        data.push(Number(journal[ymd(d)]?.dist||0).toFixed(1));
      }

      const t1 = document.getElementById('distChartTitleDay');
      if(t1) t1.textContent = `日別走行距離（${ymd(start)} 〜 ${ymd(end)}）`;

      if(chartDay) chartDay.destroy();
      chartDay=new Chart(ctx,{
        type:'bar',
        data:{ labels, datasets:[{ label:'走行距離 (km)', data, borderWidth:1 }] },
        options:{ responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true } } }
      });
    }
  }

  {
    const cvs=document.getElementById('distanceChartWeek');
    if(cvs){
      const ctx=cvs.getContext('2d');
      const labels=[], data=[];
      const today=new Date(); today.setHours(0,0,0,0);
      const currentWeekStart=startOfWeek(today);

      const baseWeekStart = addDays(currentWeekStart, distOffset.week * 7);

      for(let i=5;i>=0;i--){
        const ws=addDays(baseWeekStart, -i*7);
        labels.push(`${ymd(ws).slice(5)}~`);
        let sum=0;
        for(let j=0;j<7;j++){
          const day=addDays(ws,j);
          sum+=Number(journal[ymd(day)]?.dist||0);
        }
        data.push(sum.toFixed(1));
      }

      const firstWeekStart = addDays(baseWeekStart, -5*7);
      const lastWeekEnd    = addDays(baseWeekStart, 6);
      const t2 = document.getElementById('distChartTitleWeek');
      if(t2) t2.textContent = `週間走行距離（${ymd(firstWeekStart)} 〜 ${ymd(lastWeekEnd)}）`;

      if(chartWeek) chartWeek.destroy();
      chartWeek=new Chart(ctx,{
        type:'bar',
        data:{ labels, datasets:[{ label:'週合計 (km)', data, borderWidth:1 }] },
        options:{ responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true } } }
      });
    }
  }

  {
    const cvs=document.getElementById('distanceChartMonth');
    if(cvs){
      const ctx=cvs.getContext('2d');
      const labels=[], data=[];
      const monthlyTotals={};
      for(const ymdStr in journal){
        const monthStr=ymdStr.substring(0,7);
        monthlyTotals[monthStr]=(monthlyTotals[monthStr]||0)+Number(journal[ymdStr].dist||0);
      }

      const base = new Date(); base.setDate(1); base.setHours(0,0,0,0);
      base.setMonth(base.getMonth() + distOffset.month);

      const startMonth = new Date(base); startMonth.setMonth(startMonth.getMonth()-5);

      for(let i=0;i<6;i++){
        const d=new Date(startMonth); d.setMonth(startMonth.getMonth()+i);
        const m=getMonthStr(d);
        labels.push(m);
        data.push(Number(monthlyTotals[m]||0).toFixed(1));
      }

      const t3 = document.getElementById('distChartTitleMonth');
      if(t3) t3.textContent = `月間走行距離（${labels[0]} 〜 ${labels[labels.length-1]}）`;

      if(chartMonth) chartMonth.destroy();
      chartMonth=new Chart(ctx,{
        type:'bar',
        data:{ labels, datasets:[{ label:'月合計 (km)', data, borderWidth:1 }] },
        options:{ responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true } } }
      });
    }
  }
}

// ===== NEW: Team Memo =====
function initMemo(){
  const memoInput=$("#memoChatInput");
  const sendBtn=$("#memoSendBtn");
  const sendMessage=async ()=>{
    const txt=memoInput.value.trim(); if(!txt) return;
    await getTeamMemoCollectionRef(teamId).add({ mem:memberId, txt, ts:Date.now() });
    memoInput.value="";
  };
  if(memoInput) memoInput.addEventListener('keydown',(e)=>{ if(e.key==="Enter") sendMessage(); });
  if(sendBtn) sendBtn.onclick=sendMessage;
}
async function checkNewMemo(){
  const lastView=Number(localStorage.getItem(memoLastViewKey())||0);
  const snapshot=await getTeamMemoCollectionRef(teamId).orderBy('ts','desc').limit(1).get();
  const memoTab=document.querySelector('[data-tab="memo"]');
  if(!snapshot.empty){
    const lastMessage=snapshot.docs[0].data();
    if(memoTab && lastMessage.ts>lastView) memoTab.classList.add('new-message');
    else if(memoTab) memoTab.classList.remove('new-message');
  }
}

function setupAuthListeners() {
  // ログイン/ログアウトの状態を監視
  auth.onAuthStateChanged(user => {
    if (user) {
      // ログイン済みなら、アプリを表示
      showApp(user);
    } else {
      // 未ログインなら、ログイン画面を表示
      currentUser = null;
      $("#app").classList.add("hidden");
      $("#login").classList.remove("hidden");
    }
  });

  // --- ボタンのイベントリスナー設定 ---
  $("#loginBtn").onclick = doLogin;
  $("#signupBtn").onclick = doSignup;

  $("#show-signup").onclick = () => {
    $("#login-form").classList.add("hidden");
    $("#signup-form").classList.remove("hidden");
  };
  $("#show-login").onclick = () => {
    $("#signup-form").classList.add("hidden");
    $("#login-form").classList.remove("hidden");
  };
}

async function doLogin() {
  const email = $("#login-email").value;
  const password = $("#login-password").value;
  const errorEl = $("#login-error");
  errorEl.textContent = "";

  try {
    await auth.signInWithEmailAndPassword(email, password);
    // 成功すると onAuthStateChanged が自動で呼ばれて画面遷移する
  } catch (error) {
    console.error("Login failed:", error);
    errorEl.textContent = "メールアドレスまたはパスワードが違います。";
  }
}

async function doSignup() {
  const team = $("#signup-team").value.trim();
  const name = $("#signup-name").value.trim();
  const email = $("#signup-email").value;
  const password = $("#signup-password").value;
  const errorEl = $("#signup-error");
  errorEl.textContent = "";

  if (!team || !name || !email || password.length < 6) {
    errorEl.textContent = "すべての項目を正しく入力してください。";
    return;
  }

  try {
    // 1. Firebase Authにユーザーを作成
    const userCredential = await auth.createUserWithEmailAndPassword(email, password);
    const user = userCredential.user;

    // 2. Authプロファイルに表示名(name)を設定
    await user.updateProfile({
      displayName: name
    });

    // 3. Firestoreにユーザーの補助情報(チームIDなど)を保存
    await db.collection('users').doc(user.uid).set({
      teamId: team,
      name: name,
      email: email
    });
    
    // 4. チームのメンバーリストに自分を追加
    await db.collection('teams').doc(team).collection('members').doc(user.uid).set({
      name: name,
      role: 'member' // デフォルトの役割
    });

    // 成功すると onAuthStateChanged が自動で呼ばれて画面遷移する
  } catch (error) {
    console.error("Signup failed:", error);
    if (error.code === 'auth/email-already-in-use') {
      errorEl.textContent = "このメールアドレスは既に使用されています。";
    } else {
      errorEl.textContent = "登録に失敗しました。";
    }
  }
}

// app.js (1356行目あたり)
async function populateMemberSelect(){
  const select=$("#memberSelect"); if(!select) return;
  select.innerHTML='';
  const snapshot=await getMembersRef(teamId).get();
  
  snapshot.docs.forEach(doc=>{
    const memId = doc.id; // uid
    const memData = doc.data();
    const memName = memData.name || memId; // Firestoreのnameフィールド、なければuid

    const option=document.createElement('option');
    option.value = memId;       // 値は uid
    option.textContent = memName; // 表示は name
    select.appendChild(option);
  });
  
  const want=viewingMemberId || memberId;
  const exists=[...select.options].some(o=>o.value===want);
  select.value=exists ? want : memberId;
  viewingMemberId=select.value;
  
  const selectedOption = select.options[select.selectedIndex];
  if(selectedOption){
    $("#memberLabel").textContent = selectedOption.text;
    
    // ▼▼▼ この1行を追加 ▼▼▼
    $("#memberLabel").title = `UID: ${select.value}`;
    // ▲▲▲ 追加ここまで ▲▲▲
  }
  refreshBadges();
}
document.addEventListener("DOMContentLoaded",()=>{
  setupAuthListeners();
  const btn=$("#loginBtn"); if(btn) btn.onclick=doLogin;
  const t=$("#teamId"), m=$("#memberName");
  if(t && m) [t,m].forEach(inp=>inp.addEventListener("keydown",(e)=>{ if(e.key==="Enter") doLogin(); }));

  const helpBody=document.getElementById("helpBody");
  if(helpBody){
    helpBody.innerHTML=`
      <h2>1. はじめに</h2>
      <ul>
        <li>URL：<code>https://gddgfr4.github.io/AthLog1/</code></li>
        <li>データ保存：Firebase Firestore。ログインはチームID / メンバー名。</li>
        <li>右上の表示中メンバーを切替えると他メンバーは閲覧のみ。</li>
      </ul>
      <h2>2. 画面構成</h2>
      <ul>
        <li><b>日誌</b>：日々の記録</li>
        <li><b>月一覧</b>：月の一覧／月目標／合計距離</li>
        <li><b>予定表</b>：月の計画（自分/全員）</li>
        <li><b>グラフ</b>：距離・調子の可視化</li>
        <li><b>メモ</b>：チーム共有のチャット</li>
        <li><b>通知</b>：あなた宛の通知</li>
        <li><b>時計</b>：別タブで高機能タイマー（Ltimer）を開きます</li>
      </ul>
    `;
  }

  $("#openHelpBtn")?.addEventListener("click",()=>{ $("#helpOverlay")?.classList.remove("hidden"); });
  $("#helpClose")?.addEventListener("click",()=>{ $("#helpOverlay")?.classList.add("hidden"); });
  $("#helpOverlay")?.addEventListener("click",(e)=>{ if(e.target.id==="helpOverlay") e.currentTarget.classList.add("hidden"); });
  window.addEventListener("keydown",(e)=>{ if(e.key==="Escape") $("#helpOverlay")?.classList.add("hidden"); });
});


// ===== Muscle-map (overlay/barrier) =====
const MM = {
  IMG_CANDIDATES: ['human.webp','./human.webp','./assets/human.webp'],
  VIEW: 'single',
  LEVELS:{ 1:[199,210,254,210], 2:[253,186,116,210], 3:[239,68,68,210] },
  TH_LINE: 130, DILATE: 2, FRAME: 3, TOL: 22, MAX_REGION_FRAC: 0.25, MIN_REGION_PX: 25
};
let mm = { base:null, overlay:null, barrier:null, bctx:null, octx:null, wctx:null, ready:false };

function tryLoadImageSequential(srcs){
  return new Promise((resolve,reject)=>{
    const img=new Image(); let i=0;
    img.onload=()=>resolve(img);
    img.onerror=()=>{ i++; (i<srcs.length)? img.src=srcs[i] : reject(new Error('image not found')); };
    img.src=srcs[i];
  });
}

let __tmpC=null, __tmpX=null;
function tmpCtx(w,h){
  if(!__tmpC){ __tmpC=document.createElement('canvas'); __tmpX=__tmpC.getContext('2d', { willReadFrequently: true }); }
  __tmpC.width=w; __tmpC.height=h;
  return __tmpX;
}

function makeBarrierFromBase(){
  const w=mm.base.width, h=mm.base.height;
  const t=tmpCtx(w,h);
  t.clearRect(0,0,w,h);
  t.drawImage(mm.base,0,0);

  const src=t.getImageData(0,0,w,h); const s=src.data;
  const out=mm.wctx.createImageData(w,h); const d=out.data;

  for(let i=0;i<s.length;i+=4){
    const g=0.299*s[i]+0.587*s[i+1]+0.114*s[i+2];
    d[i]=d[i+1]=d[i+2]=0;
    d[i+3]=(g<MM.TH_LINE)?255:0;
  }

  const a=(x,y)=>((y*w+x)<<2)+3;
  const A=new Uint8Array(w*h);
  for(let pass=0; pass<MM.DILATE; pass++){
    A.fill(0);
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
      let on=0;
      for(let dy=-1;dy<=1 && !on;dy++)
        for(let dx=-1;dx<=1;dx++)
          if(d[a(x+dx,y+dy)]>0){ on=1; break; }
      if(on) A[y*w+x]=255;
    }
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++)
      if(A[y*w+x]) d[a(x,y)]=255;
  }

  for(let f=0; f<MM.FRAME; f++){
    for(let x=0;x<w;x++){ d[((0*w+x)<<2)+3]=255; d[(((h-1-f)*w+x)<<2)+3]=255; }
    for(let y=0;y<h;y++){ d[((y*w+0)<<2)+3]=255; d[((y*w+(w-1-f))<<2)+3]=255; }
  }

  blockOutsideAsBarrier(d,w,h);
  mm.wctx.putImageData(out,0,0);
}

function blockOutsideAsBarrier(alphaData,w,h){
  const idxA=(x,y)=>((y*w+x)<<2)+3;
  const seen=new Uint8Array(w*h);
  const st=[0, w-1, (h-1)*w, (h-1)*w+(w-1)];
  while(st.length){
    const p=st.pop();
    const y=(p/w)|0, x=p-y*w;
    if(x<0||y<0||x>=w||y>=h) continue;
    const si=y*w+x;
    if(seen[si]) continue; seen[si]=1;
    if(alphaData[idxA(x,y)]>0) continue;
    alphaData[idxA(x,y)]=255;
    st.push(si-1, si+1, si-w, si+w);
  }
}

function barrierAlphaAt(x,y){
  return mm.wctx.getImageData(x, y, 1, 1).data[3];
}

function mmPixPos(canvas,e){
  const r=canvas.getBoundingClientRect();
  return {
    x: Math.floor((e.clientX - r.left) * (canvas.width  / r.width)),
    y: Math.floor((e.clientY - r.top)  * (canvas.height / r.height))
  };
}

function floodFill(octx,wctx,sx,sy,tol,rgba){
  const w=octx.canvas.width, h=octx.canvas.height;
  const o=octx.getImageData(0,0,w,h); const od=o.data;
  const b=wctx.getImageData(0,0,w,h); const bd=b.data;
  const A_STOP=10;
  const stack=[(sy<<16)|sx];
  const seen=new Uint8Array(w*h);
  const within=(x,y)=>x>=0&&y>=0&&x<w&&y<h;
  const idx=(x,y)=>((y*w+x)<<2);

  while(stack.length){
    const p=stack.pop();
    const x=p & 0xffff, y=p>>>16;
    if(!within(x,y)) continue;
    const si=y*w+x;
    if(seen[si]) continue; seen[si]=1;

    const i=idx(x,y);
    if(bd[i+3]>A_STOP) continue;
    if(od[i+3]>A_STOP) continue;

    od[i]=rgba[0]; od[i+1]=rgba[1]; od[i+2]=rgba[2]; od[i+3]=rgba[3];

    stack.push((y<<16)|(x-1),(y<<16)|(x+1),((y-1)<<16)|x,((y+1)<<16)|x);
  }
  octx.putImageData(o,0,0);
}

function floodErase(octx,wctx,sx,sy){
  const w=octx.canvas.width, h=octx.canvas.height;
  const o=octx.getImageData(0,0,w,h); const od=o.data;
  const b=wctx.getImageData(0,0,w,h); const bd=b.data;
  const A_STOP=10;
  const stack=[(sy<<16)|sx];
  const seen=new Uint8Array(w*h);
  const within=(x,y)=>x>=0&&y>=0&&x<w&&y<h;
  const idx=(x,y)=>((y*w+x)<<2);
  if(od[idx(sx,sy)+3]<=A_STOP) return;

  while(stack.length){
    const p=stack.pop();
    const x=p&0xffff, y=p>>>16;
    if(!within(x,y)) continue;
    const si=y*w+x;
    if(seen[si]) continue; seen[si]=1;

    const i=idx(x,y);
    if(bd[i+3]>A_STOP) continue;
    if(od[i+3]<=A_STOP) continue;

    od[i]=od[i+1]=od[i+2]=0; od[i+3]=0;

    stack.push((y<<16)|(x-1),(y<<16)|(x+1),((y-1)<<16)|x,((y+1)<<16)|x);
  }
  octx.putImageData(o,0,0);
}

function drawMuscleFromDoc(j){
  if(!mm.octx || !mm.wctx) return;
  mm.octx.clearRect(0,0,mm.octx.canvas.width, mm.octx.canvas.height);
  mm.wctx.clearRect(0,0,mm.wctx.canvas.width, mm.wctx.canvas.height);
  if(j?.mmBarrierPng){ drawDataURL(mm.wctx, j.mmBarrierPng).then(()=>{}); }
  else{ makeBarrierFromBase(); }
  if(j?.mmOverlayWebp){ drawDataURL(mm.octx, j.mmOverlayWebp).then(()=>{}); }
}

async function saveMuscleLayerToDoc(){
  const docRef=getJournalRef(teamId,memberId,selDate);
  const overlayWebp = mm?.octx ? mm.octx.canvas.toDataURL('image/webp',0.65) : null;
  const payload     = { mmOverlayWebp: overlayWebp };
  await docRef.set(payload,{merge:true});
}

// app.js

// ▼▼▼ 既存の initMuscleMap 関数を、このコードで完全に置き換えてください ▼▼▼
function initMuscleMap(){
  mm.base   = document.getElementById('mmBase');
  mm.overlay= document.getElementById('mmOverlay');
  mm.barrier= document.getElementById('mmBarrier');
  if(!mm.base || !mm.overlay || !mm.barrier) return;

  mm.bctx = mm.base.getContext('2d', { willReadFrequently: true });
  mm.octx = mm.overlay.getContext('2d', { willReadFrequently:true });
  mm.wctx = mm.barrier.getContext('2d', { willReadFrequently: true });

  tryLoadImageSequential(MM.IMG_CANDIDATES).then(img=>{
    const fullW=img.naturalWidth, fullH=img.naturalHeight;
    const crop = {sx:0, sy:0, sw:fullW, sh:fullH};

    [mm.base, mm.overlay, mm.barrier].forEach(c=>{ c.width=crop.sw; c.height=crop.sh; });

    mm.bctx.clearRect(0,0,crop.sw,crop.sh);
    mm.bctx.drawImage(img, crop.sx,crop.sy,crop.sw,crop.sh, 0,0,crop.sw,crop.sh);

    const wrap = document.getElementById('mmWrap');
    if(wrap) wrap.style.aspectRatio = `${crop.sw} / ${crop.sh}`;

    makeBarrierFromBase();
    mm.ready=true;

    drawMuscleFromDoc(lastJournal);
  }).catch(err=>{
    console.error(err);
  });

  const ov = mm.overlay;

  // ★★★ここからが修正箇所です★★★
  // 画面上の指の数を追跡し、ピンチ操作中は描画しないようにします
  ov.addEventListener('pointerdown', (e) => {
    MT.pointers.add(e.pointerId);
    
    // 指が1本の時だけ描画処理を実行
    if (MT.pointers.size !== 1) {
      return;
    }

    if(!isEditableHere(teamId,memberId,viewingMemberId)) return;
    const p=mmPixPos(ov,e);
    if (barrierAlphaAt(p.x,p.y) > 10) return;
    if(brush.erase){
      floodErase(mm.octx, mm.wctx, p.x, p.y);
    }else{
      floodFill(mm.octx, mm.wctx, p.x, p.y, MM.TOL, MM.LEVELS[brush.lvl||1]);
    }
    saveMuscleLayerToDoc();
  }, { passive:true });

  // 指が画面から離れたら追跡を解除
  const clearPointer = (e) => {
    MT.pointers.delete(e.pointerId);
  };
  ov.addEventListener('pointerup', clearPointer);
  ov.addEventListener('pointercancel', clearPointer);
  // ★★★修正ここまで★★★
}
// ▲▲▲ ここまでで置き換え ▲▲▲

// ===== チームコメント =====
let tscDirty = false, tscTimer = null;

function tscSetStatus(msg){ const el=document.getElementById('teamSharedCommentStatus'); if(el) el.textContent=msg; }

async function tscLoad(){
  try{
    const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
    const snap = await getJournalRef(srcTeam, viewingMemberId, selDate).get();
    const text = (snap.data() || {}).teamComment || '';
    const ta = document.getElementById('teamSharedComment');
    if(ta && !tscDirty) ta.value = text;
  }catch(e){ console.error('tscLoad', e); }
}

async function tscSave(){
  try{
    const ta = document.getElementById('teamSharedComment');
    if(!ta) return;
    const text = ta.value;
    const ref  = getJournalRef(teamId, viewingMemberId, selDate);
    // lastCommentBy フィールドに現在のユーザーIDを追加
    await ref.set({ teamComment: text, lastCommentBy: memberId }, { merge:true });
    tscDirty = false;
    tscSetStatus('保存済み');
  }catch(e){
    console.error('tscSave', e);
    tscSetStatus('保存失敗（自動再試行）');
    clearTimeout(tscTimer);
    tscTimer = setTimeout(tscSave, 1500);
  }
}

function tscScheduleSave(){
  tscDirty = true;
  tscSetStatus('保存待ち…');
  clearTimeout(tscTimer);
  tscTimer = setTimeout(tscSave, 700);
}

function tscInitOnce(){
  const ta = document.getElementById('teamSharedComment');
  if(!ta) return;
  ta.removeAttribute('disabled');
  ta.addEventListener('input', tscScheduleSave);
}

async function tscRefresh(){
  tscDirty = false;
  await tscLoad();
}

async function safeDayDist(srcTeam, member, day){
  try{
    const snap = await getJournalRef(srcTeam, member, day).get();
    const n = Number(snap.data()?.dist ?? 0);
    return Number.isFinite(n) ? n : 0;
  }catch{ return 0; }
}

async function updateDistanceSummary(){
  const box = document.getElementById('distanceSummary');
  if (!box) return;

  const team   = teamId;
  const member = viewingMemberId || memberId;
  const base   = selDate instanceof Date ? selDate : new Date();

  if (!team || !member) {
    box.textContent = '週 走行距離: 0 km　　直近7日: 0 km';
    return;
  }

  const srcTeam = await getViewSourceTeamId(team, member);

  const ws = startOfWeek(base);
  const weekDates = Array.from({length:7}, (_,i)=> addDays(ws, i));
  const wVals = await Promise.all(weekDates.map(d => safeDayDist(srcTeam, member, d)));
  const weekSum = wVals.reduce((a,b)=> a+b, 0);

  const r0 = addDays(base, -6);
  const rDates = Array.from({length:7}, (_,i)=> addDays(r0, i));
  const rVals = await Promise.all(rDates.map(d => safeDayDist(srcTeam, member, d)));
  const r7Sum = rVals.reduce((a,b)=> a+b, 0);

  box.textContent = `週 走行距離: ${weekSum.toFixed(1)} km　　直近7日: ${r7Sum.toFixed(1)} km`;
}


document.addEventListener('DOMContentLoaded', ()=>{
  $('#datePicker')?.addEventListener('change', updateDistanceSummary);
  $('#memberSelect')?.addEventListener('change', updateDistanceSummary);
  $('#teamSwitchSelect')?.addEventListener('change', updateDistanceSummary);
  updateDistanceSummary();
});

// ===== Global Tab Swipe =====
const TAB_ORDER = ['journal','month','plans','dashboard','memo','notify'];

function getActiveTabIndex(){
  const id = document.querySelector('.tab.active')?.dataset.tab;
  return TAB_ORDER.indexOf(id);
}
function goTabDelta(delta){
  const n = TAB_ORDER.length;
  let i = getActiveTabIndex();
  if (i < 0) return;
  i = (i + delta + n) % n;
  switchTab(TAB_ORDER[i], true);
}

function isInteractive(el){
  const t = el?.tagName;
  return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el?.isContentEditable;
}
function shouldIgnoreForTabSwipe(el){
  return isInteractive(el) || el?.closest?.('#mmWrap');
}

function initGlobalTabSwipe(){
  const bar = document.getElementById('globalSwipeBar');
  const EDGE = 20;
  const THRESH = 60;
  const V_TOL  = 40;

  let SW = {active:false, fromEdge:false, x0:0, y0:0, moved:false};

  function bindArea(el){
    if (!el) return;
    el.addEventListener('touchstart', (e)=>{
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      SW = {active:true, fromEdge:false, x0:t.clientX, y0:t.clientY, moved:false};
    }, {passive:true});
    el.addEventListener('touchmove', (e)=>{
      if (!SW.active || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - SW.x0;
      const dy = t.clientY - SW.y0;
      if (Math.abs(dx) > 10 && Math.abs(dy) < V_TOL){
        e.preventDefault();
        SW.moved = true;
      }
    }, {passive:false});
    el.addEventListener('touchend', (e)=>{
      if (!SW.active) return;
      SW.active = false;
      if (!SW.moved) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - SW.x0;
      const dy = t.clientY - SW.y0;
      if (Math.abs(dx) >= THRESH && Math.abs(dy) < V_TOL){
        goTabDelta(dx < 0 ? +1 : -1);
      }
    }, {passive:true});
    el.addEventListener('wheel', (e)=>{
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 20){
        e.preventDefault();
        goTabDelta(e.deltaX > 0 ? +1 : -1);
      }
    }, {passive:false});
  }

  document.addEventListener('touchstart', (e)=>{
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const x = t.clientX, y = t.clientY;
    const fromLeft  = x <= EDGE;
    const fromRight = x >= (window.innerWidth - EDGE);
    const ignore = shouldIgnoreForTabSwipe(e.target);
    if ((fromLeft || fromRight) && !ignore){
      SW = {active:true, fromEdge:true, x0:x, y0:y, moved:false};
    }else{
      SW.active = false;
    }
  }, {passive:true});
  document.addEventListener('touchmove', (e)=>{
    if (!SW.active || !SW.fromEdge || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - SW.x0;
    const dy = t.clientY - SW.y0;
    if (Math.abs(dx) > 10 && Math.abs(dy) < V_TOL){
      e.preventDefault();
      SW.moved = true;
    }
  }, {passive:false});
  document.addEventListener('touchend', (e)=>{
    if (!SW.active || !SW.fromEdge) return;
    SW.active = false;
    if (!SW.moved) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - SW.x0;
    const dy = t.clientY - SW.y0;
    if (Math.abs(dx) >= THRESH && Math.abs(dy) < V_TOL){
      goTabDelta(dx < 0 ? +1 : -1);
    }
  }, {passive:true});

  bindArea(bar);
}

async function renderNotify(){
  if (unsubscribeNotify) { try{ unsubscribeNotify(); }catch{} unsubscribeNotify=null; }

  const box = document.getElementById('notifyList');
  const empty = document.getElementById('notifyEmpty');
  if(!box) return;
  box.innerHTML = '';
  empty.style.display = 'none';

  const col = db.collection('teams').doc(teamId).collection('notifications');
  const q = col.where('to','==', viewingMemberId || memberId)
               .where('read','==', false)
               .orderBy('ts','desc');

  unsubscribeNotify = q.onSnapshot(async (snap)=>{
    box.innerHTML = '';
    if (snap.empty){
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    const toMark = [];

    snap.docs.forEach(doc=>{
      const n = doc.data();
      const div = document.createElement('div');
      div.className = 'msg';

      const at = new Date(n.ts || Date.now()).toLocaleString('ja-JP');
      const bodyHtml = (n.type === 'dayComment')
        ? (
          `<div><b>${n.day}</b> の練習にコメントがつきました（${n.from}）</div>` +
          (n.text ? `<div class="muted" style="white-space:pre-wrap;">${escapeHtml(n.text)}</div>` : ``) +
          `<div class="link" data-day="${n.day}" style="cursor:pointer; color:var(--primary); text-decoration:underline;">この日誌を開く</div>`
        )
        : `<div>通知</div>`;

      div.innerHTML = `
        <span class="date muted">${at}</span>
        <div class="body">${bodyHtml}</div>
      `;

      div.querySelector('.link')?.addEventListener('click', (e)=>{
        const day = e.currentTarget.getAttribute('data-day');
        if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)){
          selDate = parseDateInput(day);
          switchTab('journal', true);
        }
      });

      box.appendChild(div);

      toMark.push(doc.ref);
    });

    const batch = db.batch();
    toMark.forEach(ref => batch.update(ref, { read: true }));
    try{ await batch.commit(); }catch(e){ console.error('notify read commit error', e); }
  }, (err)=>{
    console.error('notify onSnapshot error', err);
    empty.style.display = 'block';
  });
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

async function createDayCommentNotifications({ teamId, from, day, text }){
  try{
    const ms = await getMembersRef(teamId).get();
    const col = db.collection('teams').doc(teamId).collection('notifications');
    const batch = db.batch();
    const ts = Date.now();

    ms.docs.forEach(m=>{
      const to = m.id;
      if (to === from) return;
      const ref = col.doc();
      batch.set(ref, {
        type:'dayComment',
        team: teamId,
        day, text, from, to,
        ts, read:false
      });
    });

    await batch.commit();
  }catch(e){
    console.error('createDayCommentNotifications error', e);
  }
}


(function consentGate(){
  const KEY = 'athlog_legal_consent_v1';
  if (!localStorage.getItem(KEY)) {
    const modal = document.getElementById('legal-consent');
    const btn = document.getElementById('btn-consent-accept');
    if (modal && btn) {
      modal.style.display = 'block';
      btn.addEventListener('click', () => {
        localStorage.setItem(KEY, 'yes');
        modal.style.display = 'none';
      });
    }
  }
})();

// app.js (ファイルの末尾に追加)
async function migrateDataFromNameToUid() {
  if (!currentUser || !teamId) {
    alert("ログイン情報が取得できません。");
    return;
  }

  const oldName = prompt("データ移行を行います。\n【重要】以前使用していた「あなたのお名前」を正確に入力してください:", currentUser.displayName);

  if (!oldName) {
    alert("名前が入力されなかったため、処理を中断しました。");
    return;
  }

  const confirmMsg = `「${oldName}」名義のデータを、現在の新しいアカウント（${currentUser.displayName}）に移行します。\n\n【注意】\n・この処理は一度しか実行できません。\n・大量のデータがある場合、少し時間がかかります。\n・処理が完了するまでこのページを閉じないでください。\n\n実行しますか？`;
  if (!confirm(confirmMsg)) {
    alert("処理を中断しました。");
    return;
  }

  const newUid = currentUser.uid;
  console.log(`Migration started: From '${oldName}' to UID '${newUid}' in team '${teamId}'`);
  alert("データ移行を開始します。完了後にお知らせします。");

  try {
    let journalCount = 0;
    let goalCount = 0;

    // --- Journal データの移行 ---
    const oldJournalRef = db.collection('teams').doc(teamId).collection('members').doc(oldName).collection('journal');
    const journalSnapshot = await oldJournalRef.get();

    if (!journalSnapshot.empty) {
      const batch = db.batch();
      journalSnapshot.forEach(doc => {
        const newDocRef = db.collection('teams').doc(teamId).collection('members').doc(newUid).collection('journal').doc(doc.id);
        batch.set(newDocRef, doc.data());
        journalCount++;
      });
      await batch.commit();
      console.log(`${journalCount} journal entries migrated.`);
    }

    // --- Goals データの移行 ---
    const oldGoalsRef = db.collection('teams').doc(teamId).collection('members').doc(oldName).collection('goals');
    const goalsSnapshot = await oldGoalsRef.get();

    if (!goalsSnapshot.empty) {
      const batch = db.batch();
      goalsSnapshot.forEach(doc => {
        const newDocRef = db.collection('teams').doc(teamId).collection('members').doc(newUid).collection('goals').doc(doc.id);
        batch.set(newDocRef, doc.data());
        goalCount++;
      });
      await batch.commit();
      console.log(`${goalCount} goal entries migrated.`);
    }

    alert(`移行が完了しました。\n\n・日誌: ${journalCount}件\n・目標: ${goalCount}件\n\nページをリロードしてデータが反映されているか確認してください。`);
    window.location.reload();

  } catch (error) {
    console.error("Data migration failed:", error);
    alert("データ移行中にエラーが発生しました。コンソールログを確認してください。");
  }
}



