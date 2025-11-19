
// ===== Firebase Initialization =====
// あるなら残してOK（ガード必須）。無ければ何も書かなくて良い。
if (!firebase.apps || !firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();


// ===== Utilities =====
const $  = (q, el = document) => el.querySelector(q);
const $$ = (q, el = document) => Array.from(el.querySelectorAll(q));

function ymd(d){
  // ローカル日付→UTCずれ防止
  const date = new Date(d.getTime() - d.getTimezoneOffset()*60000);
  return date.toISOString().slice(0,10);
}
function parseDateInput(value){
  // "YYYY-MM-DD" をローカル時刻の Date に（Safari/時差ずれ対策）
  const [y,m,d] = value.split("-").map(Number);
  return new Date(y, (m||1)-1, d||1);
}
function startOfWeek(d){ const x=new Date(d); const day=(x.getDay()+6)%7; x.setDate(x.getDate()-day); x.setHours(0,0,0,0); return x; }
function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
function getMonthStr(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; }
function endOfMonth(d){ return new Date(d.getFullYear(), d.getMonth()+1, 0); }
function getWeekDates(d){ const s=startOfWeek(d); return [...Array(7).keys()].map(i=>addDays(s,i)); }

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

// --- マルチタッチ管理（2本以上は塗らないでピンチに委ねる）---
const MT = { pointers: new Set() };

function setOverlayTouchAction(mode){
  const ov = document.getElementById('mmOverlay');
  if (ov) ov.style.touchAction = mode;   // 'none' | 'auto' | 'pan-x pan-y pinch-zoom'
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

function getDisplayName(memId){
  return memberNameMap[memId] || memId;
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
// ===== 修正案 1 =====
//
async function applyMirrorFlagsForUser(user, mainTeam){
  const myTeams=getProfiles().filter(p=>p.member===user).map(p=>p.team);
  
  // 1. メインチームの「自分」の名前を取得（サブチームに同期するため）
  let myNameInMainTeam = user; // デフォルトはID
  try {
    const mainMemberSnap = await getMembersRef(mainTeam).doc(user).get();
    if (mainMemberSnap.exists) {
      myNameInMainTeam = mainMemberSnap.data()?.name || user;
    }
  } catch (e) {
    console.error("Failed to get name from main team", e);
  }

  // 2. 自分が所属する全チームの「自分のドキュメント」だけを更新
  for(const t of myTeams){
    const memberRef = getMembersRef(t).doc(user);
    
    if(t === mainTeam){
      // メインチームの場合： mirrorFromTeamId を削除
      // （名前はメインチームのものなので変更しない）
      await memberRef.set({ 
        mirrorFromTeamId: firebase.firestore.FieldValue.delete() 
      }, { merge: true });
      
    }else{
      // サブチームの場合：
      // 1. mirrorFromTeamId を設定
      // 2. 名前をメインチームのものに同期
      await memberRef.set({ 
        mirrorFromTeamId: mainTeam,
        name: myNameInMainTeam 
      }, { merge: true });
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

// ===== Insight helpers =====
async function getPeriodStats({ teamId, memberId, start, end }){
  let distance=0, fatigueScore=0, condSum=0, condCount=0;
  const tagCount={};
  for(let d=new Date(start); d<=end; d=addDays(d,1)){
    const snap=await getJournalRef(teamId, memberId, d).get();
    if(!snap.exists) continue;
    const j=snap.data()||{};
    distance += Number(j.dist||0);
    if(j.regions && typeof j.regions==='object'){
      fatigueScore += Object.values(j.regions).reduce((a,v)=>a+(Number(v)||0),0);
    }
    if(Array.isArray(j.tags)) j.tags.forEach(t => { tagCount[t]=(tagCount[t]||0)+1; });
    if(typeof j.condition === 'number'){ condSum+=j.condition; condCount++; }
  }
  const topTags = Object.entries(tagCount).sort((a,b)=>b[1]-a[1]).slice(0,2).map(([t])=>t);
  const avgCond = condCount ? (condSum/condCount) : null;
  return { distance, fatigueScore, topTags, avgCond };
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
let selDate=new Date();
let brush={ lvl:1, erase:false };
let distanceChart=null, conditionChart=null;
let dashboardOffset=0, dashboardMode='month';
let conditionChartOffset=0;
let unsubscribePlans, unsubscribeMemo, unsubscribeMonthChat, unsubscribeJournal;
let dirty={ dist:false, train:false, feel:false };
let lastJournal=null;  // ← 追加：未宣言だったので明示
let unsubscribeNotify = null;
let memberNameMap = {};

// ===== Data Access Layer =====
const getJournalRef  = (team,member,day)=> db.collection('teams').doc(team).collection('members').doc(member).collection('journal').doc(ymd(day));
const getGoalsRef    = (team,member,month)=> db.collection('teams').doc(team).collection('members').doc(member).collection('goals').doc(month);
const getPlansCollectionRef=(team)=> db.collection('teams').doc(team).collection('plans');
const getTeamMemoCollectionRef=(team)=> db.collection('teams').doc(team).collection('memo');
const getMonthChatCollectionRef=(team,month)=> db.collection('teams').doc(team).collection('chat').doc(month).collection('messages');
const getMembersRef=(team)=> db.collection('teams').doc(team).collection('members');

// ===== UI Boot & Tab Control =====
async function showApp(){
  $("#teamLabel").textContent=teamId;
  $("#memberLabel").textContent = getDisplayName(viewingMemberId);
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");

  const __nowMon=getMonthStr(new Date());
  if($("#monthPick") && !$("#monthPick").value) $("#monthPick").value=__nowMon;
  if($("#planMonthPick") && !$("#planMonthPick").value) $("#planMonthPick").value=__nowMon;

  await populateMemberSelect();
  $("#memberLabel").textContent = getDisplayName(viewingMemberId); // Map構築後に表示名で上書き
  const memberSelect=$("#memberSelect");
  if(memberSelect) memberSelect.addEventListener('change', ()=>{
    viewingMemberId=$("#memberSelect").value;
    $("#memberLabel").textContent = getDisplayName(viewingMemberId); // ID -> 表示名
    selDate=new Date();
    const dp=$("#datePicker"); if(dp) dp.value=ymd(selDate);
    refreshBadges();
    switchTab($(".tab.active")?.dataset.tab, true);
  });

  initJournal(); initMonth(); initPlans(); initDashboard(); initMemo();

  selDate=new Date();
  const dp=$("#datePicker"); if(dp) dp.value=ymd(selDate);
  refreshBadges();
  switchTab("journal");
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

  // 以前は「1チームしか無いと非表示」でしたが、常時表示に変更
  wrap.style.display = 'flex';

  // 現在の teamId をプロフィールに確実に含めておく
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
    await populateMemberSelect();   // チームのメンバー一覧を更新
    refreshBadges();
    switchTab($(".tab.active")?.dataset.tab, true);
  };

  // ===== 修正案 2 =====
//
  if(btnAdd){
    btnAdd.onclick = async ()=>{
      const t = prompt("追加する Team ID を入力:");
      if(!t || t === teamId) return; // 空や現在のチームは無視
      upsertProfile(t, memberId);
      teamId = t; // 新しいチームIDに切り替え
      localStorage.setItem("athlog:last", JSON.stringify({ team:teamId, member:memberId }));
      $("#teamLabel").textContent = teamId;

      // ▼▼▼ 修正 ▼▼▼
      const myMainTeam = getMainTeamOf(memberId);
      if (!myMainTeam) {
          alert("メインチームが設定されていません。一度メインチームにログインし直してください。");
          return;
      }
      
      // [削除] 以前の全メンバー同期処理
      // await applyMirrorFlagsForUser(memberId, myMainTeam);
      
      // [追加] 自分だけをサブチームにミラー設定付きで追加
      // ※ メインチームでの自分の名前を取得して設定する
      let myNameInMainTeam = memberId;
      try {
        const mainMemberSnap = await getMembersRef(myMainTeam).doc(memberId).get();
        if (mainMemberSnap.exists) {
          myNameInMainTeam = mainMemberSnap.data()?.name || memberId;
        }
      } catch (e) {}

      await getMembersRef(teamId).doc(memberId).set({ 
          name: myNameInMainTeam, // メインチームでの名前
          mirrorFromTeamId: myMainTeam 
      }, { merge: true });
      // ▲▲▲ 修正 ▲▲▲

      await populateMemberSelect(); // サブチームのメンバー一覧（＋自分）を再読込
      refreshBadges();
      initTeamSwitcher(); // セレクトを再生成
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


function switchTab(id, forceRender=false){
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
  if(id==="journal") renderJournal();
  if(id==="month") renderMonth();
  if(id==="plans") renderPlans();
  if(id==="dashboard") renderDashboard();
  if(id==="memo"){ renderMemo(); markMemoRead(); }
  if(id==="notify"){ renderNotify(); } 
}

// ===== Login & Logout =====
$("#logoutBtn")?.addEventListener("click", ()=>{
  localStorage.removeItem("athlog:last");
  teamId=null; memberId=null; viewingMemberId=null;
  window.location.reload();
});
$$(".tab").forEach(b=>b.addEventListener("click",()=>switchTab(b.dataset.tab)));

// ----- 旧SVG（存在しない場合は即return）-----
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

// 入力の自動保存（デバウンス）
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
}
function initJournal(){
  const scheduleAutoSave = makeJournalAutoSaver(700);
  $("#distInput")?.addEventListener("input", ()=>{ dirty.dist=true; scheduleAutoSave(); renderWeek(); });
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
    renderWeek();
  }));

  $("#weekPrev")?.addEventListener("click",()=>{ selDate=addDays(selDate,-7); renderJournal(); });
  $("#weekNext")?.addEventListener("click",()=>{ selDate=addDays(selDate, 7); renderJournal(); });
  $("#gotoToday")?.addEventListener("click",()=>{ selDate=new Date(); renderJournal(); });
  $("#datePicker")?.addEventListener("change",(e)=>{ selDate=parseDateInput(e.target.value); renderJournal(); });

  $("#mergeBtn")?.addEventListener("click", async ()=>{
    const scope  = $("#mergeScope").value;                // auto / 自分 / team
    const tagCSV = ($("#mergeTagFilter")?.value || "").trim();
  
    const text  = await collectPlansTextForDay(selDate, scope, tagCSV);
    if(text){
      $("#trainInput").value = ($("#trainInput").value ? ($("#trainInput").value+"\n") : "") + text;
    }
  
    // タグで絞った types を日誌タグへ最大2つ反映（任意）
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

  initMuscleMap();       // ← 新筋マップ
  initRegionMap();       // ← 旧SVG（存在しなければ何もしない）
  initJournalSwipeNav();
}


// ===== Journal: 左右スワイプで日付移動 =====
function initJournalSwipeNav(){
  const root = document.getElementById('journal');
  if (!root) return;

  const isEditableEl = (el) => {
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  };

  const shouldIgnore = (el) => {
    // 筋マップや入力系の上ではスワイプで日付移動しない
    return el.closest?.('#mmWrap') || isEditableEl(el);
  };

  const SW = { x0:0, y0:0, active:false, moved:false };
  const THRESH = 50;   // 横方向の発火しきい値(px)
  const V_TOL  = 40;   // 縦方向の許容ズレ(px)

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
      // 横スワイプの意図が明確ならスクロールを止める
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
      // 右→左にスワイプ（dx<0）で翌日、左→右（dx>0）で前日
      selDate = addDays(selDate, dx < 0 ? +1 : -1);
      const dp = document.getElementById('datePicker');
      if (dp) dp.value = ymd(selDate);
      renderJournal();
    }
  }, { passive:true });

  // デスクトップの横スクロール（トラックパッド）にも対応
  root.addEventListener('wheel', (e)=>{
    // 入力中 or キャンバス上は無視
    if (shouldIgnore(e.target)) return;

    // 横方向の意図が強いときだけ
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 20) {
      e.preventDefault();
      selDate = addDays(selDate, e.deltaX > 0 ? +1 : -1);
      const dp = document.getElementById('datePicker');
      if (dp) dp.value = ymd(selDate);
      renderJournal();
    }
  }, { passive:false });
}


// 週合計と「直近7日」を“下の表示(#weekSum)”だけに出す完成版
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
       <option value="${memberId}">${getDisplayName(memberId)}の予定</option>
       <option value="team">全員の予定</option>`;
  }

  $("#datePicker").value = ymd(selDate);

  // --- 下部の距離表示を更新するヘルパ ---
  async function recent7Km(d){
    const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
    let s = 0;
    for (let i = 6; i >= 0; i--) {
      const dt  = addDays(d, -i);
      const doc = await getJournalRef(srcTeam, viewingMemberId, dt).get();
      if (doc.exists) s += Number(doc.data().dist || 0);
    }
    return s;
  }


  await renderWeek();           // 週チップ描画（内部でも週合計を更新するが）

  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
  unsubscribeJournal = getJournalRef(srcTeam, viewingMemberId, selDate).onSnapshot(doc=>{
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

    // 日誌の変更が入ったら下の距離表示も更新
    updateDistanceSummary();
  });
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

async function rolling7Km(d){
  // dの週と同じ終了日基準（現在の選択日の0:00を終端とする）
  const end=new Date(d); end.setHours(0,0,0,0);
  const start=addDays(end,-6);
  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
  let s=0;
  for(let dt=new Date(start); dt<=end; dt=addDays(dt,1)){
    const doc=await getJournalRef(srcTeam, viewingMemberId, dt).get();
    if(doc.exists) s+=Number(doc.data().dist||0);
  }
  return s;
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
// monthGoalInput が存在する時だけ触る（存在しないページ構成でも安全）
  const goalInputEl = document.getElementById("monthGoalInput");
  if (goalInputEl) goalInputEl.disabled = !editableHere;
  // 保存ボタンはUIから削除したので、参照もしない
  

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
    const dayKey = ymd(dt); // ← 追加：この日のキー
    const dow = ["SU","MO","TU","WE","TH","FR","SA"][dt.getDay()];
  
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="dow" id="dow_${dayKey}"> <span>${dow}${d}</span>
      </div>
      <div class="txt"><div>—</div></div>
    `;
    row.addEventListener("click", () => { selDate = dt; switchTab("journal"); });
    box.appendChild(row);
  
    // ← 以降は同じ非同期読み込みだが、dayKey をキャプチャして使う
    (async (dtLocal, key) => {
      try {
        const snap = await getJournalRef(srcTeam, viewingMemberId, dtLocal).get();
        const j = snap.data() || {};
  
        // 合計距離の更新（既存処理をそのまま）
        const add = Number(j.dist || 0);
        if (!Number.isNaN(add)) {
          sum += add;
          const sumEl = document.getElementById("monthSum");
          if (sumEl) sumEl.textContent = `月間走行距離: ${sum.toFixed(1)} km`;
        }

       // ── 縦色ラベル（typebar）の色反映（文字タグは出さない） ──
        const dowEl = document.getElementById(`dow_${key}`); // typebar -> dowEl
        const tags = Array.isArray(j.tags) ? j.tags.slice(0, 2) : [];
        const colorMap = {
          ジョグ:   'var(--q-jog)',
          ポイント: 'var(--q-point)',
          補強:     'var(--q-sup)',
          オフ:     'var(--q-off)',
          その他:   'var(--q-other)'
        };
        if (dowEl) { // typebar -> dowEl
          if (tags.length === 0) {
            dowEl.style.background = 'var(--panel)'; // デフォルト色（背景色と同じ）
          } else if (tags.length === 1) {
            dowEl.style.background = colorMap[tags[0]] || 'var(--panel)';
            dowEl.style.color = '#1f2937'; // 色がついたら文字を濃くする
          } else {
            const c1 = colorMap[tags[0]] || 'var(--panel)';
            const c2 = colorMap[tags[1]] || 'var(--panel)';
            dowEl.style.background = `linear-gradient(${c1} 0 50%, ${c2} 50% 100%)`; // 上下分割
            dowEl.style.color = '#1f2937'; // 色がついたら文字を濃くする
          }
        }
  
        // コンディション表示と本文（タグ文字は出さない）
        const cond = (j.condition != null) ? Number(j.condition) : null;
        const condHtml = (cond && cond >= 1 && cond <= 5)
          ? `<span class="cond-pill cond-${cond}">${cond}</span>`
          : `<span class="cond-pill cond-3" style="opacity:.4">–</span>`;
  
        // コンディション表示と本文
        const txt = row.querySelector(".txt");
        if (txt) {
          txt.innerHTML = `
            <div class="month-one-line">
              <span class="km">${j.dist ? ` / ${j.dist}km` : ""}</span><span class="month-train-ellipsis">${(j.train || "—")}</span>
              ${condHtml}
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
  div.innerHTML=`<span class="name">${getDisplayName(m.mem)}</span><span class="txt">${m.txt}</span><span class="muted">  ${time}</span>`;
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
    <option value="${viewingMemberId}">${getDisplayName(viewingMemberId)}</option> 
    <option value="team">全員</option>
  `;
  // 「all」が保存されていれば viewingMemberId をデフォルトにする
  select.value= (currentVal && currentVal !== 'all') ? currentVal : viewingMemberId;
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

    const unsub = getPlansCollectionRef(srcTeam).doc(dayKey).collection('events').orderBy('mem')
      .onSnapshot(snapshot=>{
        const scope=$("#planScope")?.value || viewingMemberId; // "all" から変更
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
      div.innerHTML=`<span class="name">${getDisplayName(m.mem)}</span><span class="txt">${m.txt}</span><span class="muted">  ${time}</span>`;
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
        <select id="pscope" class="form-control"><option value="self">${getDisplayName(memberId)}</option><option value="team">全員</option></select>
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
  getPlansCollectionRef(teamId).doc(dayKey).collection('events').orderBy('mem').get().then(snapshot=>{
    if(snapshot.empty){ cont.innerHTML='<div class="muted" style="text-align:center;">予定はありません</div>'; return; }
    snapshot.docs.forEach((doc,i)=>{
      const x=doc.data();
      const isMyPlan=x.mem===memberId;
      const row=document.createElement("div"); row.className="row";
      let ownerText=x.scope==='team' ? ' (全員)' : ` (${getDisplayName(x.mem)})`;
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

// 予定本文取り込み（内容だけを返す：編集者名や種別は付けない）
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
    if (content) lines.push(content);     // ← 内容だけを集める
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

// それぞれのグラフのスクロール位置（0=最新側）
const distOffset = { day: 0, week: 0, month: 0 };

// ===== Dashboard =====
function initDashboard(){
  const toggleBtn=$("#distChartToggle");
  const prevBtn=$("#distChartPrev");
  const nextBtn=$("#distChartNext");
  if(toggleBtn) toggleBtn.addEventListener('click',()=>{
    dashboardMode = (dashboardMode==='month') ? 'week' : (dashboardMode==='week') ? 'day' : 'month';
    dashboardOffset=0;
    renderDashboard();
  });
  if(prevBtn) prevBtn.addEventListener('click',()=>{ dashboardOffset--; renderDashboard(); });
  if(nextBtn) nextBtn.addEventListener('click',()=>{ dashboardOffset++; renderDashboard(); });

  const condPrevBtn=$("#condChartPrev");
  const condNextBtn=$("#condChartNext");
  if(condPrevBtn) condPrevBtn.addEventListener('click',()=>{ conditionChartOffset-=7; renderConditionChart(); });
  if(condNextBtn) condNextBtn.addEventListener('click',()=>{ conditionChartOffset+=7; renderConditionChart(); });
  document.getElementById('distDayPrev')  ?.addEventListener('click', ()=>{ distOffset.day--;   renderAllDistanceCharts(); });
  document.getElementById('distDayNext')  ?.addEventListener('click', ()=>{ distOffset.day++;   renderAllDistanceCharts(); });

  document.getElementById('distWeekPrev') ?.addEventListener('click', ()=>{ distOffset.week--;  renderAllDistanceCharts(); });
  document.getElementById('distWeekNext') ?.addEventListener('click', ()=>{ distOffset.week++;  renderAllDistanceCharts(); });

  document.getElementById('distMonthPrev')?.addEventListener('click', ()=>{ distOffset.month--; renderAllDistanceCharts(); });
  document.getElementById('distMonthNext')?.addEventListener('click', ()=>{ distOffset.month++; renderAllDistanceCharts(); });
}
function renderDashboard(){ renderAllDistanceCharts(); renderConditionChart(); }
async function renderDistanceChart(){
  const cvs=document.getElementById('distanceChart'); if(!cvs) return;
  const ctx=cvs.getContext('2d');
  const toggleBtn=$("#distChartToggle");
  if(toggleBtn) toggleBtn.textContent = (dashboardMode==='month') ? '週に切替' : (dashboardMode==='week') ? '日に切替' : '月に切替';

  const labels=[], chartData=[];
  const journalSnaps=await db.collection('teams').doc(teamId).collection('members').doc(viewingMemberId).collection('journal').get();
  const journal={}; journalSnaps.forEach(doc=>journal[doc.id]=doc.data());

  if(dashboardMode==='month'){
    $("#distChartTitle").textContent="月間走行距離グラフ";
    const monthlyTotals={};
    for(const ymdStr in journal){
      const monthStr=ymdStr.substring(0,7);
      monthlyTotals[monthStr]=(monthlyTotals[monthStr]||0)+Number(journal[ymdStr].dist||0);
    }
    const targetMonth=new Date(); targetMonth.setMonth(targetMonth.getMonth()+dashboardOffset);
    for(let i=5;i>=0;i--){
      const d=new Date(targetMonth); d.setMonth(d.getMonth()-i);
      const month=getMonthStr(d);
      labels.push(month);
      chartData.push(Number(monthlyTotals[month]||0).toFixed(1));
    }
  }else if(dashboardMode==='week'){
    $("#distChartTitle").textContent="週間走行距離グラフ";
    const today=new Date();
    const currentWeekStart=startOfWeek(today);
    const targetWeekStart=addDays(currentWeekStart, dashboardOffset*7);
    for(let i=5;i>=0;i--){
      const weekStart=addDays(targetWeekStart, -i*7);
      labels.push(`${ymd(weekStart).slice(5)}~`);
      let weeklyTotal=0;
      for(let j=0;j<7;j++){
        const day=addDays(weekStart,j);
        const dayData=journal[ymd(day)];
        if(dayData) weeklyTotal+=Number(dayData.dist||0);
      }
      chartData.push(weeklyTotal.toFixed(1));
    }
  }else{
    $("#distChartTitle").textContent="日別走行距離グラフ";
    const windowLen=14;
    const today=new Date();
    const end=addDays(today, dashboardOffset*windowLen);
    const start=addDays(end, -windowLen+1);
    for(let i=0;i<windowLen;i++){
      const d=addDays(start,i);
      labels.push(`${d.getMonth()+1}/${d.getDate()}`);
      const dayData=journal[ymd(d)];
      chartData.push(Number(dayData?.dist||0).toFixed(1));
    }
  }

  if(distanceChart) distanceChart.destroy();
  distanceChart=new Chart(ctx,{
    type:'bar',
    data:{ labels, datasets:[{ label:'走行距離 (km)', data:chartData, backgroundColor:'rgba(79,70,229,0.5)', borderColor:'rgba(79,70,229,1)', borderWidth:1 }] },
    options:{ responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true } } }
  });

  renderDashboardInsight();
}
async function renderConditionChart(){
  const ctx=$('#conditionChart')?.getContext('2d'); if(!ctx) return;
  const labels=[], chartData=[];
  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
  const journalSnaps=await db.collection('teams').doc(srcTeam).collection('members').doc(viewingMemberId).collection('journal').get();
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
  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
  const snaps=await db.collection('teams').doc(srcTeam).collection('members').doc(viewingMemberId).collection('journal').get();
  const journal={}; snaps.forEach(doc=>journal[doc.id]=doc.data());

  // === Day: 14日ウィンドウを day オフセット単位で横移動 ===
  {
    const cvs=document.getElementById('distanceChartDay');
    if(cvs){
      cvs.style.height = '180px';
      cvs.height = 180;
      const ctx=cvs.getContext('2d');
      const labels=[], data=[];
      const windowLen=14;

      // オフセット：1ステップ=14日
      const today = new Date(); today.setHours(0,0,0,0);
      const end   = addDays(today, distOffset.day * windowLen);
      const start = addDays(end, -(windowLen-1));

      for(let i=0;i<windowLen;i++){
        const d=addDays(start,i);
        labels.push(`${d.getMonth()+1}/${d.getDate()}`);
        data.push(Number(journal[ymd(d)]?.dist||0).toFixed(1));
      }

      // タイトルに期間を表示
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

  // === Week: 6週ウィンドウを 1週単位で横移動 ===
  {
    const cvs=document.getElementById('distanceChartWeek');
    if(cvs){
      const ctx=cvs.getContext('2d');
      const labels=[], data=[];
      const today=new Date(); today.setHours(0,0,0,0);
      const currentWeekStart=startOfWeek(today);

      // オフセット：1ステップ=1週間（ウィンドウの“右端の週”を動かす）
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
      const lastWeekEnd    = addDays(baseWeekStart, 6); // 右端週の+6日
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

  // === Month: 6か月ウィンドウを 1か月単位で横移動 ===
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

      // オフセット：1ステップ=1か月（右端の月を動かす）
      const base = new Date(); base.setDate(1); base.setHours(0,0,0,0);
      base.setMonth(base.getMonth() + distOffset.month);

      // 左へ5か月戻ってから6か月分
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

// ===== Boot and Login =====
window.addEventListener("hashchange",()=>{ closePlanModal(); });
(async function boot(){
  try{
    const last=JSON.parse(localStorage.getItem("athlog:last")||"{}");
    if(last.team && last.member){
      teamId=last.team; memberId=last.member; viewingMemberId=last.member;
      
      // ▼▼▼ 修正 ▼▼▼
      const myMainTeam = getMainTeamOf(memberId);
      if (!myMainTeam) {
         // 稀なケース：ローカルストレージが破損しメインチーム情報がない
         setMainTeamOf(memberId, teamId); // 現在のチームを仮のメインに
      }

      const memberRef = getMembersRef(teamId).doc(memberId);
      const memberSnap = await memberRef.get();
      const isMain = (getMainTeamOf(memberId) === teamId);
      const mirrorSource = isMain ? firebase.firestore.FieldValue.delete() : getMainTeamOf(memberId);

      if (!memberSnap.exists) {
        await memberRef.set({ 
            name: memberId,
            mirrorFromTeamId: mirrorSource
        }, { merge: true });
      } else {
        // ミラーフラグが最新か確認・更新
        const currentMirror = memberSnap.data()?.mirrorFromTeamId;
        const expectedMirror = isMain ? undefined : getMainTeamOf(memberId);
        if (currentMirror !== expectedMirror) {
            await memberRef.set({ mirrorFromTeamId: mirrorSource }, { merge: true });
        }
      }
      // ▲▲▲ 修正 ▲▲▲

      await showApp();
// ... (以下略)
      selDate=new Date();
      const dp=document.getElementById("datePicker"); if(dp) dp.value=ymd(selDate);
      renderJournal();
    }
  }catch(e){
    console.error("Failed to auto-login from saved session:", e);
    localStorage.removeItem("athlog:last");
  }
})();
async function doLogin(){
  teamId=$("#teamId").value.trim();
  memberId=$("#memberName").value.trim();
  viewingMemberId=memberId;
  if(!teamId || !memberId){ alert("Team / Member を入力"); return; }
  localStorage.setItem("athlog:last", JSON.stringify({ team:teamId, member:memberId }));
  upsertProfile(teamId,memberId);
  
  // ▼▼▼ 修正 ▼▼▼
  const myMainTeam = getMainTeamOf(memberId);
  if(!myMainTeam) {
    // この人がまだメインチームを設定したことがない
    setMainTeamOf(memberId, teamId); // 最初にログインしたチームをメインに設定
  }
  
  const memberRef = getMembersRef(teamId).doc(memberId);
  const memberSnap = await memberRef.get();
  
  // ログインしたチームが自分のメインチームか？
  const isMain = (getMainTeamOf(memberId) === teamId);
  const mirrorSource = isMain ? firebase.firestore.FieldValue.delete() : getMainTeamOf(memberId);

  if (!memberSnap.exists) {
    await memberRef.set({ 
      name: memberId, 
      mirrorFromTeamId: mirrorSource 
    }, { merge: true });
  } else {
    // 既存でもミラーフラグを更新
    await memberRef.set({ 
      mirrorFromTeamId: mirrorSource 
    }, { merge: true });
  }
  
  // もしメインチーム設定が更新されたら、全チームに反映（重いが確実）
  if (!myMainTeam) {
      await applyMirrorFlagsForUser(memberId, teamId);
  }
  // ▲▲▲ 修正 ▲▲▲

  const lg=$("#login"); if(lg){ lg.classList.add("hidden"); lg.style.display="none"; }
// ... (以下略)
  const app=$("#app"); if(app){ app.classList.remove("hidden"); }
  try{
    await showApp();
    selDate=new Date();
    const dp=document.getElementById("datePicker"); if(dp) dp.value=ymd(selDate);
    renderJournal();
  }catch(e){
    console.error("Error during app initialization:", e);
    alert("アプリの起動中にエラーが発生しました。HTMLファイルが最新でない可能性があります。");
  }
}
async function populateMemberSelect(){
  const select=$("#memberSelect"); if(!select) return;
  select.innerHTML='';
  memberNameMap = {};
  const snapshot=await getMembersRef(teamId).get();
  snapshot.docs.forEach(doc=>{
    const memId = doc.id;
    const memData = doc.data() || {};
    const memName = memData.name || memId; // name フィールドが無ければ ID を使用
    
    memberNameMap[memId] = memName; // マップに保存

    const option=document.createElement('option');
    option.value = memId; // 値は ID のまま
    option.textContent = memName;
    select.appendChild(option);
  });
  const want=viewingMemberId || memberId;
  const exists=[...select.options].some(o=>o.value===want);
  select.value=exists ? want : memberId;
  viewingMemberId=select.value;
  refreshBadges();
}
document.addEventListener("DOMContentLoaded",()=>{
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
        <li><b>日誌</b>：日々の記録（週カレンダー、クイック分類、距離/内容/調子、AIコメント）</li>
        <li><b>月一覧</b>：月の一覧／月目標／合計距離</li>
        <li><b>予定表</b>：月の計画（自分/全員）。モーダルで追加・更新・削除</li>
        <li><b>ダッシュボード</b>：距離（週/月）・調子（直近14日）</li>
        <li><b>チームメモ</b>：LINE風。上スクロールで過去を追加読込</li>
      </ul>
      <h2>3. 日誌の使い方</h2>
      <ol>
        <li>日付操作（← → 今日へ / ピッカー）</li>
        <li>クイック分類（ジョグ/ポイント/補強/オフ/その他）※最大2つ。3つ目で古い方が外れる</li>
        <li>距離・内容・感想、調子(1〜5) を入れる → <b>この日を保存</b></li>
      </ol>
      <p>週カレンダーの色：ジョグ(水) / ポイント(橙) / 補強(緑) / オフ(灰) / その他(桃)。2つ選ぶと左右ツートン。</p>
      <h3>画像メモ</h3>
      <ul>
        <li>人体画像にペン3段階でメモ</li>
        <li>元に戻す＝最後の1本を取り消し</li>
        <li>消しゴム＝<b>1タップで1本消える</b>（スマホ対応）</li>
      </ul>
      <h2>4. 月一覧</h2>
      <ul>
        <li>月ピッカーで切替・行クリックで該当日を日誌で開く</li>
        <li>月間合計距離が右上に自動更新、月間目標は編集→保存</li>
      </ul>
      <h2>5. 予定表</h2>
      <ul>
        <li>日クリックで編集モーダル。種別/対象(自分or全員)/タグ/内容</li>
        <li>右肩でスコープ＆タグフィルタ</li>
        <li>日誌の「反映」で計画を本文に取り込み可</li>
      </ul>
      <h2>6. ダッシュボード & メモ</h2>
      <ul>
        <li>距離：日/週/月切替・左右で期間移動</li>
        <li>調子：直近14日</li>
        <li>メモ：下に新着、上スクロールで過去</li>
      </ul>
      <h2>7. 困ったとき</h2>
      <ul>
        <li>編集できない→右上の表示中メンバーが自分か確認</li>
        <li>色が変わらない→その日を保存</li>
      </ul>
    `;
  }

  $("#openHelpBtn")?.addEventListener("click",()=>{ $("#helpOverlay")?.classList.remove("hidden"); });
  $("#helpClose")?.addEventListener("click",()=>{ $("#helpOverlay")?.classList.add("hidden"); });
  $("#helpOverlay")?.addEventListener("click",(e)=>{ if(e.target.id==="helpOverlay") e.currentTarget.classList.add("hidden"); });
  window.addEventListener("keydown",(e)=>{ if(e.key==="Escape") $("#helpOverlay")?.classList.add("hidden"); });
});

function renderDashboardInsight(){ /* optional */ }

// ===== Muscle-map (overlay/barrier) =====
const MM = {
  IMG_CANDIDATES: ['human.webp','./human.webp','./assets/human.webp'],
  VIEW: 'single',                 // 'single' | 'front' | 'back'
  LEVELS:{ 1:[199,210,254,210], 2:[253,186,116,210], 3:[239,68,68,210] },
  TH_LINE: 130,                   // 線抽出しきい値（小さいほど濃い線のみ）
  DILATE: 2,                      // 膨張回数（線を太らせる）
  FRAME: 3,                       // 外枠を壁にする幅（px）
  TOL: 22,                        // フィル許容
  MAX_REGION_FRAC: 0.25,          // これ以上の巨大領域は塗らない（画像の25%）
  MIN_REGION_PX: 25               // これ未満の極小領域は無視
};
let mm = { base:null, overlay:null, barrier:null, bctx:null, octx:null, wctx:null, ready:false };

// 画像ロード（候補順）
function tryLoadImageSequential(srcs){
  return new Promise((resolve,reject)=>{
    const img=new Image(); let i=0;
    img.onload=()=>resolve(img);
    img.onerror=()=>{ i++; (i<srcs.length)? img.src=srcs[i] : reject(new Error('image not found')); };
    img.src=srcs[i];
  });
}

// 使い捨てキャンバス
let __tmpC=null, __tmpX=null;
function tmpCtx(w,h){
  if(!__tmpC){ __tmpC=document.createElement('canvas'); __tmpX=__tmpC.getContext('2d', { willReadFrequently: true }); }
  __tmpC.width=w; __tmpC.height=h;
  return __tmpX;
}

// ベースから“壁”を作る（線＋外枠＋外側全面）
function makeBarrierFromBase(){
  const w=mm.base.width, h=mm.base.height;
  const t=tmpCtx(w,h);
  t.clearRect(0,0,w,h);
  t.drawImage(mm.base,0,0);

  const src=t.getImageData(0,0,w,h); const s=src.data;
  const out=mm.wctx.createImageData(w,h); const d=out.data;

  // 1) 濃い線を壁に
  for(let i=0;i<s.length;i+=4){
    const g=0.299*s[i]+0.587*s[i+1]+0.114*s[i+2];
    d[i]=d[i+1]=d[i+2]=0;
    d[i+3]=(g<MM.TH_LINE)?255:0;
  }

  // 2) 線を太らせて隙間を埋める
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

  // 3) 枠を壁に
  for(let f=0; f<MM.FRAME; f++){
    for(let x=0;x<w;x++){ d[((0*w+x)<<2)+3]=255; d[(((h-1-f)*w+x)<<2)+3]=255; }
    for(let y=0;y<h;y++){ d[((y*w+0)<<2)+3]=255; d[((y*w+(w-1-f))<<2)+3]=255; }
  }

  // 4) 外側全域を壁に（四隅から塗りつぶし）
  blockOutsideAsBarrier(d,w,h);

  mm.wctx.putImageData(out,0,0);
}

// 外側すべてをバリア化（四隅から探索）
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
    if(alphaData[idxA(x,y)]>0) continue; // 既に壁
    alphaData[idxA(x,y)]=255;            // 外側→壁
    st.push(si-1, si+1, si-w, si+w);
  }
}

function barrierAlphaAt(x,y){
  return mm.wctx.getImageData(x, y, 1, 1).data[3];
}

// キャンバス座標（CSSスケール補正）
function mmPixPos(canvas,e){
  const r=canvas.getBoundingClientRect();
  return {
    x: Math.floor((e.clientX - r.left) * (canvas.width  / r.width)),
    y: Math.floor((e.clientY - r.top)  * (canvas.height / r.height))
  };
}

// 事前に「この起点から塗れるピクセル数」を数える（実際には塗らない）
function measureFillRegion(octx,wctx,sx,sy){
  const w=octx.canvas.width, h=octx.canvas.height;
  const o=octx.getImageData(0,0,w,h).data;
  const b=wctx.getImageData(0,0,w,h).data;
  const A_STOP=10;
  const stack=[(sy<<16)|sx];
  const seen=new Uint8Array(w*h);
  const within=(x,y)=>x>=0&&y>=0&&x<w&&y<h;
  const idx=(x,y)=>((y*w+x)<<2);
  let cnt=0;
  while(stack.length){
    const p=stack.pop();
    const x=p & 0xffff, y=p>>>16;
    if(!within(x,y)) continue;
    const si=y*w+x;
    if(seen[si]) continue; seen[si]=1;
    const i=idx(x,y);
    if(b[i+3]>A_STOP) continue;   // 壁
    if(o[i+3]>A_STOP) continue;   // 既に塗り
    cnt++;
    stack.push((y<<16)|(x-1),(y<<16)|(x+1),((y-1)<<16)|x,((y+1)<<16)|x);
  }
  return cnt;
}

// 面塗り（大面積/極小面ガードつき）
function floodFill(octx,wctx,sx,sy,tol,rgba){
  const w=octx.canvas.width, h=octx.canvas.height;
  const maxArea = Math.floor(w*h*MM.MAX_REGION_FRAC);
  const tryArea = measureFillRegion(octx,wctx,sx,sy);
  if (tryArea < MM.MIN_REGION_PX) return;
  if (tryArea > maxArea)         return;

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
    if(bd[i+3]>A_STOP) continue;   // 壁
    if(od[i+3]>A_STOP) continue;   // 既に塗り

    od[i]=rgba[0]; od[i+1]=rgba[1]; od[i+2]=rgba[2]; od[i+3]=rgba[3];

    stack.push((y<<16)|(x-1),(y<<16)|(x+1),((y-1)<<16)|x,((y+1)<<16)|x);
  }
  octx.putImageData(o,0,0);
}

// 消し（面で）
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

// DataURL 描画
function drawDataURL(ctx,url){
  return new Promise(res=>{
    if(!url) return res();
    const im=new Image();
    im.onload=()=>{ ctx.drawImage(im,0,0); res(); };
    im.src=url;
  });
}

// Firestore → キャンバス
function drawMuscleFromDoc(j){
  if(!mm.octx || !mm.wctx) return;
  mm.octx.clearRect(0,0,mm.octx.canvas.width, mm.octx.canvas.height);
  mm.wctx.clearRect(0,0,mm.wctx.canvas.width, mm.wctx.canvas.height);
  if(j?.mmBarrierPng){ drawDataURL(mm.wctx, j.mmBarrierPng).then(()=>{}); }
  else{ makeBarrierFromBase(); }
  if(j?.mmOverlayWebp){ drawDataURL(mm.octx, j.mmOverlayWebp).then(()=>{}); }
}

// 保存（旧キー削除は可能な時だけ）
async function saveMuscleLayerToDoc(){
  const docRef=getJournalRef(teamId,memberId,selDate);
  const overlayWebp = mm?.octx ? mm.octx.canvas.toDataURL('image/webp',0.65) : null;
  const stats       = analyzeOverlay(mm.octx);
  const payload     = { mmOverlayWebp: overlayWebp, mmStats: stats };
  try{
    if(firebase?.firestore?.FieldValue?.delete){
      payload.mmBarrierPng = firebase.firestore.FieldValue.delete();
    }
  }catch(_){}
  await docRef.set(payload,{merge:true});
}

// 統計（任意）
function analyzeOverlay(octx){
  if(!octx) return {lv1:0,lv2:0,lv3:0,total:0};
  const w=octx.canvas.width, h=octx.canvas.height;
  const im=octx.getImageData(0,0,w,h).data;
  const C=[MM.LEVELS[1],MM.LEVELS[2],MM.LEVELS[3]];
  const S=[0,0,0];
  for(let y=0;y<h;y+=2){
    for(let x=0;x<w;x+=2){
      const i=(y*w+x)*4, a=im[i+3];
      if(a<10) continue;
      let best=-1, dist=1e9;
      for(let k=0;k<3;k++){
        const c=C[k]; const d=(im[i]-c[0])**2+(im[i+1]-c[1])**2+(im[i+2]-c[2])**2;
        if(d<dist){ dist=d; best=k; }
      }
      if(best>=0) S[best]++;
    }
  }
  return { lv1:S[0], lv2:S[1], lv3:S[2], total:S[0]+S[1]+S[2] };
}

// ===== 初期化（ここにだけイベントを生やす！） =====
function initMuscleMap(){
  mm.base   = document.getElementById('mmBase');
  mm.overlay= document.getElementById('mmOverlay');
  mm.barrier= document.getElementById('mmBarrier');
  if(!mm.base || !mm.overlay || !mm.barrier) return;

  mm.bctx = mm.base.getContext('2d', { willReadFrequently: true });
  mm.octx = mm.overlay.getContext('2d', { willReadFrequently:true });
  mm.wctx = mm.barrier.getContext('2d', { willReadFrequently: true });

  tryLoadImageSequential(MM.IMG_CANDIDATES).then(img=>{
    // single: 全体 / front/back: 左右半分
    const fullW=img.naturalWidth, fullH=img.naturalHeight;
    const halfW=Math.floor(fullW/2);
    const crop = (MM.VIEW==='front') ? {sx:0,     sy:0, sw:halfW, sh:fullH}
               : (MM.VIEW==='back')  ? {sx:halfW, sy:0, sw:halfW, sh:fullH}
               :                       {sx:0,     sy:0, sw:fullW, sh:fullH};

    // 実キャンバスサイズ
    [mm.base, mm.overlay, mm.barrier].forEach(c=>{ c.width=crop.sw; c.height=crop.sh; });

    // ベースへ描画（表示は<img>任せ／これは解析用）
    mm.bctx.clearRect(0,0,crop.sw,crop.sh);
    mm.bctx.drawImage(img, crop.sx,crop.sy,crop.sw,crop.sh, 0,0,crop.sw,crop.sh);

    // ラッパのアスペクト比を画像に合わせる（ズレ防止）
    const wrap = document.getElementById('mmWrap') || document.querySelector('.canvas-wrap');
    if(wrap) wrap.style.aspectRatio = `${crop.sw} / ${crop.sh}`;

    // 壁生成
    makeBarrierFromBase();
    mm.ready=true;

    // 既存の保存があれば反映
    drawMuscleFromDoc(lastJournal);
  }).catch(err=>{
    console.error(err);
    mm.bctx.fillStyle='#f1f5f9';
    mm.bctx.fillRect(0,0,mm.base.width, mm.base.height);
  });

  // === マルチタッチ：2本指以上はピンチ/スクロール、1本指のみ塗る ===
  const activePointers = new Set();
  const ov = mm.overlay;

  // 既定はピンチOKにしておく。単指描画時だけ 'none' へ。
  ov.style.touchAction = 'pan-x pan-y pinch-zoom';

  function setOverlayTouchAction(mode){
    ov.style.touchAction = mode; // 'none' | 'pan-x pan-y pinch-zoom' | 'auto'
  }

  function onPointerDown(e){
    ov.setPointerCapture?.(e.pointerId);
    activePointers.add(e.pointerId);

    // 2本以上 → ピンチ優先（塗らない）
    if(e.pointerType==='touch' && activePointers.size>=2){
      setOverlayTouchAction('pan-x pan-y pinch-zoom');
      return;
    }

    // 単指 → スクロール抑止し描画
    setOverlayTouchAction('none');
    if(!isEditableHere(teamId,memberId,viewingMemberId)) return;

    const p=mmPixPos(ov,e);
    // 壁（外側/輪郭/枠）は反応しない
    if (barrierAlphaAt(p.x,p.y) > 10) return;

    if(brush.erase){
      floodErase(mm.octx, mm.wctx, p.x, p.y);
    }else{
      floodFill(mm.octx, mm.wctx, p.x, p.y, MM.TOL, MM.LEVELS[brush.lvl||1]);
    }
    saveMuscleLayerToDoc();
  }
  function onPointerEnd(e){
    ov.releasePointerCapture?.(e.pointerId);
    activePointers.delete(e.pointerId);
    if(activePointers.size===0){
      setOverlayTouchAction('pan-x pan-y pinch-zoom');
    }
  }

  ov.addEventListener('pointerdown',   onPointerDown,      { passive:true });
  ov.addEventListener('pointerup',     onPointerEnd,       { passive:true });
  ov.addEventListener('pointercancel', onPointerEnd,       { passive:true });
  ov.addEventListener('pointerleave',  onPointerEnd,       { passive:true });

  // リサイズで再描画
  window.addEventListener('resize', ()=> drawMuscleFromDoc(lastJournal));
}

/* ===========================
 * ログイン注意文（ログイン画面に1回だけ表示）
 * =========================== */
(function addLoginNoteOnce(){
  // ログインボタンのIDは index.html で定義されているものに合わせる
  var startBtn = document.getElementById('loginBtn');
  if (!startBtn) return;
  if (document.querySelector('.login-note')) return; // 重複防止
  var p = document.createElement('p');
  p.className = 'login-note';
  p.innerHTML =
    '※ 次回以降は自動ログインとなります。<br>' +
    '※ チーム名と名前は<strong>完全一致</strong>が必要です（スペースや全角・半角にご注意ください）。';
  startBtn.insertAdjacentElement('afterend', p);
})();

/* ちょいスタイル（必要なら style.css に移動可） */
(function injectLoginNoteStyle(){
  if (document.getElementById('loginNoteStyle')) return;
  var css = '.login-note{font-size:12px;color:#6b7280;margin-top:8px;line-height:1.6}'+
            '.comment-box{margin-top:12px;padding:10px;border:1px solid #e5e7eb;border-radius:6px;background:#fafafa}'+
            '#daynote-text{width:100%;padding:8px;border:1px solid #e5e7eb;border-radius:6px;resize:vertical}'+
            '.muted{color:#6b7280}';
  var s = document.createElement('style');
  s.id = 'loginNoteStyle';
  s.appendChild(document.createTextNode(css));
  document.head.appendChild(s);
})();

/* ===========================
 * 日誌ページ：日付×人ごとの1欄を自動保存（Firestore v8）
 * =========================== */
(function dayNotePerDatePerMember(){
  // Firestore 未ロードの画面では無視
  if (!(window.firebase && firebase.firestore)) return;
  var db = firebase.firestore();

  // ---- ユーティリティ ----
  function getDateKey(){
    var inp = document.getElementById('datePicker');
    var val = inp && inp.value;
    if (val && /^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth()+1).padStart(2,'0');
    var day = String(d.getDate()).padStart(2,'0');
    return y + '-' + m + '-' + day;
  }
  function getText(el){ return (el && (el.textContent || el.value || '')).trim() || ''; }
  function sanitizeId(s){ return String(s).replace(/[\/#?[\]\s]+/g,'_').slice(0,120); }

  function getTeam(){
    try {
      return getText(document.getElementById('teamLabel')) ||
             getText(document.getElementById('teamId')) ||
             (JSON.parse(localStorage.getItem('athlog_user')||'{}').team || '');
    } catch(e){ return ''; }
  }
  function getMember(){
    try {
      return getText(document.getElementById('memberLabel')) ||
             getText(document.getElementById('memberName')) ||
             (JSON.parse(localStorage.getItem('athlog_user')||'{}').name || '');
    } catch(e){ return ''; }
  }

  // ★チームも区別したい場合は true にする
  var USE_TEAM_IN_KEY = false;

  function makeDocId(){
    var dateKey = getDateKey();
    var member  = sanitizeId(getMember() || 'unknown');
    if (USE_TEAM_IN_KEY) {
      var team = sanitizeId(getTeam() || 'team');
      return team + '_' + dateKey + '_' + member;   // 例: UTokyo_2025-09-19_吉澤登吾
    }
    return dateKey + '_' + member;                  // 例: 2025-09-19_吉澤登吾
  }

  // ---- DOM 取得 ----
  var $text   = document.getElementById('daynote-text');
  var $status = document.getElementById('daynote-status');
  if (!$text || !$status) return; // 日誌タブ以外の画面では何もしない

  var currentDocId = null;
  var saveTimer = null, dirty = false;

  function setStatus(msg){ $status.textContent = msg; }

  async function loadNote(docId){
    try{
      var ref = db.collection('dayNotes').doc(docId);
      var snap = await ref.get();
      $text.value = snap.exists ? (snap.data().text || '') : '';
      setStatus('キー: ' + docId + ' ／ 参照OK');
    }catch(e){
      console.error(e);
      setStatus('キー: ' + docId + ' ／ 読み込み失敗');
    }
  }

  async function saveNote(docId, text){
    try{
      await db.collection('dayNotes').doc(docId).set(
        { text: text, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      dirty = false;
      setStatus('キー: ' + docId + ' ／ 保存済み');
    }catch(e){
      console.error(e);
      setStatus('キー: ' + docId + ' ／ 保存失敗（自動再試行）');
      setTimeout(function(){ scheduleSave(); }, 1500);
    }
  }

  function scheduleSave(){
    dirty = true;
    var docId = currentDocId || makeDocId();
    setStatus('キー: ' + docId + ' ／ 保存待ち…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function(){
      saveNote(docId, $text.value);
    }, 800); // 800ms デバウンス
  }

  function init(){
    currentDocId = makeDocId();
    loadNote(currentDocId);
  }

  // 入力で自動保存
  $text.addEventListener('input', scheduleSave);

  // 日付変更で再ロード
  var datePicker = document.getElementById('datePicker');
  if (datePicker) {
    datePicker.addEventListener('change', function(){
      currentDocId = makeDocId();
      loadNote(currentDocId);
    });
  }

  // メンバー切替（存在すれば）で再ロード
  var memberSelect = document.getElementById('memberSelect');
  if (memberSelect) {
    memberSelect.addEventListener('change', function(){
      currentDocId = makeDocId();
      loadNote(currentDocId);
    });
  }
  var teamSwitchSelect = document.getElementById('teamSwitchSelect');
  if (teamSwitchSelect) {
    teamSwitchSelect.addEventListener('change', function(){
      currentDocId = makeDocId();
      loadNote(currentDocId);
    });
  }

  // 画面離脱時：未保存があればセーブ試行
  window.addEventListener('beforeunload', function(){
    if (dirty) {
      try { saveNote(currentDocId || makeDocId(), $text.value); } catch(e){}
    }
  });

  // 実行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();


// ===== チームコメント（日付×表示中メンバー）誰でも編集可 =====
let tscDirty = false, tscTimer = null;

function tscSetStatus(msg){ const el=document.getElementById('teamSharedCommentStatus'); if(el) el.textContent=msg; }

async function tscLoad(){
  try{
    const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
    const snap = await getJournalRef(srcTeam, viewingMemberId, selDate).get();
    const text = (snap.data() || {}).teamComment || '';
    const ta = document.getElementById('teamSharedComment');
    if(ta && !tscDirty) ta.value = text; // 入力中に上書きしない
  }catch(e){
    console.error('tscLoad', e);
  }
}

async function tscSave(){
  try{
    const ta = document.getElementById('teamSharedComment');
    if(!ta) return;
    const text = ta.value;
    // ミラー先の日誌リファレンスを取得（tscRefreshでviewingMemberIdは日誌の持ち主）
    const ref  = getJournalRef(teamId, viewingMemberId, selDate);
    
    // 通知生成のため、日付キーを取得
    const dayKey = ymd(selDate); // ★追加

    // ▼ 1. コメントと投稿者IDを日誌に保存
    await ref.set({ teamComment: text, lastCommentBy: memberId }, { merge:true });
    tscDirty = false;
    tscSetStatus('保存済み');

    // ▼ 2. ★Functionsの代わりに、通知を一括生成する処理を呼び出す（ここを追加）
    // createDayCommentNotifications は app.js の末尾に既に定義されている関数
    await createDayCommentNotifications({
      teamId: teamId,
      from: memberId,           // コメントした人
      to: viewingMemberId,      // ★追加: 日誌の持ち主
      day: dayKey,              
      text: text                
    });
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
  tscTimer = setTimeout(tscSave, 700); // デバウンス
}

function tscInitOnce(){
  const ta = document.getElementById('teamSharedComment');
  if(!ta) return;
  // だれでも編集可に固定
  ta.removeAttribute('disabled');
  // 入力で自動保存
  ta.addEventListener('input', tscScheduleSave);
  // ラベルの対象名表示
  const nm = document.getElementById('tscTargetName');
  if(nm) nm.textContent = getDisplayName(viewingMemberId) || '';
}

// 画面遷移・人/日付変更時に呼ぶ
async function tscRefresh(){
  const nm = document.getElementById('tscTargetName');
  if(nm) nm.textContent = getDisplayName(viewingMemberId) || '';
  tscDirty = false;
  await tscLoad();
}

/***** ==========================
 * 週合計 / 直近7日距離 表示ブロック
 * ========================== *****/


// 画面から team / member / 選択日 を拾う（既存DOMに依存）
function getCurrentTeam(){ return ($('#teamLabel')?.textContent || $('#teamId')?.value || '').trim(); }
function getCurrentMember(){ return ($('#memberLabel')?.textContent || $('#memberName')?.value || '').trim(); }
function getSelectedDate(){
  const v = $('#datePicker')?.value;
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [Y,M,D] = v.split('-').map(Number);
    return new Date(Y, M-1, D);
  }
  const d = new Date(); d.setHours(0,0,0,0); return d;
}


// 1日ぶんの距離（数値）を取得
async function getDayDistance(team, member, day){
  try{
    const snap = await getJournalRef(team, member, day).get();
    const dist = Number(snap.data()?.dist ?? 0);
    return Number.isFinite(dist) ? dist : 0;
  }catch(_){
    return 0;
  }
}

// 週合計と直近7日合計を計算
async function calcWeekAndRolling7(team, member, baseDate){
  // 週（ISO想定：月はじまり）
  const ws = startOfWeek(baseDate);
  const weekDates = Array.from({length:7}, (_,i)=> addDays(ws,i));

  // 直近7日（baseDate含む過去6日）
  const r7Start = addDays(baseDate, -6);
  const r7Dates = Array.from({length:7}, (_,i)=> addDays(r7Start,i));

  const weekVals = await Promise.all(weekDates.map(d => getDayDistance(team,member,d)));
  const r7Vals   = await Promise.all(r7Dates.map(d => getDayDistance(team,member,d)));

  const weekSum = weekVals.reduce((a,b)=>a+b,0);
  const r7Sum   = r7Vals.reduce((a,b)=>a+b,0);
  return { weekSum, r7Sum };
}

// 表示DOMへ反映
// ==== 距離サマリ（週合計 & 直近7日）====

// 1日ぶんの距離を安全に取得
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

  // グローバル状態を直接利用
  const team   = teamId;
  const member = viewingMemberId || memberId;
  const base   = selDate instanceof Date ? selDate : new Date();

  if (!team || !member) {
    box.textContent = '週 走行距離: 0 km　　直近7日: 0 km';
    return;
  }

  // ミラー先対応
  const srcTeam = await getViewSourceTeamId(team, member);

  // 週（月曜はじまり）
  const ws = startOfWeek(base);
  const weekDates = Array.from({length:7}, (_,i)=> addDays(ws, i));
  const wVals = await Promise.all(weekDates.map(d => safeDayDist(srcTeam, member, d)));
  const weekSum = wVals.reduce((a,b)=> a+b, 0);

  // 直近7日（base 含む過去6日）
  const r0 = addDays(base, -6);
  const rDates = Array.from({length:7}, (_,i)=> addDays(r0, i));
  const rVals = await Promise.all(rDates.map(d => safeDayDist(srcTeam, member, d)));
  const r7Sum = rVals.reduce((a,b)=> a+b, 0);

  box.textContent = `週 走行距離: ${weekSum.toFixed(1)} km　　直近7日: ${r7Sum.toFixed(1)} km`;
}


// ---- イベントにぶら下げ（日時・メンバー変更時に更新）----
document.addEventListener('DOMContentLoaded', ()=>{
  $('#datePicker')?.addEventListener('change', updateDistanceSummary);
  $('#memberSelect')?.addEventListener('change', updateDistanceSummary);
  $('#teamSwitchSelect')?.addEventListener('change', updateDistanceSummary);
  updateDistanceSummary(); // 初回
});

// 任意：当日データが保存されたら更新したい場合、呼び出してください。
// 例）日誌の保存処理の末尾や onSnapshot の中で：
//    updateDistanceSummary();

// ===== Global: 端/上部スワイプでタブ移動 =====
const TAB_ORDER = ['journal','month','plans','dashboard','memo'];

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

// 入力や編集要素上は無視
function isInteractive(el){
  const t = el?.tagName;
  return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el?.isContentEditable;
}
// mmWrap など描画系の上は無視
function shouldIgnoreForTabSwipe(el){
  return isInteractive(el) || el?.closest?.('#mmWrap');
}

function initGlobalTabSwipe(){
  const bar = document.getElementById('globalSwipeBar');
  const EDGE = 20;     // 端スワイプの開始許容(px)
  const THRESH = 60;   // 発火しきい値(px)
  const V_TOL  = 40;   // 縦の許容ズレ(px)

  let SW = {active:false, fromEdge:false, x0:0, y0:0, moved:false};

  // --- 上部バー：常に対象（入力中でもタブ切替したいならここはtrueで動く）
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
        e.preventDefault(); // 横意図が明確ならスクロール阻止
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
        goTabDelta(dx < 0 ? +1 : -1); // ←→で順送り
      }
    }, {passive:true});

    // トラックパッド横スクロールでも切替
    el.addEventListener('wheel', (e)=>{
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 20){
        e.preventDefault();
        goTabDelta(e.deltaX > 0 ? +1 : -1);
      }
    }, {passive:false});
  }

  // --- 画面端スワイプ（全画面有効。ただし編集/描画要素の上は無視）
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
  // 既存の購読解除
  if (unsubscribeNotify) { try{ unsubscribeNotify(); }catch{} unsubscribeNotify=null; }

  const box = document.getElementById('notifyList');
  const empty = document.getElementById('notifyEmpty');
  if(!box) return;
  box.innerHTML = '';
  empty.style.display = 'none';

  // 自分宛の未読だけを新しい順に
  const col = db.collection('teams').doc(teamId).collection('notifications');
  const q = col.where('to','==', viewingMemberId || memberId)
               //.where('read','==', false)
               //.orderBy('ts','desc');

  // スナップショット購読
  unsubscribeNotify = q.onSnapshot(async (snap)=>{
    box.innerHTML = '';
    if (snap.empty){
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    //const toMark = [];  // 既読化対象

    snap.docs.forEach(doc=>{
      const n = doc.data();
      // 行を作る
      const div = document.createElement('div');
      div.className = 'msg';

      const at = new Date(n.ts || Date.now()).toLocaleString('ja-JP');
      // 表示本文
      const bodyHtml = (n.type === 'dayComment')
        ? (
         `<div><b>${n.day}</b> の練習にコメントがつきました（${getDisplayName(n.from)}）</div>` +
          (n.text ? `<div class="muted" style="white-space:pre-wrap;">${escapeHtml(n.text)}</div>` : ``) +
          `<div class="link" data-day="${n.day}">この日誌を開く</div>`
        )
        : `<div>通知</div>`;

      div.innerHTML = `
        <span class="date">${at}</span>
        <div class="body">${bodyHtml}</div>
      `;

      // クリックで該当日へ
      div.querySelector('.link')?.addEventListener('click', (e)=>{
        const day = e.currentTarget.getAttribute('data-day');
        if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)){
          selDate = parseDateInput(day);
          switchTab('journal', true);
        }
      });

      box.appendChild(div);

      // 「開けば次回以降なくなる」＝一覧を開いた時点で既読化
     // toMark.push(doc.ref);
    });

    // 既読フラグ更新（まとめて）
    //const batch = db.batch();
    //toMark.forEach(ref => batch.update(ref, { read: true }));
   // try{ await batch.commit(); }catch(e){ console.error('notify read commit error', e); }
  }, (err)=>{
    console.error('notify onSnapshot error', err);
    empty.style.display = 'block';
  });
}

// XSS対策の軽いエスケープ
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

async function createDayCommentNotifications({ teamId, from, to, day, text }){
  try{
    const col = db.collection('teams').doc(teamId).collection('notifications');
    const batch = db.batch();
    const ts = Date.now();
    let notifyCount = 0;
    // ▼ 修正: to が存在し、from (コメント投稿者) と異なるときのみ通知を作成
    if (to && to !== from) {
      const ref = col.doc();
      batch.set(ref, {
        type:'dayComment',
        team: teamId,
        day, text, from, to, // to は日誌の持ち主
        ts, read:false
      });
      notifyCount++;
    }

    console.log("DEBUG: Attempting batch commit for notifications, count:", notifyCount);

    await batch.commit(); 

    console.log("DEBUG: Notification batch committed successfully.");

  }catch(e){
    console.error('createDayCommentNotifications error', e);
  }
}
    

function openLtimer() {
  if (teamId && memberId) {
    const encodedTeamId = encodeURIComponent(teamId);
    const encodedMemberName = encodeURIComponent(memberId);
    const ltimerUrl = `https://gddgfr4.github.io/Ltimer/?team=${encodedTeamId}&member=${encodedMemberName}`;
    window.open(ltimerUrl, '_blank');
  } else {
    window.open('https://gddgfr4.github.io/Ltimer/', '_blank');
  }
}

function openStadiumMap() {
  if (teamId && memberId) {
    const encodedTeamId = encodeURIComponent(teamId);
    const encodedMemberName = encodeURIComponent(memberId);
    const stadiumMapUrl = `https://gddgfr4.github.io/stadiummap/?team=${encodedTeamId}&member=${encodedMemberName}`;
    window.open(stadiumMapUrl, '_blank');
  } else {
    window.open('https://gddgfr4.github.io/stadiummap/', '_blank');
  }
}
