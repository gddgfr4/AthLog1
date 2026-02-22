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

// --- マルチタッチ管理（2本以上は塗らないでピンチに委ねる）---
const MT = { pointers: new Set() };

function setOverlayTouchAction(mode){
  const ov = document.getElementById('mmOverlay');
  if (ov) ov.style.touchAction = mode;   // 'none' | 'auto' | 'pan-x pan-y pinch-zoom'
}

function autoResizeTextarea(el) {
  if (!el) return;
  // スクロールバーが出ないようにする
  el.style.overflow = 'hidden';
  // 一度高さをリセットして、内容量に合わせて再設定する
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}
// ホームボタンのバッジ表示を制御する関数
function updateHomeBadge() {
  const homeBtn = document.querySelector('.tab[data-tab="home"]') || document.getElementById("goHomeBtn");
  if (!homeBtn) return;

  // 通知バッジの状態確認
  const notifyBadge = document.getElementById("notifyBadge");
  const hasNotify = notifyBadge && !notifyBadge.classList.contains("hidden");

  // メモバッジの状態確認
  const memoBadge = document.getElementById("memoBadge");
  const hasMemo = memoBadge && !memoBadge.classList.contains("hidden");

  // どちらかに未読があればホームボタンにも「new」クラスなどをつける
  if (hasNotify || hasMemo) {
    homeBtn.classList.add("has-badge");
    
    // もしホームボタンの中にバッジ要素がなければ作る（CSSでやる場合は不要だが念のため）
    if(!homeBtn.querySelector(".home-dot")){
      const dot = document.createElement("span");
      dot.className = "home-dot";
      // 簡易的なスタイル（CSSファイルに記述推奨）
      dot.style.cssText = "position:absolute; top:4px; right:4px; width:8px; height:8px; background:red; border-radius:50%; pointer-events:none;";
      homeBtn.style.position = "relative"; 
      homeBtn.appendChild(dot);
    }
  } else {
    homeBtn.classList.remove("has-badge");
    const dot = homeBtn.querySelector(".home-dot");
    if(dot) dot.remove();
  }
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
  if (!teamId) return; // 安全策
  const col = getTeamMemoCollectionRef(teamId);
  // 最新の投稿時間を取得して既読とする
  const snap = await col.orderBy('ts','desc').limit(1).get();
  const latestTs = snap.empty ? Date.now() : (snap.docs[0].data().ts || Date.now());
  
  localStorage.setItem(memoLastViewKey(), String(latestTs));
  
  // ▼▼▼ 修正: タブとホームカードの両方からバッジを削除 ▼▼▼
  const memoTab = document.querySelector('[data-tab="memo"]');
  if(memoTab) memoTab.classList.remove('new-message');
  
  const memoCard = document.querySelector('.home-card[data-target="memo"]');
  if(memoCard) memoCard.classList.remove('new-message');
}

// ===== App State =====
let teamId=null, memberId=null, viewingMemberId=null;
// app.js 145行目付近（変数が並んでいる場所）
let monthFavOnly = false; // ★追加: 月一覧のフィルター状態
let selDate=new Date();
let brush={ lvl:1, erase:false };
let distanceChart=null, conditionChart=null;
let dashboardOffset=0, dashboardMode='month';
let conditionChartOffset=0;
let unsubscribePlans, unsubscribeMemo, unsubscribeMonthChat, unsubscribeJournal;
let dirty={ dist:false, train:false, feel:false, weight:false };
let lastJournal=null;  // ← 追加：未宣言だったので明示
let unsubscribeNotify = null;
let memberNameMap = {};
let weightChart = null;
let weightMode = 'day'; // day, week, month
let weightOffset = 0;
let myMemberId = null;
let ltimerRunning = false;
let ltSessionRef = null;
let ltUserId = null;
let ltWatches = [];
let ltTeamMembers = [];
let ltPmState = {};
let ltCustomSteps = [];
let ltCustomState = {};
let ltAudioCtx = null;

// ===== Data Access Layer =====
const getJournalRef  = (team,member,day)=> db.collection('teams').doc(team).collection('members').doc(member).collection('journal').doc(ymd(day));
const getGoalsRef    = (team,member,month)=> db.collection('teams').doc(team).collection('members').doc(member).collection('goals').doc(month);
const getPlansCollectionRef=(team)=> db.collection('teams').doc(team).collection('plans');
const getTeamMemoCollectionRef=(team)=> db.collection('teams').doc(team).collection('memo');
const getMonthChatCollectionRef=(team,month)=> db.collection('teams').doc(team).collection('chat').doc(month).collection('messages');
const getMembersRef=(team)=> db.collection('teams').doc(team).collection('members');

// ... (前略) ...

// ==========================================
// ========== Header Buttons Logic ==========
// ==========================================

// ==========================================
// ========== Header Buttons Logic ==========
// ==========================================
function initHeaderEvents() {
  // --- 1. ログアウトボタン ---
  const logoutBtn = document.getElementById("logoutBtn");
  if(logoutBtn) {
    const newLogout = logoutBtn.cloneNode(true);
    logoutBtn.parentNode.replaceChild(newLogout, logoutBtn);
    
    newLogout.addEventListener("click", () => {
      if(confirm("ログアウトしますか？")) {
        // ★修正: 正しい保存キー "athlog:last" を削除する
        localStorage.removeItem("athlog:last");
        localStorage.removeItem("athlog:profiles"); // 念のためプロフィール履歴も消すなら
        location.reload(); 
      }
    });
  }

  // --- 2. メインにするボタン ---
  const setMainBtn = document.getElementById("setAsMainBtn");
  if(setMainBtn) {
    const newMainBtn = setMainBtn.cloneNode(true);
    setMainBtn.parentNode.replaceChild(newMainBtn, setMainBtn);
    newMainBtn.addEventListener("click", () => {
      if(!teamId) return;
      // メイン設定ロジック
      setMainTeamOf(memberId, teamId);
      const badge = document.getElementById("mainTeamBadge");
      if(badge) badge.classList.remove("hidden");
      alert(`チーム「${teamId}」をメインに設定しました。`);
    });
  }
}

// ==========================================
// ========== App Initialization ============
// ==========================================
async function showApp(){

  const tl = document.getElementById("teamLabel");
  if(tl) tl.textContent = teamId;
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");

  const __nowMon = getMonthStr(new Date());
  if($("#monthPick") && !$("#monthPick").value) $("#monthPick").value = __nowMon;
  if($("#planMonthPick") && !$("#planMonthPick").value) $("#planMonthPick").value = __nowMon;

  await populateMemberSelect();
  
  const loginName = $("#memberName").value.trim();
  const memberSelect = $("#memberSelect");
  let correctId = null;
  if(memberSelect) {
    for (let opt of memberSelect.options) {
      if (opt.value === memberId || opt.text === memberId) { 
        correctId = opt.value; 
        break; 
      }
    }
  }
  myMemberId = correctId || memberId;
  viewingMemberId = myMemberId;
  if(memberSelect) memberSelect.value = myMemberId;

  refreshBadges();
  
  
  if(memberSelect) memberSelect.addEventListener('change', ()=>{
    viewingMemberId=$("#memberSelect").value;
    const ml = $("#memberLabel");
    if(ml) ml.textContent = getDisplayName(viewingMemberId);
    
    refreshBadges();
    switchTab($(".tab.active")?.dataset.tab, true);
  });

  // タブボタンイベント
  $$(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      if(target) switchTab(target);
    });
  });

  initJournal(); initMonth(); initPlans(); initDashboard(); initMemo();
  initHome();
  initHeaderEvents();

  switchTab("journal"); 
  initMemoBadgeCheck();
  checkNewMemo();
  initTeamSwitcher();
  initGlobalTabSwipe();
  initNotifyBadgeCheck();
  initMemberNav();
  initAiAnalysis();
  
  $("#goHomeBtn")?.addEventListener("click", () => switchTab("home"));
}

function initNotifyBadgeCheck(){
  if(notifyBadgeUnsub) { try{ notifyBadgeUnsub(); }catch{} notifyBadgeUnsub=null; }
  
  if(!memberId || !teamId) return;

  const col = db.collection('teams').doc(teamId).collection('notifications');
  
  const q = col.where('to','==', memberId)
                .orderBy('ts', 'desc')
                .limit(1);

  notifyBadgeUnsub = q.onSnapshot(snap => {
    // 通知がない場合
    if (snap.empty) {
      if(typeof toggleNotifyBadges === 'function') toggleNotifyBadges(false);
      updateHomeTabBadge(); // ★追加: 状態を再確認して更新
      return;
    }

    const latest = snap.docs[0].data();
    const latestTs = latest.ts || 0;
    
    const lastViewKey = `athlog:${teamId}:${memberId}:lastNotifyView`;
    const lastViewTs = Number(localStorage.getItem(lastViewKey) || 0);

    const hasNew = latestTs > lastViewTs;
    if(typeof toggleNotifyBadges === 'function') toggleNotifyBadges(hasNew);
    
    // ★追加: ホームボタンの更新
    // 「通知がある」または「既にメモのバッジがついている」ならホームも点灯
    const isMemoActive = document.querySelector('.tab[data-tab="memo"]')?.classList.contains('new-message');
    updateHomeTabBadge(hasNew || isMemoActive);
    
  }, err => {
    console.error("Notify badge check failed (Index might be missing):", err);
  });
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
    const currentTab = $(".tab.active")?.dataset.tab || 'journal';
    teamId = e.target.value;
    const teamLabelEl = $("#teamLabel");
    if (teamLabelEl) {
      teamLabelEl.textContent = teamId;
    }
    await populateMemberSelect();   // チームのメンバー一覧を更新
    refreshBadges();
    initTeamSwitcher(); 
    switchTab(currentTab, true);
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

const STADIUM_DATA = [
  { name: "国立競技場", region: "関東", address: "東京都新宿区霞ヶ丘町10-1", lat: 35.6778, lng: 139.7145, url: "https://www.jpnsport.go.jp/kokuritu/" },
  { name: "駒沢オリンピック公園", region: "関東", address: "東京都世田谷区駒沢公園1-1", lat: 35.6253, lng: 139.6631, url: "https://www.tef.or.jp/kopgp/" },
  { name: "日産スタジアム", region: "関東", address: "神奈川県横浜市港北区小机町3300", lat: 35.5100, lng: 139.6062, url: "https://www.nissan-stadium.jp/" },
  { name: "ヤンマースタジアム長居", region: "近畿", address: "大阪府大阪市東住吉区長居公園1-1", lat: 34.6121, lng: 135.5173, url: "https://www.nagaipark.com/stadium/" },
  { name: "博多の森陸上競技場", region: "九州", address: "福岡県福岡市博多区東平尾公園2-1-2", lat: 33.5857, lng: 130.4605, url: "https://www.midorimachi.jp/park/detail.php?code=202001" },
  // ... 必要に応じて追加 ...
];

function switchTab(id, forceRender = false) {

  // ★ ヘルパー: 強制的に「自分」のデータに戻す
  const enforceMyData = () => {
    if (myMemberId && viewingMemberId !== myMemberId) {
      viewingMemberId = myMemberId;
      const ms = document.getElementById("memberSelect");
      if (ms) ms.value = myMemberId;
      
      // ★削除: 名前ラベルへの書き込みを削除（重複防止）
      // const ml = document.getElementById("memberLabel");
      // if (ml) ml.textContent = getDisplayName(viewingMemberId);
      if (id === 'memo') {
      if(teamId) {
          const lastViewKey = `athlog:${teamId}:${memberId}:lastMemoView`;
          localStorage.setItem(lastViewKey, Date.now());
      }
      // 見た目上もすぐに消す
      const memoTab = document.querySelector('.tab[data-tab="memo"]');
      if(memoTab) memoTab.classList.remove('new-message');
    }
      refreshBadges();
    }
  };

  // ★ ヘルパー: メンバー選択UIの有効/無効切り替え
  const configureMemberUI = (enable) => {
    const navWrap = document.getElementById("memberNavWrap");
    const sel = document.getElementById("memberSelect");
    const prev = document.getElementById("memberPrev");
    const next = document.getElementById("memberNext");

    if (navWrap) {
      navWrap.classList.remove("hidden");
      navWrap.style.opacity = enable ? "1" : "0.5"; 
      navWrap.style.pointerEvents = enable ? "auto" : "none";
    }
    if (sel) sel.disabled = !enable;
  };

  // ナビゲーション要素
  const tabsNav = document.getElementById("journalTabs");
  const homeBtn = document.getElementById("goHomeBtn");

  // --- 1. 競技場マップ ---
  if (id === 'stadium') {
    $$(".tabpanel").forEach(p => p.classList.remove("active"));
    $("#clock")?.classList.remove("active"); $("#clock") && ($("#clock").style.display='none');
    
    document.getElementById('stadium')?.classList.add("active");
    
    // タブを確実に消す
    if(tabsNav) { tabsNav.classList.add("hidden"); tabsNav.style.display = 'none'; }
    if(homeBtn) homeBtn.classList.remove("hidden");

    enforceMyData();
    configureMemberUI(false);
    ltimerRunning = false;
    initStadium();
    return;
  }

  // --- 2. 時計 (Ltimer) ---
  if (id === 'clock') {
    $$(".tabpanel").forEach(p => p.classList.remove("active"));
    const cp = document.getElementById('clock');
    if(cp) { cp.style.display='block'; cp.classList.add('active'); }

    // タブを確実に消す
    if(tabsNav) { tabsNav.classList.add("hidden"); tabsNav.style.display = 'none'; }
    if(homeBtn) homeBtn.classList.remove("hidden");

    enforceMyData();
    configureMemberUI(false);
    initLtimer();
    return;
  }

  // --- 3. 通常モード ---
  if (ltimerRunning) {
      ltimerRunning = false;
      // 時計画面を離れる時にセッション枠を解放する
      if (typeof disconnectLtSession === 'function') disconnectLtSession();
  }
  $("#clock")?.classList.remove("active"); $("#clock") && ($("#clock").style.display='none');
  if (!forceRender && $(".tabpanel.active")?.id === id && id !== 'home') return;

  $$(".tabpanel").forEach(p => p.classList.remove("active"));
  document.getElementById(id)?.classList.add("active");

  $$(".tab").forEach(btn => btn.classList.remove("active"));

　const isJournalTab = ['journal', 'month', 'dashboard'].includes(id);

  if (isJournalTab) {
    // === 日誌系 ===
    configureMemberUI(true); 
    
    // タブを表示
    if(tabsNav) { 
      tabsNav.classList.remove("hidden"); 
      // ★修正1: 隠す時につけた important 設定を削除してから flex を適用
      tabsNav.style.removeProperty('display');
      tabsNav.style.display = 'flex'; 
    }
    if(homeBtn) homeBtn.classList.remove("hidden");

    $(`.tab[data-tab="${id}"]`)?.classList.add("active");

  } else {
    // === ホーム、その他 ===
    enforceMyData();
    configureMemberUI(false);

    // タブを確実に消す
    if(tabsNav) { 
      tabsNav.classList.add("hidden"); 
      // ★修正2: CSSの !important に勝つために、こちらも important を付けて隠す
      tabsNav.style.setProperty('display', 'none', 'important'); 
    }

    if (id === 'home') {
      if(homeBtn) homeBtn.classList.add("hidden");
    } else {
      if(homeBtn) homeBtn.classList.remove("hidden");
    }
  }

  if (unsubscribePlans) unsubscribePlans();
  if (unsubscribeMemo) unsubscribeMemo();
  if (unsubscribeMonthChat) unsubscribeMonthChat();
  if (unsubscribeJournal) unsubscribeJournal();
  if (id === "journal") renderJournal();
  if (id === "month") renderMonth();
  if (id === "plans") renderPlans();
  if (id === "dashboard") renderDashboard();
  if (id === "memo") { renderMemo(); markMemoRead(); }
  if (id === "notify") { renderNotify(); }
}

function initHome() {
  const grid = document.getElementById('homeMenuGrid');
  if(!grid) return;
  
  // 既存のリスナー重複防止のため、replaceNodeするか、あるいはonclickで設定する手もあるが
  // シンプルに addEventListener で親要素に設定（イベント委譲）
  grid.addEventListener('click', (e) => {
    // クリックされた要素が .home-card またはその内部か判定
    const card = e.target.closest('.home-card');
    if (card && card.dataset.target) {
      switchTab(card.dataset.target);
    }
  });
}
// ==========================================
// ========== Ltimer Logic Integrated =======
// ==========================================

function initLtimer() {
  ltimerRunning = true;
  showLtScreen('menu'); // 初期画面はメニュー
  
  // イベントリスナー設定 (安全策付き)
  setupLtimerEvents();
  
  // ループ開始
  requestAnimationFrame(ltimerLoop);
}

function ltimerLoop() {
  if (!ltimerRunning) return;
  
  const splitScreen = document.getElementById('lt-split');
  const pmScreen = document.getElementById('lt-pm');
  const customScreen = document.getElementById('lt-custom');

  if (splitScreen && !splitScreen.classList.contains('lt-hidden')) tickSplit();
  if (pmScreen && !pmScreen.classList.contains('lt-hidden')) tickPacemaker();
  if (customScreen && !customScreen.classList.contains('lt-hidden')) tickCustomTimer();

  requestAnimationFrame(ltimerLoop);
}

function showLtScreen(name) {
  ['lt-menu', 'lt-split', 'lt-pm', 'lt-custom'].forEach(id => {
    document.getElementById(id)?.classList.add('lt-hidden');
  });
  
  const target = document.getElementById(name === 'menu' ? 'lt-menu' : `lt-${name}`);
  if(target) target.classList.remove('lt-hidden');

  const backBtn = document.getElementById('lt-back');
  if(name === 'menu') {
    if(backBtn) backBtn.classList.add('lt-hidden');
    updateLtChooserView();
  } else {
    if(backBtn) backBtn.classList.remove('lt-hidden');
  }
}

// ★ 安全なイベント設定関数
function setupLtimerEvents() {
  // 重複登録防止
  if(window._ltEventsSetup) return;
  window._ltEventsSetup = true;

 const backBtn = $("#lt-back button");
  if (backBtn) {
    backBtn.onclick = (e) => {
      e.stopPropagation();
      stopCustomTimer();
      if(ltPmState.lanes) ltPmState.lanes.forEach(l => l.running = false);
      // セッション切断（関数化）
      disconnectLtSession();
      showLtScreen('menu');
    };
  }

  // 共有接続
  const shareBtn = $("#share-connect-btn");
  if (shareBtn) {
    shareBtn.onclick = async () => {
      await connectLtSession(); // 合言葉なしで直接接続
    };
  }

  // モード選択ボタン
  const btnSplit = $("#choose-split");
  if (btnSplit) btnSplit.onclick = () => { initSplit(!!ltSessionRef); showLtScreen('split'); };
  
  const btnPm = $("#choose-pm");
  if (btnPm) btnPm.onclick = (e) => { if(!e.target.disabled) { initPacemaker(); showLtScreen('pm'); }};
  
  const btnCustom = $("#choose-custom");
  if (btnCustom) btnCustom.onclick = (e) => { if(!e.target.disabled) { initCustom(); showLtScreen('custom'); }};

  // ヘルプ関連
  const helpData = {
    split: { t: 'ペース走', b: '複数人のタイムを同時計測します。共有機能で他の端末と同期可能です。' },
    pm: { t: 'インターバル', b: '設定した距離・本数・ペースに基づいて、通過確認音やラップ計算を自動化します。' },
    custom: { t: 'カスタムタイマー', b: 'WORKとRESTを組み合わせたセットタイマーを作成します。' }
  };
  const showHelp = (k) => {
    $("#help-title").textContent = helpData[k].t;
    $("#help-body").textContent = helpData[k].b;
    $("#lt-help").classList.remove("lt-hidden");
  };

  const hSplit = $("#help-split"); if (hSplit) hSplit.onclick = () => showHelp('split');
  const hPm = $("#help-pm"); if (hPm) hPm.onclick = () => showHelp('pm');
  const hCustom = $("#help-custom"); if (hCustom) hCustom.onclick = () => showHelp('custom');
  
  const hClose = $("#help-close"); if (hClose) hClose.onclick = () => $("#lt-help").classList.add("lt-hidden");
  const sClose = $("#summary-close"); if (sClose) sClose.onclick = () => $("#lt-summary").classList.add("lt-hidden");
const pmPlus = $("#pm-lane-plus"); 
  if(pmPlus) pmPlus.onclick = () => { let c=parseInt($("#pm-lane-count").textContent); if(c<4) renderPmSettings(c+1); };
  
  const pmMinus = $("#pm-lane-minus"); 
  if(pmMinus) pmMinus.onclick = () => { let c=parseInt($("#pm-lane-count").textContent); if(c>1) renderPmSettings(c-1); };

  const pmStart = $("#pm-start-btn");
  if(pmStart) pmStart.onclick = () => {
      const dist = +$("#pm-distance").value;
      const reps = +$("#pm-reps").value;
      if(!dist || !reps) return;
      
      const cnt = parseInt($("#pm-lane-count").textContent);
      ltPmState.lanes = [];
      for(let i=1; i<=cnt; i++) {
          const val = document.getElementById(`pm-name-${i}`)?.value; // 安全に取得
          const name = (typeof getDisplayName === 'function' ? getDisplayName(val) : val) || val || `レーン${i}`; 
          const m = +document.getElementById(`pm-m-${i}`)?.value || 0;
          const s = +document.getElementById(`pm-s-${i}`)?.value || 0;
          ltPmState.lanes.push({
              id:i, name:name, 
              targetTime: (m*60+s)*1000, 
              running:false, startTime:0, laps:[], 
              rep:1, totalReps: reps
          });
      }
      
      const sEl = document.querySelector("#lt-pm #pm-settings");
      if(sEl) sEl.classList.add("lt-hidden");
      const rEl = document.querySelector("#lt-pm #pm-runner");
      if(rEl) rEl.classList.remove("lt-hidden");
      
      renderPmRunner();
  };

  // Custom (タイマー) モードのボタン
  const cAdd = $("#custom-add-step-btn"); 
  if(cAdd) cAdd.onclick = () => { ltCustomSteps.push({type:'WORK', dur:30}); renderCustomSteps(); };

  const cStart = $("#custom-start-btn"); 
  if(cStart) cStart.onclick = () => {
      ltCustomState = {
          running: true, steps: [...ltCustomSteps], 
          rep: 1, totalReps: +$("#custom-reps").value,
          stepIdx: 0, stepStart: Date.now(), remain: ltCustomSteps[0].dur
      };
      $("#custom-settings").classList.add("lt-hidden");
      $("#custom-runner").classList.remove("lt-hidden");
  };
  
  const cReset = $("#custom-reset-btn"); 
  if(cReset) cReset.onclick = () => {
      ltCustomState.running = false;
      $("#custom-settings").classList.remove("lt-hidden");
      $("#custom-runner").classList.add("lt-hidden");
  };
  // ★以前エラーが出ていたボタン設定をここに移動（要素があるかチェックしてから設定）
  const btnAdd = $("#standalone-controls button[data-action='add']");
  if(btnAdd) btnAdd.onclick = () => {
      const newId = ltWatches.length ? Math.max(...ltWatches.map(w=>w.id))+1 : 0;
      ltWatches.push({id:newId, name:(typeof viewingMemberId !== 'undefined' ? viewingMemberId : ''), running:false, elapsed:0, start:0, lastLap:0, laps:[], target:0});
      renderSplit();
  };
  
  const btnStartAll = $("#standalone-controls button[data-action='start-all']");
  if(btnStartAll) btnStartAll.onclick = () => {
      const now = Date.now();
      ltWatches.forEach(w => { if(!w.running){ w.running=true; w.start=now-w.elapsed; }});
      playClickSound();
      renderSplit();
  };

  const btnStopAll = $("#standalone-controls button[data-action='stop-all']");
  if(btnStopAll) btnStopAll.onclick = () => {
      const now = Date.now();
      ltWatches.forEach(w => { if(w.running){ w.running=false; w.elapsed=now-w.start; }});
      playClickSound();
      renderSplit();
  };

  const btnReset = $("#standalone-controls button[data-action='review-reset']");
  if(btnReset) btnReset.onclick = () => {
      let html = '<table style="width:100%; text-align:center; border-collapse:collapse; margin-bottom:12px;"><tr><th style="border-bottom:1px solid #ddd;">Name</th><th style="border-bottom:1px solid #ddd;">Total</th><th style="border-bottom:1px solid #ddd;">Laps</th></tr>';
      ltWatches.forEach(w => {
          const dispName = (typeof getDisplayName === 'function' ? getDisplayName(w.name) : w.name) || w.name || '-';
          html += `<tr><td style="padding:4px;">${dispName}</td><td>${fmt(w.elapsed)}</td><td>${(w.laps||[]).length}</td></tr>`;
      });
      html += '</table>';
      
      // ★追加: アクションボタンエリア
      html += `
        <div style="display:flex; gap:8px; margin-bottom:8px;">
           <button id="lt-reflect-btn" class="lt-w-full lt-bg-blue-600 lt-text-white lt-font-bold lt-rounded-lg lt-p-2">日誌に反映</button>
           <button id="lt-clear-btn" class="lt-w-full lt-bg-red-500 lt-text-white lt-font-bold lt-rounded-lg lt-p-2">リセット</button>
        </div>
      `;
      
      const sumTable = $("#summary-table");
      if(sumTable) sumTable.innerHTML = html;
      
      const sumModal = $("#lt-summary");
      if(sumModal) sumModal.classList.remove('lt-hidden');

      // ★追加: ボタンイベント設定
      setTimeout(() => {
          document.getElementById('lt-reflect-btn')?.addEventListener('click', reflectLtimerToJournal);
          
          document.getElementById('lt-clear-btn')?.addEventListener('click', () => {
             if(confirm("計測データをリセットしますか？")) {
                 ltWatches = ltWatches.map(w => ({...w, running:false, elapsed:0, start:0, lastLap:0, laps:[]}));
                 renderSplit();
                 $("#lt-summary").classList.add('lt-hidden');
             }
          });
      }, 50);
  };
}

function updateLtChooserView() {
  const isShared = !!ltSessionRef;
  const msg = $("#share-status-msg");
  if(msg) {
    if(isShared) {
        msg.textContent = "接続中";
        msg.style.color = "var(--primary)";
    } else {
        msg.textContent = "";
    }
  }
  ['choose-pm', 'choose-custom'].forEach(id => {
      const btn = document.getElementById(id);
      if(btn) {
          btn.disabled = isShared;
          btn.style.opacity = isShared ? 0.5 : 1;
          btn.style.cursor = isShared ? 'not-allowed' : 'pointer';
      }
  });
}

// ヘルパー: メンバー選択肢のHTML生成
function getLtMemberOptions(selectedVal) {
  const ms = document.getElementById("memberSelect");
  if(!ms || ms.options.length === 0) return `<option value="${selectedVal}">${selectedVal || '選手を選択'}</option>`;
  
  let html = '<option value="">-- 選手を選択 --</option>';
  for(let i=0; i<ms.options.length; i++) {
    const opt = ms.options[i];
    const isSel = (opt.value === selectedVal) ? 'selected' : '';
    html += `<option value="${opt.value}" ${isSel}>${opt.text}</option>`;
  }
  return html;
}

// ===== Split Logic =====
function initSplit(isShared) {
    const controls = $("#share-controls");
    const standalone = $("#standalone-controls");
    
    if(isShared) {
        if(controls) controls.classList.remove('lt-hidden');
        if(standalone) standalone.classList.add('lt-hidden');
        if(!ltUserId && standalone) standalone.classList.remove('lt-hidden');
    } else {
        if(controls) controls.classList.add('lt-hidden');
        if(standalone) standalone.classList.remove('lt-hidden');
        
        const myId = (typeof viewingMemberId !== 'undefined') ? viewingMemberId : ''; 
        ltWatches = [{
            id:0, name:myId, running:false, start:0, elapsed:0, lastLap:0, laps:[], target:0
        }];
        renderSplit();
    }
}

function renderSplit() {
    const grid = $("#split-grid");
    if (!grid) return;

    grid.innerHTML = ltWatches.map(w => {
        let cum = 0;
        const hist = (w.laps || []).map((l, i) => {
            cum += l;
            return `<div style="display:flex; justify-content:space-between; font-size:11px; border-bottom:1px solid #eee;">
                <span>Lap ${i+1}</span>
                <span style="font-weight:bold;">${fmt(l)}</span>
                <span style="color:#666">(${fmt(cum)})</span>
            </div>`;
        }).reverse().join('');
        
        return `
        <div class="runner-card ${getCardColor(w)}" id="w-${w.id}">
           <button class="lt-btn-del" onclick="ltDelWatch(${w.id})" style="position:absolute; right:4px; top:4px; background:#ddd; border-radius:50%; width:24px; height:24px; border:none; z-index:10; font-weight:bold; cursor:pointer;">×</button>
           
           <div class="runner-card-header">
             <select onchange="ltUpdateName(${w.id}, this.value)" class="lt-input" style="padding:4px; font-weight:bold;">
                ${getLtMemberOptions(w.name)}
             </select>
             <input type="number" placeholder="目標(秒)" value="${w.target||''}" onchange="ltUpdateTarget(${w.id}, this.value)" class="lt-input" style="padding:4px;">
           </div>
           
           <div class="runner-main-time" style="font-family:monospace;">${fmt(w.elapsed)}</div>
           <div class="runner-lap-live" style="font-family:monospace; color:#444;">Lap: ${fmt(w.elapsed - w.lastLap)}</div>
           
           <div class="runner-lap-history">${hist}</div>
           
           <div class="runner-actions">
             <button class="btn-start ${w.running?'lt-bg-red-500':'lt-bg-green-500'}" onclick="ltToggleWatch(${w.id})">${w.running?'STOP':'START'}</button>
             <button class="btn-lap lt-bg-gray-800" onclick="ltLapWatch(${w.id})">LAP</button>
           </div>
        </div>
        `;
    }).join('');
}

function getCardColor(w) {
    if(!w.target || !w.running) return '';
    const currentLapTime = (w.running ? (Date.now() - w.start) : w.elapsed) - w.lastLap;
    const targetMs = w.target * 1000;
    const diff = targetMs - currentLapTime;
    
    if(diff < 0) return 'frame-bad';
    if(diff < 5000) return 'frame-warn5';
    if(diff < 10000) return 'frame-warn10';
    return '';
}

// Windowスコープ操作関数
window.ltDelWatch = (id) => {
    if(!confirm("このランナーを削除しますか？")) return;
    ltWatches = ltWatches.filter(w => w.id !== id);
    if(ltSessionRef) updateSharedWatches(); else renderSplit();
};
window.ltUpdateName = (id, val) => {
    const w = ltWatches.find(x => x.id === id); if(w) w.name = val;
    if(ltSessionRef) updateSharedWatches();
};
window.ltUpdateTarget = (id, val) => {
    const w = ltWatches.find(x => x.id === id); if(w) w.target = Number(val);
    if(ltSessionRef) updateSharedWatches();
    if(!ltSessionRef) renderSplit(); 
};
window.ltToggleWatch = (id) => {
    const w = ltWatches.find(x => x.id === id); if(!w) return;
    const now = Date.now();
    playClickSound();
    if(w.running) {
        w.running = false; w.elapsed = now - w.start;
    } else {
        w.running = true; w.start = now - w.elapsed;
    }
    if(ltSessionRef) updateSharedWatches(); else renderSplit();
};
window.ltLapWatch = (id) => {
    const w = ltWatches.find(x => x.id === id); if(!w || !w.running) return;
    const now = Date.now();
    playClickSound();
    const curElapsed = now - w.start;
    w.laps = w.laps || [];
    w.laps.push(curElapsed - w.lastLap);
    w.lastLap = curElapsed;
    if(ltSessionRef) updateSharedWatches(); else renderSplit();
};

function tickSplit() {
    const now = Date.now();
    ltWatches.forEach(w => {
        const card = document.getElementById(`w-${w.id}`);
        if(!card) return;
        
        const elapsed = w.running ? (now - w.start) : w.elapsed;
        const lap = elapsed - w.lastLap;
        
        const mainTimeEl = card.querySelector('.runner-main-time');
        const lapTimeEl = card.querySelector('.runner-lap-live');
        
        if(mainTimeEl) mainTimeEl.textContent = fmt(elapsed);
        if(lapTimeEl) lapTimeEl.textContent = "Lap: " + fmt(lap);
        
        const colorClass = getCardColor({...w, running: w.running, start: w.start, lastLap: w.lastLap, elapsed: elapsed});
        card.className = `runner-card ${colorClass}`;
    });
}

// ===== PM Logic =====
function initPacemaker() {
    ltPmState = { lanes: [] };
    renderPmSettings();
}

function renderPmSettings(cnt=1) {
    const box = $("#pm-lane-targets");
    if(box) {
        $("#pm-lane-count").textContent = cnt + "レーン";
        box.innerHTML = '';
        for(let i=1; i<=cnt; i++) {
            const defVal = (i===1) ? ((typeof viewingMemberId !== 'undefined') ? viewingMemberId : '') : '';
            box.innerHTML += `
            <div style="display:flex; gap:4px; margin-bottom:6px;">
            <select class="lt-input" id="pm-name-${i}" style="flex:2">
                ${getLtMemberOptions(defVal)}
            </select>
            <input class="lt-input" placeholder="分" type="number" id="pm-m-${i}" style="flex:1">
            <input class="lt-input" placeholder="秒" type="number" id="pm-s-${i}" style="flex:1">
            </div>`;
        }
    }
}
const pmPlus = $("#pm-lane-plus"); if(pmPlus) pmPlus.onclick = () => { let c=parseInt($("#pm-lane-count").textContent); if(c<4) renderPmSettings(c+1); };
const pmMinus = $("#pm-lane-minus"); if(pmMinus) pmMinus.onclick = () => { let c=parseInt($("#pm-lane-count").textContent); if(c>1) renderPmSettings(c-1); };

const pmStart = $("#pm-start-btn");
if(pmStart) pmStart.onclick = () => {
    const dist = +$("#pm-distance").value;
    const reps = +$("#pm-reps").value;
    if(!dist || !reps) return;
    
    const cnt = parseInt($("#pm-lane-count").textContent);
    ltPmState.lanes = [];
    for(let i=1; i<=cnt; i++) {
        const val = $(`#pm-name-${i}`).value;
        const name = (typeof getDisplayName === 'function' ? getDisplayName(val) : val) || val || `レーン${i}`; 
        const m = +$(`#pm-m-${i}`).value || 0;
        const s = +$(`#pm-s-${i}`).value || 0;
        ltPmState.lanes.push({
            id:i, name:name, 
            targetTime: (m*60+s)*1000, 
            running:false, startTime:0, laps:[], 
            rep:1, totalReps: reps
        });
    }
    
    const sEl = document.querySelector("#lt-pm #pm-settings");
    if(sEl) sEl.classList.add("lt-hidden");
    const rEl = document.querySelector("#lt-pm #pm-runner");
    if(rEl) rEl.classList.remove("lt-hidden");
    
    renderPmRunner();
};

function renderPmRunner() {
    const grid = $("#pm-runner-grid");
    if(grid) grid.innerHTML = ltPmState.lanes.map(l => `
        <div class="pm-lane" id="pm-l-${l.id}">
           <div class="lt-font-bold" style="font-size:18px;">${l.name}</div>
           <div class="pm-main-time timer-font">${fmt(0)}</div>
           <button class="pm-lap-btn lt-bg-blue-500" onclick="ltPmLap(${l.id})">START</button>
        </div>
    `).join('');
}

window.ltPmLap = (id) => {
    const l = ltPmState.lanes.find(x => x.id === id);
    if(!l) return;
    const now = Date.now();
    playClickSound();
    
    if(!l.running) {
        l.running = true;
        l.startTime = now;
        const btn = document.querySelector(`#pm-l-${id} button`);
        if(btn) {
            btn.textContent = "LAP";
            btn.classList.replace('lt-bg-blue-500', 'lt-bg-gray-800');
        }
    } else {
        const lap = now - l.startTime;
        l.laps.push(lap);
    }
};

function tickPacemaker() {
    const now = Date.now();
    ltPmState.lanes.forEach(l => {
        if(l.running) {
            const el = document.querySelector(`#pm-l-${l.id} .pm-main-time`);
            if(el) el.textContent = fmt(now - l.startTime);
        }
    });
}

// ===== Custom Logic =====
function initCustom() {
    ltCustomSteps = [{type:'WORK', dur:30}, {type:'REST', dur:10}];
    renderCustomSteps();
}
function renderCustomSteps() {
    const box = $("#custom-steps-container");
    if(box) box.innerHTML = ltCustomSteps.map((s, i) => `
        <div style="display:flex; gap:8px; align-items:center;">
           <span>${i+1}.</span>
           <select class="lt-input" onchange="ltCustType(${i}, this.value)">
             <option ${s.type==='WORK'?'selected':''}>WORK</option>
             <option ${s.type==='REST'?'selected':''}>REST</option>
           </select>
           <input type="number" class="lt-input" value="${s.dur}" onchange="ltCustDur(${i}, this.value)" style="width:60px;">
           <button class="lt-bg-red-500 lt-text-white" style="border-radius:4px; padding:4px;" onclick="ltCustDel(${i})">×</button>
        </div>
    `).join('');
}
window.ltCustType = (i, v) => ltCustomSteps[i].type = v;
window.ltCustDur = (i, v) => ltCustomSteps[i].dur = +v;
window.ltCustDel = (i) => { ltCustomSteps.splice(i, 1); renderCustomSteps(); };

const cAdd = $("#custom-add-step-btn"); if(cAdd) cAdd.onclick = () => { ltCustomSteps.push({type:'WORK', dur:30}); renderCustomSteps(); };

const cStart = $("#custom-start-btn"); 
if(cStart) cStart.onclick = () => {
    ltCustomState = {
        running: true, steps: [...ltCustomSteps], 
        rep: 1, totalReps: +$("#custom-reps").value,
        stepIdx: 0, stepStart: Date.now(), remain: ltCustomSteps[0].dur
    };
    $("#custom-settings").classList.add("lt-hidden");
    $("#custom-runner").classList.remove("lt-hidden");
};
const cReset = $("#custom-reset-btn"); 
if(cReset) cReset.onclick = () => {
    ltCustomState.running = false;
    $("#custom-settings").classList.remove("lt-hidden");
    $("#custom-runner").classList.add("lt-hidden");
};

function tickCustomTimer() {
    if(!ltCustomState.running) return;
    const now = Date.now();
    const elapsed = (now - ltCustomState.stepStart) / 1000;
    const curStep = ltCustomState.steps[ltCustomState.stepIdx];
    let rem = curStep.dur - elapsed;
    
    if(rem <= 0) {
        ltCustomState.stepIdx++;
        if(ltCustomState.stepIdx >= ltCustomState.steps.length) {
            ltCustomState.rep++;
            if(ltCustomState.rep > ltCustomState.totalReps) {
                ltCustomState.running = false;
                alert("Finish!");
                $("#custom-reset-btn").click();
                return;
            }
            ltCustomState.stepIdx = 0;
        }
        playClickSound();
        ltCustomState.stepStart = now;
        rem = ltCustomState.steps[ltCustomState.stepIdx].dur;
    }
    
    $("#custom-runner-time").textContent = fmt(rem * 1000).slice(0, 5);
    const runner = $("#custom-runner");
    if(runner) {
        runner.className = `lt-h-full custom-runner ${curStep.type==='WORK'?'work-bg':'rest-bg'}`;
        $("#custom-runner-step-info").textContent = `${curStep.type} (${ltCustomState.stepIdx+1}/${ltCustomState.steps.length})`;
    }
}

// ===== Utils =====
function fmt(ms) {
    if(!Number.isFinite(ms)) return "00:00.00";
    if(ms < 0) ms = 0;
    const min = Math.floor(ms / 60000).toString().padStart(2,'0');
    const sec = Math.floor((ms % 60000) / 1000).toString().padStart(2,'0');
    const msec = Math.floor((ms % 1000) / 10).toString().padStart(2,'0');
    return `${min}:${sec}.${msec}`;
}

function playClickSound() {
    try {
        if(!ltAudioCtx) ltAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if(ltAudioCtx.state === 'suspended') ltAudioCtx.resume();
        const osc = ltAudioCtx.createOscillator();
        const gain = ltAudioCtx.createGain();
        osc.connect(gain); gain.connect(ltAudioCtx.destination);
        osc.frequency.setValueAtTime(800, ltAudioCtx.currentTime);
        gain.gain.setValueAtTime(0.1, ltAudioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ltAudioCtx.currentTime + 0.1);
        osc.start(); osc.stop(ltAudioCtx.currentTime + 0.1);
    } catch(e) {}
}

function stopCustomTimer() {
    if(ltCustomState && ltCustomState.running) {
        ltCustomState.running = false;
        $("#custom-settings")?.classList.remove("lt-hidden");
        $("#custom-runner")?.classList.add("lt-hidden");
    }
}

// ===== Firebase Shared (Mock) =====
let ltSessionUnsub = null;

async function connectLtSession() {
    if(!teamId || !memberId) return;
    
    const msg = document.getElementById("share-status-msg");
    if(msg) { msg.textContent = "ペアを探しています..."; msg.style.color = "var(--primary)"; }
    
    // チームごとに1つの共有セッション部屋(ドキュメント)を用意
    const sessionRef = db.collection('teams').doc(teamId).collection('ltimer').doc('session');
    
    try {
        await db.runTransaction(async (transaction) => {
            const doc = await transaction.get(sessionRef);
            let data = doc.exists ? doc.data() : { user1: null, user2: null };
            
            // 自分がすでに入っているか？
            if (data.user1 === memberId) {
                ltUserId = 'user1';
            } else if (data.user2 === memberId) {
                ltUserId = 'user2';
            } 
            // 空きスロット（先着2名）に入れるか？
            else if (!data.user1) {
                transaction.set(sessionRef, { user1: memberId }, { merge: true });
                ltUserId = 'user1';
            } else if (!data.user2) {
                transaction.set(sessionRef, { user2: memberId }, { merge: true });
                ltUserId = 'user2';
            } else {
                throw new Error("既に他の2人が使用中です");
            }
        });
        
        ltSessionRef = sessionRef; // 接続済みフラグとして保持
        updateLtChooserView();
        
        // セッション状態のリアルタイム監視
        if (ltSessionUnsub) { ltSessionUnsub(); ltSessionUnsub = null; }
        ltSessionUnsub = sessionRef.onSnapshot((doc) => {
            const data = doc.exists ? doc.data() : {};
            const isUser1 = (data.user1 === memberId);
            const isUser2 = (data.user2 === memberId);
            
            // 自分が追い出された（退室処理など）場合
            if (ltUserId && !isUser1 && !isUser2) {
                 disconnectLtSession();
                 if(msg) { msg.textContent = "切断されました"; msg.style.color = "red"; }
                 return;
            }

            const usersCount = (data.user1 ? 1 : 0) + (data.user2 ? 1 : 0);
            
            if (msg) {
                if (usersCount === 2) {
                    msg.textContent = "ペアと接続しました！";
                    msg.style.color = "green";
                } else {
                    msg.textContent = "相手を待っています...";
                    msg.style.color = "var(--primary)";
                }
            }
            
            // ※「タイムの完全な同期」まで行う場合は、ここにFirestore(data.watches等)を
            // 相手の時計に反映させる処理を追記する必要があります。
        });
        
    } catch (e) {
        if(msg) { msg.textContent = e.message; msg.style.color = "red"; }
        console.error(e);
        ltSessionRef = null;
        ltUserId = null;
        updateLtChooserView();
    }
}

// 退室処理（空き枠を返す）
function disconnectLtSession() {
    if(ltSessionRef && ltUserId) {
        ltSessionRef.set({ [ltUserId]: null }, { merge: true }).catch(()=>{});
    }
    if(ltSessionUnsub) { ltSessionUnsub(); ltSessionUnsub = null; }
    ltSessionRef = null; 
    ltUserId = null;
    const msg = document.getElementById("share-status-msg");
    if(msg) msg.textContent = "";
    updateLtChooserView();
}

// タイム同期用の空関数（現状のモック維持）
function updateSharedWatches() {}

// ブラウザを閉じたりリロードした際にも退室して枠を空ける
window.addEventListener('beforeunload', () => {
    if(ltSessionRef && ltUserId) {
        ltSessionRef.set({ [ltUserId]: null }, { merge: true });
    }
});
// ==========================================
// ========== Stadium Map Logic =============
// ==========================================

let mapInstance = null;
let markersLayer = null;
let currentRegionFilter = 'all';

function initStadium() {
  // すでに初期化済みならサイズ再計算だけして終了（地図崩れ防止）
  if(mapInstance) {
    setTimeout(() => { mapInstance.invalidateSize(); }, 200);
    return;
  }

  // 1. 地図の初期化 (初期表示は東京あたり)
  mapInstance = L.map('std-map').setView([36.0, 138.0], 5);

  // 2. 地図タイル (OpenStreetMap) の読み込み
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(mapInstance);

  // 3. マーカーレイヤーグループ作成
  markersLayer = L.layerGroup().addTo(mapInstance);

  // 4. マーカー配置
  renderMapMarkers(STADIUM_DATA);

  // 5. 現在地ボタン
  document.getElementById('std-geo-btn')?.addEventListener('click', () => {
    mapInstance.locate({setView: true, maxZoom: 12});
  });
  
  // 6. 地図内検索
  document.getElementById('std-search-input')?.addEventListener('input', (e) => {
    const val = e.target.value.toLowerCase();
    if(!val) {
        renderMapMarkers(STADIUM_DATA);
        return;
    }
    const filtered = STADIUM_DATA.filter(s => s.name.toLowerCase().includes(val) || s.address.includes(val));
    renderMapMarkers(filtered);
    if(filtered.length > 0) {
        // 最初の結果にズーム
        mapInstance.setView([filtered[0].lat, filtered[0].lng], 10);
    }
  });

  // レンダリング崩れ防止のため少し待ってリサイズ
  setTimeout(() => { mapInstance.invalidateSize(); }, 200);
}
// ★ 追加: 欠けていた関数
function renderRegions() {
  const container = document.getElementById('std-region-overlay');
  if(!container) return;

  // 地域リスト
  const regions = ['すべて', '北海道', '東北', '関東', '中部', '近畿', '中国', '四国', '九州'];
  
  container.innerHTML = regions.map(r => {
    const val = (r === 'すべて') ? 'all' : r;
    const activeClass = (val === currentRegionFilter) ? 'primary' : 'bg-white text-gray-700';
    // スタイル調整（横スクロールしやすいチップ型）
    return `<button 
      class="std-region-chip ${activeClass}" 
      data-region="${val}"
      onclick="selectMapRegion('${val}')"
      style="display:inline-block; margin-right:6px; padding:6px 12px; border-radius:20px; font-size:12px; font-weight:bold; border:1px solid #ddd; box-shadow:0 2px 4px rgba(0,0,0,0.1); flex-shrink:0;">
      ${r}
    </button>`;
  }).join('');
}

// グローバルスコープに関数を公開 (onclickで呼ぶため)
window.selectMapRegion = (region) => {
  currentRegionFilter = region;
  renderRegions(); // ボタンの色を更新
  applyMapFilters(); // 地図を更新
};

function applyMapFilters() {
  const keyword = document.getElementById('std-search-input')?.value.toLowerCase() || '';
  
  const filtered = STADIUM_DATA.filter(s => {
    // 地域フィルタ
    const matchRegion = (currentRegionFilter === 'all') || (s.region === currentRegionFilter);
    // 検索ワードフィルタ
    const matchKey = !keyword || s.name.toLowerCase().includes(keyword) || s.address.includes(keyword);
    
    return matchRegion && matchKey;
  });

  renderMapMarkers(filtered);
  
  // 絞り込み結果が1つ以上あれば、最初のピンにズーム
  if(filtered.length > 0 && (keyword || currentRegionFilter !== 'all')) {
    // 複数の場合は範囲に合わせる手もあるが、簡易的に最初の要素へ
    mapInstance.setView([filtered[0].lat, filtered[0].lng], 10);
  }
}
function renderMapMarkers(list) {
  if(!markersLayer) return;
  markersLayer.clearLayers();

  list.forEach(s => {
    // マーカーを作成
    const marker = L.marker([s.lat, s.lng]);
    
    // ポップアップの中身 (HTML)
    const popupContent = `
      <div class="std-popup-title">${s.name}</div>
      <div class="std-popup-addr">${s.address}</div>
      <div class="std-popup-actions">
        ${s.url ? `<a href="${s.url}" target="_blank" class="std-popup-btn btn-web">🌐 公式HPを開く</a>` : ''}
        <button class="std-popup-btn btn-plan" onclick="addToPlan('${s.name}')">📅 行く予定に追加</button>
      </div>
    `;

    marker.bindPopup(popupContent);
    markersLayer.addLayer(marker);
  });
}

// 行く予定に追加ボタンの処理
window.addToPlan = (stadiumName) => {
  if(!confirm(`「${stadiumName}」へ行く予定を立てますか？\n（予定作成画面へ移動します）`)) return;
  
  // 予定作成画面へ遷移し、タイトルに競技場名を入れる等の連携
  switchTab('plans');
  
  // 少し強引ですが、UIが切り替わった後にフォームに入力する
  setTimeout(() => {
    // もし予定追加用のモーダルや入力欄があればそこに値を入れる
    // 現状のplans実装に合わせて調整してください。ここでは例としてアラートのみ。
    // 例: document.getElementById('planTitleInput').value = stadiumName + "で練習";
    alert(`「${stadiumName}」での練習予定を作成してください。`);
  }, 500);
};
// 入力の自動保存（デバウンス）
function makeJournalAutoSaver(delayMs=700){
  let t=null;
  return function(){
    clearTimeout(t);
    t=setTimeout(()=>saveJournal(), delayMs);
  };
}

// 日誌の保存（修正版：新しいIDと睡眠時間に対応）
async function saveJournal(){
  // 新しい画面ID (j-*) を優先し、無ければ古いID (distInput等) を探す安全策
  const distEl = document.getElementById("j-dist") || document.getElementById("distInput");
  const weightEl = document.getElementById("j-weight") || document.getElementById("weightInput");
  const sleepEl = document.getElementById("j-sleep"); // 新設
  const trainEl = document.getElementById("j-train") || document.getElementById("trainInput");
  const feelEl = document.getElementById("j-feel") || document.getElementById("feelInput");
  const condEl = document.getElementById("j-condition");

  // コンディション取得 (プルダウン優先、なければボタン式)
  let conditionVal = null;
  if(condEl) {
      conditionVal = Number(condEl.value);
  } else {
      const activeBtn = document.querySelector('#conditionBtns button.active');
      if(activeBtn) conditionVal = Number(activeBtn.dataset.val);
  }

  const docRef = getJournalRef(teamId, memberId, selDate);
  
  const journalData = {
    dist: distEl ? Number(distEl.value||0) : 0,
    weight: weightEl ? Number(weightEl.value||0) : 0,
    sleep: $("#j-sleep") ? $("#j-sleep").value : "",
    train: trainEl ? trainEl.value : "",
    feel: feelEl ? feelEl.value : "",
    condition: conditionVal,
  };

  // マージ保存
  await docRef.set(journalData, {merge:true});
  
  dirty={ dist:false, train:false, feel:false, weight:false, sleep:false };
}

// デバウンス処理（連打防止）
let _saveTimer = null;
function saveJournalDebounced(srcTeam) {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(saveJournal, 800);
}

// ===== Global: 端/上部スワイプでタブ移動 =====
// タブ移動のロジックも、日誌画面の時だけ有効にするように調整が必要かもしれないが、
// switchTabが適切にハンドリングするのでそのままでも致命的ではない。
// ただし、TAB_ORDER に 'home' は含めない方がスワイプで意図せずホームに戻らなくて良い。
// 現在の TAB_ORDER = ['journal','month','plans','dashboard','memo']; 
// これを日誌画面用の順序に変更する。
const TAB_ORDER = ['journal', 'month', 'dashboard']; // 日誌画面内のタブのみ

function getActiveTabIndex(){
  // 現在アクティブなタブボタンを探す
  const activeBtn = document.querySelector('.tab.active');
  if(!activeBtn) return -1; // ホームや単独画面では -1
  return TAB_ORDER.indexOf(activeBtn.dataset.tab);
}

function goTabDelta(delta){
  let i = getActiveTabIndex();
  if (i < 0) return; // 日誌画面以外ではスワイプ切り替え無効
  
  const n = TAB_ORDER.length;
  i = (i + delta + n) % n;
  switchTab(TAB_ORDER[i], true);
}
// 部位リスト定義
const BODY_PARTS_LIST = [
  {id:'neck', label:'首'}, {id:'shoulder', label:'肩'}, {id:'back', label:'背中'}, {id:'waist', label:'腰'},
  {id:'glute_l', label:'左臀部'}, {id:'glute_r', label:'右臀部'},
  {id:'groin_l', label:'左股関節'}, {id:'groin_r', label:'右股関節'},
  {id:'quad_l', label:'左前もも'}, {id:'quad_r', label:'右前もも'},
  {id:'hams_l', label:'左ハム'}, {id:'hams_r', label:'右ハム'},
  {id:'knee_l', label:'左膝'}, {id:'knee_r', label:'右膝'},
  {id:'calf_l', label:'左ふくらはぎ'}, {id:'calf_r', label:'右ふくらはぎ'},
  {id:'shin_l', label:'左すね'}, {id:'shin_r', label:'右すね'},
  {id:'ankle_l', label:'左足首'}, {id:'ankle_r', label:'右足首'},
  {id:'foot_l', label:'左足裏'}, {id:'foot_r', label:'右足裏'}
];

// ... (前略)

// ★追加: お気に入りボタンの見た目を更新する関数（これが抜けていました）
function updateFavBtnUI(isFav) {
  const btn = document.getElementById("favBtn");
  if(!btn) return;
  if(isFav) {
    btn.textContent = "★";
    btn.classList.add("active");
    btn.style.color = "#f59e0b"; // 金色
  } else {
    btn.textContent = "☆";
    btn.classList.remove("active");
    btn.style.color = "#ccc";    // 灰色
  }
}


function initJournal(){
  const scheduleAutoSave = makeJournalAutoSaver(700);
  $("#distInput")?.addEventListener("input", ()=>{ dirty.dist=true; scheduleAutoSave(); renderWeek(); });
  $("#weightInput")?.addEventListener("input", ()=>{ dirty.weight=true; scheduleAutoSave(); });
  $("#j-sleep")?.addEventListener("input", ()=>{ dirty.sleep=true; scheduleAutoSave(); });
  // ▼▼▼ 修正: 練習内容（入力中に伸びる） ▼▼▼
  $("#trainInput")?.addEventListener("input", (e)=>{ 
    dirty.train=true; 
    scheduleAutoSave(); 
    autoResizeTextarea(e.target); 
  });

  // ▼▼▼ 修正: 感想欄（入力中に伸びる） ▼▼▼
  $("#feelInput")?.addEventListener("input", (e)=>{ 
    dirty.feel=true; 
    scheduleAutoSave(); 
    autoResizeTextarea(e.target); 
  });
  // パレット（お絵かき用）
  const brushBtns=$$('.palette .lvl, .palette #eraser');
  brushBtns.forEach(b=>b.addEventListener('click',()=>{
    brush.lvl=Number(b.dataset.lvl)||1;
    brush.erase=b.id==='eraser';
    brushBtns.forEach(btn=>btn.classList.remove('active'));
    b.classList.add('active');
  }));
  if(brushBtns.length) $('.palette .lvl[data-lvl="1"]')?.classList.add('active');

  // クイックタグ
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
      tx.set(docRef,{ tags:curr },{merge:true});
    });
    renderWeek();
  }));

  // ★追加: 部位タグ（Fatigue Parts）生成とイベント
  const partsArea = document.getElementById('partsTagArea');
  if(partsArea){
    partsArea.innerHTML = '';
    BODY_PARTS_LIST.forEach(p => {
      const sp = document.createElement('span');
      sp.className = 'part-tag';
      sp.textContent = p.label;
      sp.dataset.id = p.id;
      sp.dataset.lvl = "0"; // 0:なし, 1:軽, 2:中, 3:重
      
      sp.addEventListener('click', async () => {
        // クリックでレベルローテーション: 0 -> 1 -> 2 -> 3 -> 0
        let cur = Number(sp.dataset.lvl);
        let next = (cur + 1) % 4;
        
        // UI即時反映
        sp.dataset.lvl = next;
        sp.className = 'part-tag' + (next > 0 ? ` lv${next}` : '');

        // 保存 (partsフィールドに { id: level } 形式で保存)
        const docRef = getJournalRef(teamId, memberId, selDate);
        // ※Firestoreの map型の一部更新
        // 0なら削除(FieldDelete)、それ以外ならセット
        const payload = next === 0 
          ? { [`parts.${p.id}`]: firebase.firestore.FieldValue.delete() }
          : { [`parts.${p.id}`]: next };
          
        await docRef.set(payload, { merge: true });
      });
      partsArea.appendChild(sp);
    });
  }
  // app.js の initJournal 関数（シェアモード部分）

  $("#shareModeBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (document.body.classList.contains("share-mode")) {}

    document.body.classList.add("share-mode");
    const btn = $("#shareModeBtn");
    btn.textContent = "✖"; btn.style.color = "#ef4444"; btn.style.background = "#fff";

    // ... (前略)
    // 1. ヘッダー作成 (チーム名を追加)
    let shareHeader = document.getElementById("shareHeaderOverlay");
    if (!shareHeader) {
      shareHeader = document.createElement("div");
      shareHeader.id = "shareHeaderOverlay";
      const app = document.getElementById("app");
      app.insertBefore(shareHeader, app.firstChild);
    }
    const y = selDate.getFullYear(), m = selDate.getMonth()+1, d = selDate.getDate();
    const w = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][selDate.getDay()];
    
    // ★修正: チーム名を表示に追加
    shareHeader.innerHTML = `
      <div class="share-header-inner">
        <div class="share-date">
          <span style="font-size:1.4em; font-weight:800; letter-spacing:-1px;">${y}.${m}.${d}</span>
          <span style="font-size:0.9em; color:#ea580c; font-weight:bold; margin-left:6px;">${w}</span>
        </div>
        <div class="share-meta" style="display:flex; align-items:baseline; gap:8px; margin-top:4px;">
           <span style="font-size:0.9rem; color:#9ca3af; font-weight:bold;">${teamId}</span>
           <span class="share-name" style="font-size:1.2rem; color:#1f2937; font-weight:bold;">${getDisplayName(viewingMemberId)}</span>
        </div>
      </div>
      <div class="share-brand">AthLog</div>
    `;
    shareHeader.style.display = "flex";
    // ... (後略)

    // 2. 「調子」を睡眠の横に追加
    const activeCondBtn = document.querySelector('#conditionBtns button.active');
    const circled = {"1":"①","2":"②","3":"③","4":"④","5":"⑤"};
    const condVal = circled[activeCondBtn?.dataset.val] || "-";

    // ★修正: 睡眠(#j-sleep)を見つけて、その隣に置く
    const sleepInput = document.getElementById('j-sleep');
    // <div class="journal-stats-item"> <label>睡眠</label> <input id="j-sleep"> </div> という構造を想定
    // そのため、inputの親要素(div)を取得します
    const sleepWrapper = sleepInput ? sleepInput.closest('div') : null; 
    
    if(sleepWrapper && sleepWrapper.parentNode) {
      const condItem = document.createElement("div");
      condItem.className = "added-cond-item"; // スタイル用のクラス
      
      // 睡眠などのスタイルを真似る
      condItem.innerHTML = `
        <label>調子</label>
        <div class="share-val">${condVal}</div>
      `;
      // insertBefore(追加要素, 睡眠の次の兄弟要素) -> これで確実に「睡眠」の「次」に入ります
      sleepWrapper.parentNode.insertBefore(condItem, sleepWrapper.nextSibling);
      const appBox = document.getElementById("app");
      const mmWrap = document.getElementById("mmWrap");
      if (appBox && mmWrap) {
          mmOriginalParent = mmWrap.parentNode;
          mmOriginalNext = mmWrap.nextSibling;
          // カード(#app)の最後尾に移動（これで確実に下に来ます）
          appBox.appendChild(mmWrap);
      }
    }
    // 解除関数
    function exitShareMode() {
       document.body.classList.remove("share-mode");
       const b = $("#shareModeBtn");
       if(b) { b.textContent = "📷"; b.style.color = ""; b.style.background = ""; }
       if(shareHeader) shareHeader.style.display = "none";
       document.querySelectorAll(".added-cond-item").forEach(el => el.remove());
       
       // ▼▼▼ 修正箇所 2: 筋肉図を元の場所に戻す ▼▼▼
       if (mmWrap && mmOriginalParent) {
           // 記録しておいた「親」の中の「次の兄弟」の前に戻す
           // (nextがnullなら末尾に追加されるので安全です)
           mmOriginalParent.insertBefore(mmWrap, mmOriginalNext);
       }
       // ▲▲▲ 修正箇所 2 終わり ▲▲▲

       document.removeEventListener("click", exitShareMode);
    }
    setTimeout(() => { document.addEventListener("click", exitShareMode); }, 100);
  });
  
  $("#weekPrev")?.addEventListener("click",()=>{ selDate=addDays(selDate,-7); renderJournal(); });
  $("#weekNext")?.addEventListener("click",()=>{ selDate=addDays(selDate, 7); renderJournal(); });
  // ★追加: 日移動ボタンの処理
  $("#dayPrev")?.addEventListener("click",()=>{ selDate=addDays(selDate,-1); renderJournal(); });
  $("#dayNext")?.addEventListener("click",()=>{ selDate=addDays(selDate, 1); renderJournal(); });

  // ★追加: お気に入りボタンの処理
  $("#favBtn")?.addEventListener("click", async ()=>{
    const btn = $("#favBtn");
    const isActive = btn.classList.contains("active");
    const newState = !isActive;
    
    // UIを即時反映（サクサク動くように）
    updateFavBtnUI(newState);

    // 保存
    const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
    await getJournalRef(srcTeam, viewingMemberId, selDate).set({ favorite: newState }, { merge: true });
    
    // 変更があったので月一覧などを更新が必要ならフラグを立てるなど（今回は簡易的に何もしない）
  });
  $("#gotoToday")?.addEventListener("click",()=>{ selDate=new Date(); renderJournal(); });
  $("#datePicker")?.addEventListener("change",(e)=>{ selDate=parseDateInput(e.target.value); renderJournal(); });

  // 反映ボタン
  $("#mergeBtn")?.addEventListener("click", async ()=>{
    const scope  = $("#mergeScope").value;                
    // タグ関連の引数を削除
    const text  = await collectPlansTextForDay(selDate, scope);
    if(text) $("#trainInput").value = ($("#trainInput").value ? ($("#trainInput").value+"\n") : "") + text;
    
    const types = await collectPlansTypesForDay(selDate, scope);
    if(types.length){
      const docRef=getJournalRef(teamId,memberId,selDate);
      await docRef.set({ tags: types.slice(0,2) },{merge:true});
      renderWeek();
    }
  });

  // コンディション
  $$('#conditionBtns button').forEach(btn=>{
    btn.addEventListener('click',()=>{
      $$('#conditionBtns button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const scheduleAutoSave = makeJournalAutoSaver(500);
      scheduleAutoSave();
    });
  });

  // 初期化
  initMuscleMap();       
  initJournalSwipeNav();
  const condBtns = document.getElementById('conditionBtns');
  if(condBtns && condBtns.previousElementSibling) {
      condBtns.previousElementSibling.classList.add('share-hide');
  }
  tscInitOnce();
  // ★重要: スクショボタンのリスナーなどは省略しませんが、長くなるので元のコードにtn 処理などはそのまま維持してください
}

// 部位タグの状態をDBから読んで反映する関数 (renderJournal内で呼び出される)
function renderPartsTags(j){
  const parts = j.parts || {};
  document.querySelectorAll('.part-tag').forEach(el => {
    const id = el.dataset.id;
    const lvl = parts[id] || 0;
    el.dataset.lvl = lvl;
    el.className = 'part-tag' + (lvl > 0 ? ` lv${lvl}` : '');
  });
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

async function renderJournal(){
  // 前回の購読を解除（重複防止）
  if (unsubscribeJournal) unsubscribeJournal();
  
  // 表示するメンバーIDの確定
  if (!viewingMemberId) viewingMemberId = memberId;

  dirty = { dist:false, train:false, feel:false };

  // ★修正1: 読み込み待ちの間に前のデータが残らないよう、先に入力欄をクリアする
  if(document.getElementById("distInput")) document.getElementById("distInput").value = "";
  if(document.getElementById("weightInput")) document.getElementById("weightInput").value = "";
  if(document.getElementById("j-sleep")) document.getElementById("j-sleep").value = "";
  if(document.getElementById("trainInput")) document.getElementById("trainInput").value = "";
  if(document.getElementById("feelInput")) document.getElementById("feelInput").value = "";
  
  // ボタンやタグの見た目もリセット
  $$('#conditionBtns button').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.part-tag').forEach(el => {
    el.dataset.lvl = "0"; el.className = 'part-tag';
  });
  if(typeof renderQuickButtons === 'function') renderQuickButtons({ tags:[] });
  if(typeof renderRegions === 'function') renderRegions({});


  // 編集権限の確認と入力欄の制御
  const editableHere = isEditableHere(teamId, memberId, viewingMemberId);

  // ★修正2: 無効化リストに '#shareModeBtn' (📷ボタン) を追加
  $$('#journal input, #journal textarea, #journal .qbtn, #saveBtn, #mergeBtn, #conditionBtns button, .palette button, #shareModeBtn')
    .forEach(el=>{
      const isNavControl = ['weekPrev','weekNext','gotoToday','datePicker'].includes(el.id);
      if (!isNavControl) el.disabled = !editableHere;
    });

  $("#teamSharedComment")?.removeAttribute("disabled");
  refreshBadges();

  // マージスコープ（予定反映）の選択肢作成
  const mergeScopeSelect = $("#mergeScope");
  if (mergeScopeSelect){
    mergeScopeSelect.innerHTML =
      `<option value="auto">予定から追加(自動)</option>
       <option value="${memberId}">${getDisplayName(memberId)}の予定</option>
       <option value="team">全員の予定</option>`;
  }

  // 日付ピッカーの表示更新
  $("#datePicker").value = ymd(selDate);

  // ▼▼▼ データ読み込み処理 ▼▼▼
  // ここで通信待ちが発生しますが、既にクリア済みなので古いデータは表示されません
  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
  
  // リアルタイムでデータを監視してフォームに反映
  unsubscribeJournal = getJournalRef(srcTeam, viewingMemberId, selDate).onSnapshot(doc => {
    const data = doc.data() || {};
    lastJournal = data; // 筋肉マップ等のために保持

    // 各入力欄にデータをセット
    if(document.getElementById("distInput")) document.getElementById("distInput").value = data.dist || "";
    if(document.getElementById("weightInput")) document.getElementById("weightInput").value = data.weight || "";
    
    // 睡眠時間
    if(document.getElementById("j-sleep")) document.getElementById("j-sleep").value = data.sleep || "";

    // ▼▼▼ 修正: データをセットした直後にリサイズを実行（setTimeoutで確実にする） ▼▼▼
    if(!dirty.train) {
      const el = document.getElementById("trainInput");
      if(el) {
        el.value = data.train || "";
        // 描画が完了した直後に高さを計算させる
        setTimeout(() => autoResizeTextarea(el), 10);
      }
    }

    if(!dirty.feel) {
      const el = document.getElementById("feelInput");
      if(el) {
        el.value = data.feel || "";
        // 描画が完了した直後に高さを計算させる
        setTimeout(() => autoResizeTextarea(el), 10);
      }
    }
    // お気に入りボタンUI更新（関数があれば）
    if(typeof updateFavBtnUI === 'function') updateFavBtnUI(!!data.favorite);

    // コンディションボタンの選択状態反映
    const cond = data.condition;
    document.querySelectorAll('#conditionBtns button').forEach(b => {
      if(Number(b.dataset.val) === cond) b.classList.add('active');
      else b.classList.remove('active');
    });

    // その他表示の更新
    renderQuickButtons(data);
    if(typeof drawMuscleFromDoc === 'function') drawMuscleFromDoc(data);
    if(typeof renderPartsTags === 'function') renderPartsTags(data);
    
    // 週カレンダーやサマリも更新
    if(typeof renderWeek === 'function') renderWeek();
    if(typeof updateDistanceSummary === 'function') updateDistanceSummary();
    if(typeof tscRefresh === 'function') tscRefresh();

  }, err => {
    console.error("Journal load error:", err);
  });
  // ▲▲▲ データ読み込み処理 ここまで ▲▲▲
}
let renderWeekRequestId = 0;

async function renderWeek(){
  const chips=$("#weekChips"); if(!chips) return;
  
  // 今回のリクエストIDを発行
  const myRequestId = ++renderWeekRequestId;

  // 1. 日付リストとチームIDを先に確定させる
  const days = getWeekDates(selDate);
  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);

  // 2. 7日分のデータを「並列で」一気に取得する (Promise.all)
  //    これまでの「1日ずつ await」だと遅い上に競合の原因になる
  const promises = days.map(d => getJournalRef(srcTeam, viewingMemberId, d).get());
  const snapshots = await Promise.all(promises);

  // 3. ★重要★ データ取得中に、別の新しい描画リクエスト(スクロール等)が来ていたら、
  //    この古い処理はここで打ち切る（何もしない）
  if (myRequestId !== renderWeekRequestId) return;

  // 4. 描画処理（同期的に一気に行う）
  chips.innerHTML = "";
  
  snapshots.forEach((doc, i) => {
    const d = days[i];
    const key = ymd(d);
    const j = doc.data() || {};
    
    const btn = document.createElement("button");
    btn.className = "chip" + (ymd(selDate) === key ? " active" : "");
    const tags = j.tags || [];
    
    // 中身の生成
    btn.innerHTML = `<div>${["日","月","火","水","木","金","土"][d.getDay()]} ${d.getDate()}</div><div class="km">${(j.dist||0)}km</div>`;
    
    // スタイルの適用
    btn.style.background = ''; 
    btn.style.color = '';
    if(tags.length){
      const map={ ジョグ:"var(--q-jog)", ポイント:"var(--q-point)", 補強:"var(--q-sup)", オフ:"var(--q-off)", その他:"var(--q-other)" };
      btn.style.color = '#1f2937';
      if(tags.length === 1) {
        btn.style.backgroundColor = map[tags[0]];
      } else {
        btn.style.background = `linear-gradient(90deg, ${map[tags[0]]} 50%, ${map[tags[1]]} 50%)`;
      }
    }
    
    btn.addEventListener("click", () => { selDate = d; renderJournal(); });
    chips.appendChild(btn);
  });
}

// 1日移動ボタン用（修正版: async を追加）
async function moveDay(n) {
  selDate.setDate(selDate.getDate() + n);
  
  // 日付ピッカーの表示更新
  const dp = document.getElementById("datePicker");
  if(dp) dp.value = ymd(selDate);

  // 日誌画面更新
  await renderJournal();
  
  // もし週表示（renderWeek）も使っている場合はここも更新
  if(typeof renderWeek === 'function') {
      await renderWeek(); 
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
  $("#monthFavFilterBtn")?.addEventListener("click", () => {
    monthFavOnly = !monthFavOnly; // ON/OFF切り替え
    const btn = $("#monthFavFilterBtn");
    if (monthFavOnly) {
      btn.style.color = "#f59e0b";
      btn.style.borderColor = "#f59e0b";
      btn.style.background = "#fffbeb";
    } else {
      btn.style.color = "#ccc";
      btn.style.borderColor = "#eee";
      btn.style.background = "transparent";
    }
    renderMonth(); // 再描画
  });
  // app.js の initMonth 関数内に追加

  // ... (前略: monthFavFilterBtn の処理など) ...

  // ▼▼▼ 追加: 検索機能 ▼▼▼
  const searchInput = document.getElementById("monthSearchInput");
  const searchBtn = document.getElementById("monthSearchBtn");

  // 検索実行関数
  const doSearch = async () => {
    const keyword = searchInput.value.trim();
    
    // キーワードが空なら通常の月表示に戻す
    if (!keyword) {
      renderMonth();
      return;
    }

    const box = document.getElementById("monthList");
    if(!box) return;
    
    box.innerHTML = '<div style="padding:20px; text-align:center; color:#666;">検索中...</div>';
    
    // 合計距離表示などは隠す
    const sumEl = document.getElementById("monthSum");
    if(sumEl) sumEl.textContent = `検索結果: "${keyword}"`;

    try {
      const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
      
      // 過去365日分などの制限を設けて取得（全データ取得は重いため）
      // ここでは簡易的に「journalコレクション全体」から取得してクライアント側でフィルタリングします
      // ※データ量が数千件レベルならこれでも動きますが、多すぎる場合は limit を検討してください
      const snapshot = await db.collection('teams').doc(srcTeam)
                               .collection('members').doc(viewingMemberId)
                               .collection('journal')
                               .orderBy(firebase.firestore.FieldPath.documentId(), 'desc') // 日付(ID)の降順
                               .limit(300) // 安全のため直近300件に制限
                               .get();

      box.innerHTML = "";
      let count = 0;

      snapshot.forEach(doc => {
        const data = doc.data();
        const train = data.train || "";
        const feel = data.feel || "";
        
        // キーワードが含まれるかチェック (大文字小文字無視なしの単純部分一致)
        if (train.includes(keyword) || feel.includes(keyword)) {
          count++;
          const dateKey = doc.id; // "YYYY-MM-DD"
          
          // リストアイテム生成（月一覧と似たデザインだが日付をフル表示）
          const row = document.createElement("div");
          row.className = "row";
          // 日付部分
          const dObj = parseDateInput(dateKey);
          const dowStr = ["日","月","火","水","木","金","土"][dObj.getDay()];
          
          row.innerHTML = `
            <div class="dow" style="width:auto; padding:0 8px; font-size:11px;">
               ${dateKey}<br>(${dowStr})
            </div>
            <div class="txt">
               <div class="month-one-line">
                 <span class="km">${data.dist ? data.dist+"km" : ""}</span>
                 <span class="month-train-ellipsis" style="color:#333;">${train.replace(keyword, `<b style="color:red;background:#ff0;">${keyword}</b>`)}</span>
               </div>
               <div style="font-size:10px; color:#666; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;">
                 ${feel.replace(keyword, `<b style="color:red;background:#ff0;">${keyword}</b>`)}
               </div>
            </div>
          `;
          
          // クリックでその日の日誌へ
          row.addEventListener("click", () => { 
            selDate = dObj; 
            switchTab("journal"); 
          });
          
          box.appendChild(row);
        }
      });

      if (count === 0) {
        box.innerHTML = '<div style="padding:20px; text-align:center; color:#999;">見つかりませんでした</div>';
      } else {
        if(sumEl) sumEl.textContent = `"${keyword}" の検索結果: ${count}件`;
      }

    } catch(e) {
      console.error(e);
      box.innerHTML = '<div style="padding:20px; text-align:center; color:red;">エラーが発生しました</div>';
    }
  };

  if(searchBtn) searchBtn.addEventListener("click", doSearch);
  if(searchInput) searchInput.addEventListener("keydown", (e) => { if(e.key === "Enter") doSearch(); });
  
  // ▲▲▲ 追加ここまで ▲▲▲
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
// ■ renderMonth関数（月一覧の表示）
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
      <div class="dow" id="dow_${dayKey}"> <span>${dow}${d}</span></div>
      <div class="txt"><div>—</div></div>
    `;
    row.addEventListener("click", () => { selDate = dt; switchTab("journal"); });
    box.appendChild(row);
  
    // 非同期で詳細データを読み込み
    (async (dtLocal, key) => {
      try {
        const snap = await getJournalRef(srcTeam, viewingMemberId, dtLocal).get();
        const j = snap.data() || {};
  
        // ▼ フィルター機能: 「★のみ」モードで、お気に入りがなければ隠す
        if (typeof monthFavOnly !== 'undefined' && monthFavOnly && !j.favorite) {
          row.style.display = 'none';
          // 合計距離には含めない場合はここで return もありですが、
          // 通常は「表示フィルタ」だけなので計算は続けることが多いです。
          // 今回は表示だけ消して計算は続けます。
        }

        // 合計距離の更新
        const add = Number(j.dist || 0);
        if (!Number.isNaN(add)) {
          sum += add;
          const sumEl = document.getElementById("monthSum");
          if (sumEl) sumEl.textContent = `月間走行距離: ${sum.toFixed(1)} km`;
        }

        // ▼▼▼ 変数の宣言は必ずここ（使う前）で行う ▼▼▼
        const dowEl = document.getElementById(`dow_${key}`);
        
        // 1. 縦色ラベル（typebar）の色反映
        const tags = Array.isArray(j.tags) ? j.tags.slice(0, 2) : [];
        const colorMap = {
          ジョグ:   'var(--q-jog)',
          ポイント: 'var(--q-point)',
          補強:     'var(--q-sup)',
          オフ:     'var(--q-off)',
          その他:   'var(--q-other)'
        };
        if (dowEl) {
          if (tags.length === 0) {
            dowEl.style.background = 'var(--panel)';
          } else if (tags.length === 1) {
            dowEl.style.background = colorMap[tags[0]] || 'var(--panel)';
            dowEl.style.color = '#1f2937';
          } else {
            const c1 = colorMap[tags[0]] || 'var(--panel)';
            const c2 = colorMap[tags[1]] || 'var(--panel)';
            dowEl.style.background = `linear-gradient(${c1} 0 50%, ${c2} 50% 100%)`;
            dowEl.style.color = '#1f2937';
          }
        }
  
        // 2. お気に入りマーク（★）の表示
        if(dowEl && j.favorite) {
           dowEl.innerHTML += `<span style="color:#f59e0b; font-size:10px; position:absolute; top:0; right:2px;">★</span>`;
           dowEl.style.position = 'relative';
        }

        // コンディション表示と本文
        const cond = (j.condition != null) ? Number(j.condition) : null;
        const condHtml = (cond && cond >= 1 && cond <= 5)
          ? `<span class="cond-pill cond-${cond}">${cond}</span>`
          : `<span class="cond-pill cond-3" style="opacity:.4">–</span>`;
  
        const txt = row.querySelector(".txt");
        if (txt) {
          let feelTxt = j.feel || "";
          let trainTxt = escapeHtml(j.train || "—");
          // let feelTxt = escapeHtml(j.feel || ""); // 使っている場合
          
          txt.innerHTML = `
            <div class="month-one-line">
              <span class="km">${j.dist ? ` / ${j.dist}km` : ""}</span><span class="month-train-ellipsis">${trainTxt}</span>
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
  div.innerHTML=`<span class="name">${getDisplayName(m.mem)}</span><span class="txt">${escapeHtml(m.txt)}</span><span class="muted">  ${time}</span>`;
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
        const scope=$("#planScope")?.value || viewingMemberId; 
        // タグフィルタリング処理を削除
        const arr=[];
        snapshot.docs.forEach(doc=>{
          const it=doc.data();
          if(scope==="team" && it.scope!=="team") return;
          if(scope!=="all" && scope!=="team" && it.mem!==scope) return;
          arr.push(it);
        });
        const targetEl=document.getElementById("pl_"+dayKey);
        if(!targetEl) return;
        targetEl.innerHTML = arr.length
          ? arr.map(x=>`
              <span style="display:inline-flex; align-items:center; gap:6px; margin:2px 8px 2px 0;">
                <span class="cat-tag ${classMap[x.type]||""}">${x.type}</span>
                <span>${escapeHtml(x.content)}</span>
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
      div.innerHTML=`<span class="name">${getDisplayName(m.mem)}</span><span class="txt">${escapeHtml(m.txt)}</span><span class="muted">  ${time}</span>`;
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
  const pType=$("#ptype",modalDiv), pScope=$("#pscope",modalDiv), pContent=$("#pcontent",modalDiv);
  const resetForm=()=>{
    editingId=null;
    pType.value="ジョグ"; pScope.value="self"; pContent.value="";
    pActionBtn.textContent="追加"; pDeleteBtn.style.display="none";
    $$("#plist .row",modalDiv).forEach(r=>r.style.outline='none');
  };
  const editItem=(id,targetRow)=>{
    const planDocRef=getPlansCollectionRef(teamId).doc(dayKey).collection('events').doc(id);
    planDocRef.get().then(doc=>{
      const item=doc.data();
      if(!item || item.mem!==memberId) return;
      editingId=id;
      pType.value=item.type; pScope.value=item.scope; pContent.value=item.content;
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


async function collectPlansTypesForDay(day, scopeSel){
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
  $("#weightModeBtn")?.addEventListener('click', ()=>{
    weightMode = (weightMode === 'day') ? 'week' : (weightMode === 'week') ? 'month' : 'day';
    $("#weightModeBtn").textContent = (weightMode === 'day') ? '日' : (weightMode === 'week') ? '週' : '月';
    weightOffset = 0;
    renderWeightChart();
  });
  $("#weightPrev")?.addEventListener('click', ()=>{ weightOffset--; renderWeightChart(); });
  $("#weightNext")?.addEventListener('click', ()=>{ weightOffset++; renderWeightChart(); });
}
function renderDashboard(){ renderAllDistanceCharts(); renderConditionChart(); renderWeightChart(); renderTypePieChart();}
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

// 体重＆睡眠グラフの描画
async function renderWeightChart(){
  const ctx = document.getElementById('weightChart')?.getContext('2d');
  if(!ctx) return;

  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
  const snaps = await db.collection('teams').doc(srcTeam).collection('members').doc(viewingMemberId).collection('journal').get();
  const journal = {}; 
  snaps.forEach(doc => journal[doc.id] = doc.data());

  const labels = [];
  const weightData = [];
  const sleepData = []; // ★追加
  
  const today = new Date(); today.setHours(0,0,0,0);
  let start, end;
  
  // 期間計算 (Day/Week/Month)
  if(weightMode === 'day'){
    const len = 14;
    end = addDays(today, weightOffset * len);
    start = addDays(end, -len + 1);
    for(let i=0; i<len; i++){
      const d = addDays(start, i);
      labels.push(`${d.getMonth()+1}/${d.getDate()}`);
      const j = journal[ymd(d)];
      weightData.push(j?.weight ? Number(j.weight) : null);
      sleepData.push(j?.sleep ? Number(j.sleep) : null); // ★睡眠
    }
    $("#weightRangeLabel").textContent = `${ymd(start)}~`;
  } else if(weightMode === 'week'){
    // ... (週モードも同様に追加) ...
    const len = 12;
    const baseWeek = addDays(startOfWeek(today), weightOffset * len * 7);
    for(let i=len-1; i>=0; i--){
      const ws = addDays(baseWeek, -i * 7);
      labels.push(`${ws.getMonth()+1}/${ws.getDate()}`);
      let sumW=0, cntW=0, sumS=0, cntS=0;
      for(let j=0; j<7; j++){
        const d = addDays(ws, j);
        const val = journal[ymd(d)];
        if(val?.weight){ sumW+=Number(val.weight); cntW++; }
        if(val?.sleep){ sumS+=Number(val.sleep); cntS++; }
      }
      weightData.push(cntW>0 ? (sumW/cntW).toFixed(1) : null);
      sleepData.push(cntS>0 ? (sumS/cntS).toFixed(1) : null);
    }
    const rStart = addDays(baseWeek, -(len-1)*7);
    $("#weightRangeLabel").textContent = `${ymd(rStart)}~`;
  } else {
    // ... (月モード) ...
    const len = 12;
    const baseMonth = new Date(today); baseMonth.setDate(1);
    baseMonth.setMonth(baseMonth.getMonth() + (weightOffset * len));
    for(let i=len-1; i>=0; i--){
      const d = new Date(baseMonth); d.setMonth(d.getMonth() - i);
      const mStr = getMonthStr(d);
      labels.push(`${d.getMonth()+1}月`);
      let sumW=0, cntW=0, sumS=0, cntS=0;
      for(const k in journal){
        if(k.startsWith(mStr)){
           if(journal[k].weight){ sumW+=Number(journal[k].weight); cntW++; }
           if(journal[k].sleep){ sumS+=Number(journal[k].sleep); cntS++; }
        }
      }
      weightData.push(cntW>0 ? (sumW/cntW).toFixed(1) : null);
      sleepData.push(cntS>0 ? (sumS/cntS).toFixed(1) : null);
    }
    const sDate = new Date(baseMonth); sDate.setMonth(sDate.getMonth()-(len-1));
    $("#weightRangeLabel").textContent = `${sDate.getFullYear()}/${sDate.getMonth()+1}~`;
  }

  if(weightChart) weightChart.destroy();
  weightChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: '体重 (kg)',
          data: weightData,
          borderColor: 'rgba(234, 88, 12, 1)', // オレンジ
          backgroundColor: 'rgba(234, 88, 12, 0.1)',
          yAxisID: 'y',
          tension: 0.1, spanGaps: true
        },
        {
          label: '睡眠 (h)',
          data: sleepData,
          borderColor: 'rgba(139, 92, 246, 1)', // 紫
          backgroundColor: 'rgba(139, 92, 246, 0.1)',
          yAxisID: 'y1', // 右軸
          borderDash: [5, 5],
          tension: 0.1, spanGaps: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { position:'left', title:{display:true, text:'体重(kg)'} },
        y1: { position:'right', title:{display:true, text:'睡眠(h)'}, grid:{drawOnChartArea:false} }
      }
    }
  });
}

// ==========================================
// ========== チームメモ通知 (Badge) Logic ===
// ==========================================

let memoBadgeUnsub = null;

function initMemoBadgeCheck() {
  if (memoBadgeUnsub) { try{ memoBadgeUnsub(); }catch{} memoBadgeUnsub=null; }
  
  if (!teamId) return;

  const col = getTeamMemoCollectionRef(teamId); // getTeamMemoCollectionRefが存在する前提
  const memoTab = document.querySelector('.tab[data-tab="memo"]');
  const memoCard = document.querySelector('.home-card[data-target="memo"]');

  memoBadgeUnsub = col.orderBy('ts', 'desc').limit(1).onSnapshot(snap => {
    // データがない場合
    if (snap.empty) {
      if (memoTab) memoTab.classList.remove('new-message');
      if (memoCard) memoCard.classList.remove('new-message');
      updateHomeTabBadge(); // ★追加: 状態を再確認
      return;
    }
    
    const latestDoc = snap.docs[0].data();
    const latestTs = latestDoc.ts || 0;
    
    const lastViewKey = `athlog:${teamId}:${memberId}:lastMemoView`;
    const lastViewTs = Number(localStorage.getItem(lastViewKey) || 0);

    // 新着判定
    const isNewMemo = (latestTs > lastViewTs && latestDoc.mem !== memberId);

    if (isNewMemo) {
      if (memoTab) memoTab.classList.add('new-message');
      if (memoCard) memoCard.classList.add('new-message');
    } else {
      if (memoTab) memoTab.classList.remove('new-message');
      if (memoCard) memoCard.classList.remove('new-message');
    }

    // ★追加: ホームボタンの更新
    // 「メモがある」または「現在通知バッジが出ている」ならホームも点灯
    const nBadge = document.getElementById("notifyBadge");
    const isNotifyActive = nBadge && !nBadge.classList.contains("hidden");
    
    updateHomeTabBadge(isNewMemo || isNotifyActive);

  }, err => {
    console.log("Memo badge check error", err);
  });
}

// ===== NEW: Team Memo =====
function initMemo(){
  const memoInput = $("#memoChatInput");
  const sendBtn = $("#memoSendBtn");

  const sendMessage = async ()=>{
    // チームID等のチェック
    if(!teamId || !memberId) {
        console.error("No teamId or memberId");
        return;
    }

    const txt = memoInput.value.trim(); 
    if(!txt) return;
    
    // 連打防止：送信中はボタンを無効化
    if(sendBtn) sendBtn.disabled = true;

    try {
      await getTeamMemoCollectionRef(teamId).add({ 
        mem: memberId, 
        txt: txt, 
        ts: Date.now() 
      });
      memoInput.value = "";
    } catch(e) {
      console.error("Memo send error:", e);
      alert("送信に失敗しました。通信環境を確認してください。");
    } finally {
      if(sendBtn) sendBtn.disabled = false;
      // 送信後、すぐに入力欄にフォーカスを戻す（連続送信しやすくする）
      memoInput.focus();
    }
  };

  // ▼▼▼ 修正: addEventListenerではなくプロパティに代入して重複登録を防ぐ ▼▼▼
  if(memoInput) {
    memoInput.onkeydown = (e) => { 
      // 日本語変換の確定エンター（isComposing）を除外して誤送信防止
      if(e.key === "Enter" && !e.isComposing) {
        e.preventDefault(); // フォーム送信などを防ぐ
        sendMessage(); 
      }
    };
  }
  
  if(sendBtn) {
    sendBtn.onclick = sendMessage;
  }
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
      // まずローカルストレージから「自分(ID)」を取得
      memberId = last.member;

      // ★修正: 最後に開いたチームではなく、「メインチーム」を優先して開く
      const myMain = getMainTeamOf(memberId);
      teamId = myMain ? myMain : last.team; // メイン未設定なら履歴を使う

      // ★修正: 必ず「自分」の日誌を表示する状態にする
      viewingMemberId = memberId;
      
      // ★修正: 日付は必ず「今日」にする
      selDate = new Date();

      // ▼▼▼ 以下は既存ロジックの調整（ミラー設定の確認など） ▼▼▼
      const myMainTeam = getMainTeamOf(memberId);
      if (!myMainTeam) {
         setMainTeamOf(memberId, teamId);
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
        const currentMirror = memberSnap.data()?.mirrorFromTeamId;
        const expectedMirror = isMain ? undefined : getMainTeamOf(memberId);
        if (currentMirror !== expectedMirror) {
            await memberRef.set({ mirrorFromTeamId: mirrorSource }, { merge: true });
        }
      }
      // ▲▲▲ 修正 ▲▲▲

      await showApp();
      
      // アプリ表示後に日付ピッカー等を確実に今日に合わせる
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
// app.js の末尾付近 document.addEventListener("DOMContentLoaded", ... 内

document.addEventListener("DOMContentLoaded",()=>{
  const btn=$("#loginBtn"); if(btn) btn.onclick=doLogin;
  const t=$("#teamId"), m=$("#memberName");
  if(t && m) [t,m].forEach(inp=>inp.addEventListener("keydown",(e)=>{ if(e.key==="Enter") doLogin(); }));

  // ▼▼▼ ヘルプ内容の更新 ▼▼▼
  const helpBody=document.getElementById("helpBody");
  if(helpBody){
    helpBody.innerHTML=`
      <h3 style="margin-top:0;">🏁 はじめに</h3>
      <ul>
        <li>ログインは「Team ID」と「名前」の一致で行います。</li>
        <li>右上のメンバー切替で、チームメイトの日誌を閲覧できます（編集は自分のみ）。</li>
      </ul>

      <h3>📓 日誌 (Journal)</h3>
      <ul>
        <li><b>基本記録</b>: 距離・体重・睡眠時間・調子(5段階)を入力して保存します。</li>
        <li><b>筋疲労マップ</b>: 人体図をタップして疲労部位を記録できます（Lv1:青→Lv2:黄→Lv3:赤）。</li>
        <li><b>シェアモード(📷)</b>: 日付横のカメラボタンで、SNS投稿用の画像を生成します。</li>
        <li><b>AIコーチ</b>: 直近の記録からアドバイスをもらえます。</li>
      </ul>

      <h3>📅 カレンダー・予定</h3>
      <ul>
        <li><b>一覧</b>: 月ごとの走行距離や調子を確認できます。検索ボタン(🔍)で過去の日誌を探せます。</li>
        <li><b>予定</b>: 練習メニューを作成し、チームで共有できます。「反映」ボタンで日誌に取り込めます。</li>
      </ul>

      <h3>📊 データ・便利機能</h3>
      <ul>
        <li><b>グラフ</b>: 走行距離(日/週/月)、体重、睡眠、コンディションの推移を可視化します。</li>
        <li><b>チームメモ</b>: チーム全員が見られる掲示板です。連絡事項などに。</li>
        <li><b>通知</b>: 新着コメントやお知らせが届くとバッジ(🔴)がつきます。</li>
      </ul>

      <h3>⏱ 時計・マップ</h3>
      <ul>
        <li><b>時計</b>: ペース走・インターバル・カスタムタイマー機能。計測結果を日誌に転記できます。</li>
        <li><b>競技場</b>: 全国の陸上競技場をマップで検索できます。</li>
      </ul>
    `;
  }

  // イベントリスナーの設定
  $("#openHelpBtn")?.addEventListener("click",()=>{ $("#helpOverlay")?.classList.remove("hidden"); });
  $("#helpClose")?.addEventListener("click",()=>{ $("#helpOverlay")?.classList.add("hidden"); });
  $("#helpOverlay")?.addEventListener("click",(e)=>{ if(e.target.id==="helpOverlay") e.currentTarget.classList.add("hidden"); });
  window.addEventListener("keydown",(e)=>{ if(e.key==="Escape") $("#helpOverlay")?.classList.add("hidden"); });
});


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

// app.js の initMuscleMap 関数

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
    const halfW=Math.floor(fullW/2);
    // 表示モード（前後・全体）に合わせて切り抜き範囲を決定
    const crop = (MM.VIEW==='front') ? {sx:0,     sy:0, sw:halfW, sh:fullH}
               : (MM.VIEW==='back')  ? {sx:halfW, sy:0, sw:halfW, sh:fullH}
               :                       {sx:0,     sy:0, sw:fullW, sh:fullH};

    const wrap = document.getElementById('mmWrap');
    if(wrap) {
      // ▼▼▼ 修正: コンテナの縦横比を強制固定（これがズレ防止の鍵） ▼▼▼
      wrap.style.aspectRatio = `${crop.sw} / ${crop.sh}`;
      
      wrap.style.position = 'relative'; 
      wrap.style.width = '100%';     // 横幅は親に合わせる
      wrap.style.height = 'auto';    // 高さはアスペクト比で自動決定
      wrap.style.margin = '0 auto';  // 中央寄せ
      wrap.style.overflow = 'hidden'; // はみ出し防止
    }

    [mm.base, mm.overlay, mm.barrier].forEach(c=>{ 
      c.width=crop.sw; 
      c.height=crop.sh;
      // ▼▼▼ 修正: キャンバスをラッパーに完全追従させる ▼▼▼
      c.style.position = 'absolute';
      c.style.top = '0';
      c.style.left = '0';
      c.style.width = '100%';
      c.style.height = '100%';
      c.style.display = 'block';
      c.style.objectFit = 'contain';
    });

    // ベースへ描画
    mm.bctx.clearRect(0,0,crop.sw,crop.sh);
    mm.bctx.drawImage(img, crop.sx,crop.sy,crop.sw,crop.sh, 0,0,crop.sw,crop.sh);

    makeBarrierFromBase();
    mm.ready=true;
    drawMuscleFromDoc(lastJournal);
  }).catch(err=>{
    console.error(err);
  });

  // (タッチイベント処理は変更なし。省略せずに既存のコードを残してください)
  const activePointers = new Set();
  const ov = mm.overlay;
  ov.style.touchAction = 'pan-x pan-y pinch-zoom';

// app.js の initMuscleMap 関数内

  function onPointerDown(e){
    ov.setPointerCapture?.(e.pointerId);
    activePointers.add(e.pointerId);

    // 2本以上 → ピンチ操作とみなし、描画しない
    if(e.pointerType==='touch' && activePointers.size>=2){
      setOverlayTouchAction('pan-x pan-y pinch-zoom');
      return;
    }

    // 単指 → スクロールを抑止して描画処理へ
    setOverlayTouchAction('none');
    if(!isEditableHere(teamId,memberId,viewingMemberId)) return;

    const p=mmPixPos(ov,e);
    // 壁（外側/輪郭/枠）の上は反応させない
    if (barrierAlphaAt(p.x,p.y) > 10) return;

    if(brush.erase){
      // 消しゴムモードなら無条件で消去
      floodErase(mm.octx, mm.wctx, p.x, p.y);
    }else{
      const targetColor = MM.LEVELS[brush.lvl||1]; // 選択中の色
      const pixel = mm.octx.getImageData(p.x, p.y, 1, 1).data; // タップ位置の現在の色
      
      // アルファ値(pixel[3])を見て「既に塗られている場所か」を判定
      const isPainted = pixel[3] > 50; 

      if(isPainted){
        // 既に塗られている場合、色が同じか判定 (RGB差分の合計で比較)
        const dist = Math.abs(pixel[0]-targetColor[0]) +
                     Math.abs(pixel[1]-targetColor[1]) +
                     Math.abs(pixel[2]-targetColor[2]);

        if(dist < 15) { // 許容誤差範囲内なら「同じ色」とみなす
          // 【同じ色】なら消す (トグル動作: ON -> OFF)
          floodErase(mm.octx, mm.wctx, p.x, p.y);
        } else {
          // 【違う色】なら上書き (一度消してから新しい色で塗る)
          floodErase(mm.octx, mm.wctx, p.x, p.y);
          floodFill(mm.octx, mm.wctx, p.x, p.y, MM.TOL, targetColor);
        }
      } else {
        // 塗られていない場所 → 普通に塗る (OFF -> ON)
        floodFill(mm.octx, mm.wctx, p.x, p.y, MM.TOL, targetColor);   
      }
    }
    saveMuscleLayerToDoc();
  }
  
  function onPointerEnd(e){
    ov.releasePointerCapture?.(e.pointerId);
    activePointers.delete(e.pointerId);
    if(activePointers.size===0) ov.style.touchAction = 'pan-x pan-y pinch-zoom';
  }

  ov.addEventListener('pointerdown', onPointerDown, { passive:true });
  ov.addEventListener('pointerup', onPointerEnd, { passive:true });
  ov.addEventListener('pointercancel', onPointerEnd, { passive:true });
  ov.addEventListener('pointerleave', onPointerEnd, { passive:true });
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

// ===== チームコメント（日付×表示中メンバー）誰でも編集可 =====
let tscDirty = false;

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

// ==========================================
// ========== 共有コメント (TSC) Logic =======
// ==========================================

async function tscSave(){
  try {
    const ta = document.getElementById('teamSharedComment');
    if(!ta) return;
    const text = ta.value;

    // チームIDと相手のIDを確実に取得
    const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
    if (!srcTeam) {
        alert("チーム情報が取得できませんでした。");
        return;
    }

    const dayKey = ymd(selDate); 

    // 1. 日誌データの一部としてコメントを保存
    await getJournalRef(srcTeam, viewingMemberId, selDate).set({ 
        teamComment: text, 
        lastCommentBy: memberId,
        lastCommentAt: Date.now() 
    }, { merge:true });
    
    tscDirty = false;
    tscSetStatus('送信完了'); // 保存済み -> 送信完了に変更

    // 2. 通知を作成 (コメントがあり、かつ相手が自分以外の場合)
    // ★修正: 通知作成エラーでも保存自体は成功とするため、ここはtry-catchを分けるか、
    // ここでエラーが出ても全体が止まらないように注意深く実行します。
    if (text.trim() !== "" && viewingMemberId !== memberId) {
       createDayCommentNotifications({
          teamId: srcTeam,     
          from: memberId,      
          to: viewingMemberId, 
          day: dayKey,              
          text: text                
       }).catch(e => console.error("通知送信エラー(保存は成功):", e));
    }

  } catch(e) {
    console.error('tscSave error', e);
    alert("コメントの送信に失敗しました。\n通信環境を確認してください。");
    tscSetStatus('送信失敗');
  }
}

// 通知作成関数がない場合は追加（app.jsの末尾など）
async function createDayCommentNotifications({ teamId, from, to, day, text }){
  try {
    // 相手の通知サブコレクションに追加
    await db.collection('teams').doc(teamId).collection('notifications').add({
        type: 'dayComment', 
        team: teamId,
        day: day,            
        text: text,          
        from: from,          
        to: to,              
        ts: Date.now(),      
        read: false          
    });
  } catch(e) {
    console.error('Notification error:', e);
  }
}


// app.js (tscInitOnce 関数を書き換え)

function tscInitOnce(){
  const ta = document.getElementById('teamSharedComment');
  const btn = document.getElementById('tscSendBtn'); // 送信ボタン

  if(!ta) return;
  
  ta.removeAttribute('disabled');

  // ★修正: 自動保存 (inputイベントでの tscScheduleSave) を廃止
  // 代わりに、入力中は「未送信」と表示するだけにする
  ta.addEventListener('input', () => {
    tscDirty = true;
    tscSetStatus('未送信...');
  });

  // ★追加: 送信ボタンクリックで保存＆通知を実行
  if(btn){
    btn.onclick = async () => {
      if(!tscDirty && !ta.value) return; // 空で変更なしなら何もしない
      
      btn.disabled = true; // 連打防止
      btn.textContent = '送信中...';
      
      await tscSave(); // 保存と通知作成を実行
      
      btn.disabled = false;
      btn.textContent = '送信';
      tscSetStatus('送信完了');
    };
  }
  
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

// ▼▼▼ 追加: バッジの表示切り替えヘルパー ▼▼▼
function toggleNotifyBadges(show) {
  // タブバーのバッジ
  const notifyTab = document.querySelector('[data-tab="notify"]');
  if (notifyTab) notifyTab.classList.toggle('new-message', show);

  // ホーム画面カードのバッジ
  const notifyCard = document.querySelector('.home-card[data-target="notify"]');
  if (notifyCard) notifyCard.classList.toggle('new-message', show);
}

// ▼▼▼ 修正: タイムスタンプ比較ロジックに変更 ▼▼▼
// ホームボタンのバッジ状態を更新するヘルパー関数
function updateHomeTabBadge(forceActive = null) {
  const homeTab = document.querySelector('.tab[data-tab="home"]');
  if (!homeTab) return;

  // 引数が指定されていればそれに従う、なければDOMの状態から判定
  let isActive = forceActive;
  
  if (isActive === null) {
    // メモタブがバッジを持っているか
    const isMemoActive = document.querySelector('.tab[data-tab="memo"]')?.classList.contains('new-message');
    
    // 通知バッジが表示されているか (toggleNotifyBadgesの実装に依存しますが、通常 #notifyBadge の hidden を確認)
    const nBadge = document.getElementById("notifyBadge");
    const isNotifyActive = nBadge && !nBadge.classList.contains("hidden") && nBadge.style.display !== 'none';

    isActive = isMemoActive || isNotifyActive;
  }

  // ホームタブにクラスを付与/削除
  if (isActive) {
    homeTab.classList.add('new-message'); // CSSで .new-message::after { content: "●"; ... } のようなスタイルが当たっている想定
  } else {
    homeTab.classList.remove('new-message');
  }
}

// ▼▼▼ 修正: 開いた瞬間に「最終閲覧時刻」を更新する処理を追加 ▼▼▼
async function renderNotify(){
  // 既存の購読解除
  if (unsubscribeNotify) { try{ unsubscribeNotify(); }catch{} unsubscribeNotify=null; }

  // ★追加: 通知画面を開いたので、最終閲覧時刻を「現在」に更新し、バッジを即消去
  const lastViewKey = `athlog:${teamId}:${memberId}:lastNotifyView`;
  localStorage.setItem(lastViewKey, Date.now());
  toggleNotifyBadges(false);

  const box = document.getElementById('notifyList');
  const empty = document.getElementById('notifyEmpty');
  if(!box) return;
  box.innerHTML = '';
  empty.style.display = 'none';

  // リスト表示は「未読(read==false)」のものだけを表示する既存ロジックを維持
  // (バッジは消えますが、リストには未読が残る仕様です)
  const col = db.collection('teams').doc(teamId).collection('notifications');
  const q = col.where('to','==', viewingMemberId || memberId)
               .where('read','==', false)
               .orderBy('ts','desc');

  // スナップショット購読
  unsubscribeNotify = q.onSnapshot(async (snap)=>{
    box.innerHTML = '';
    if (snap.empty){
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    snap.docs.forEach(doc=>{
      const n = doc.data();
      const notifId = doc.id;
      const div = document.createElement('div');
      div.className = 'notify-card'; 
      
      try {
        const at = new Date(n.ts || Date.now()).toLocaleString('ja-JP');
        const senderName = getDisplayName(n.from || '不明');
        
        const bodyHtml = (n.type === 'dayComment')
          ? (
           `<div class="notify-header">
              <span class="notify-icon">💬</span>
              <span class="notify-title">${senderName}が日誌にコメントしました</span>
              <span class="date">${at}</span>
           </div>
           <div class="notify-content">
              <div class="notify-day-link" data-day="${n.day}" data-notif-id="${notifId}">
                  <b>${n.day}</b> の日誌を開く &rarr;
              </div>` +
              (n.text ? `<div class="notify-comment-text">${escapeHtml(n.text)}</div>` : ``) +
           `</div>`
          )
          : `<div class="notify-content">システム通知</div>`;

        div.innerHTML = bodyHtml;

        div.querySelector('.notify-day-link')?.addEventListener('click', (e)=>{
          const day = e.currentTarget.getAttribute('data-day');
          const clickedId = e.currentTarget.getAttribute('data-notif-id'); 

          if (day && clickedId && /^\d{4}-\d{2}-\d{2}$/.test(day)){
              const notifRef = db.collection('teams').doc(teamId).collection('notifications').doc(clickedId);
              notifRef.update({ read: true }).catch(err => {
                  console.error("Failed to mark notification as read:", err);
              });
              
              selDate = parseDateInput(day);
              switchTab('journal', true);
          }
        });

        box.appendChild(div);

      } catch (e) {
        console.error("RENDERING ERROR", e);
        div.innerHTML = `<div style="color:red;">描画エラー</div>`;
        box.appendChild(div);
      }
    });

  }, (err)=>{
    console.error('notify onSnapshot error', err);
    empty.style.display = 'block';
  });
}

// XSS対策の軽いエスケープ
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// 通知データを作成する関数
async function createDayCommentNotifications({ teamId, from, to, day, text }){
  try{
    // 通知コレクションへの参照
    const col = db.collection('teams').doc(teamId).collection('notifications');
    
    // 既存の未読通知が重複しないようにチェックしても良いが、
    // ここではシンプルに「新しい通知」として追加する
    await col.add({
        type: 'dayComment',  // タイプ: 日誌コメント
        team: teamId,
        day: day,            // 対象の日付
        text: text,          // コメント内容（抜粋）
        from: from,          // 誰から
        to: to,              // 誰へ
        ts: Date.now(),      // タイムスタンプ
        read: false          // 未読フラグ
    });
    
    console.log(`Notification sent to ${to}`);
  }catch(e){
    console.error('createNotification error', e);
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


// メンバーを一人ずつ移動するロジック
function goMemberDelta(delta){
  const select = document.getElementById('memberSelect');
  if (!select || select.options.length <= 1) return;

  // メンバーIDのリストを取得
  const memberIds = Array.from(select.options).map(o => o.value);
  
  // 現在のメンバーIDがリストのどこにあるか
  const currentIndex = memberIds.indexOf(viewingMemberId);
  
  // 次のインデックスを計算（ループ処理）
  const count = memberIds.length;
  let newIndex = (currentIndex + delta);
  newIndex = (newIndex % count + count) % count;

  const newMemberId = memberIds[newIndex];

  // UIと状態を更新
  viewingMemberId = newMemberId;
  select.value = newMemberId;
  
  // 表示名とバッジを更新
  // ★修正: 要素が存在する場合のみ書き込むように変更 (以前削除したため)
  const ml = document.getElementById("memberLabel");
  if (ml) ml.textContent = getDisplayName(viewingMemberId);
  
  refreshBadges();

  // 現在のタブを再描画してデータを読み込み直す
  switchTab($(".tab.active")?.dataset.tab, true);
}
function initMemberNav(){
    $("#memberPrev")?.addEventListener("click", () => goMemberDelta(-1));
    $("#memberNext")?.addEventListener("click", () => goMemberDelta(1));
}


let notifyBadgeUnsub = null;


// AIチャットの履歴
let aiChatHistory = [];

function initAiAnalysis(){
  const keyInput = document.getElementById('geminiApiKey');
  const runBtn = document.getElementById('runAiBtn');
  const sendBtn = document.getElementById('aiSendBtn');
  const chatInput = document.getElementById('aiChatInput');

  if(!runBtn) return;

  // 保存されたキーがあれば復元
  const savedKey = localStorage.getItem('athlog_gemini_key');
  if(savedKey && keyInput){ keyInput.value = savedKey; }

  // 「分析開始」ボタン
  runBtn.addEventListener('click', async ()=>{
    const apiKey = keyInput ? keyInput.value.trim() : '';
    if(!apiKey){ alert('APIキーを入力してください'); return; }
    localStorage.setItem('athlog_gemini_key', apiKey);
    
    // チャットリセット＆分析開始
    aiChatHistory = [];
    document.getElementById('aiChatLog').innerHTML = `
      <div class="msg system"><span class="txt">データを収集して分析を開始します...</span></div>`;
    
    await runGeminiAnalysis(apiKey, true); // true = 初回分析モード
  });

  // 「送信」ボタン（追加質問）
  const sendMsg = async () => {
    const txt = chatInput.value.trim();
    const apiKey = keyInput ? keyInput.value.trim() : '';
    if(!txt || !apiKey) return;

    // ユーザーのメッセージを表示
    addAiChatMessage('user', txt);
    chatInput.value = '';
    
    // AIに送信
    await runGeminiAnalysis(apiKey, false, txt);
  };

  if(sendBtn) sendBtn.onclick = sendMsg;
  if(chatInput) chatInput.onkeydown = (e) => { if(e.key === 'Enter') sendMsg(); };
}


function addAiChatMessage(role, text){
  const box = document.getElementById('aiChatLog');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const name = role === 'user' ? 'あなた' : 'AIコーチ';

  // 1. Markdownの太字(**)を<b>タグに変換
  let htmlText = text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
  
  // 2. 改行を<br>に変換
  htmlText = htmlText.replace(/\n/g, '<br>');

  div.innerHTML = `<span class="name">${name}</span><span class="txt">${htmlText}</span>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  
  // 履歴に追加
  aiChatHistory.push({ role: role === 'user' ? 'user' : 'model', parts: [{ text: text }] });
}

async function runGeminiAnalysis(apiKey, isInitial, userMessage = "") {
  const runBtn = document.getElementById('runAiBtn');
  const sendBtn = document.getElementById('aiSendBtn');
  // APIキーの不要な文字を除去
  const cleanKey = apiKey.trim().replace(/:\d+$/, '');

  if(isInitial && runBtn) runBtn.disabled = true;
  if(sendBtn) sendBtn.disabled = true;

  try {
    // 初回分析時のシステムプロンプト生成
    if (isInitial) {
      const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
      const today = new Date();

      // プロフィール取得
      let profileText = "";
      try {
        const memDoc = await db.collection('teams').doc(srcTeam).collection('members').doc(viewingMemberId).get();
        const p = memDoc.data()?.aiProfile || {};
        profileText = `専門:${p.specialty||'未設定'}, SB:${p.sb||'未設定'}, 留意点:${p.note||'なし'}`;
      } catch(e) { profileText = "取得失敗"; }

      // 過去7日間のデータ収集
      const history = [];
      for(let i=6; i>=0; i--){
        const d = addDays(today, -i);
        const snap = await getJournalRef(srcTeam, viewingMemberId, d).get();
        const data = snap.data() || {};
        
        let fatigueParts = [];
        const stats = data.mmStats || {}; 
        const getPartName = (id) => {
            const found = BODY_PARTS_LIST.find(p => p.id === id);
            return found ? found.label : id;
        };
        Object.keys(stats).forEach(partId => {
          const val = stats[partId]; 
          if(val > 0) {
            const name = getPartName(partId);
            const lv = val > 2000 ? 3 : (val > 500 ? 2 : 1); 
            fatigueParts.push(`${name}(Lv${lv})`);
          }
        });
        const fatigueStr = fatigueParts.length > 0 ? fatigueParts.join(", ") : "なし";
        let menuText = (data.train || "").replace(/\n/g, " ").slice(0, 50);

        history.push(`- ${ymd(d)}: ${data.dist||0}km, [${(data.tags||[]).join(',')}], 内容:${menuText}, 疲労:${fatigueStr}, 調子:${data.condition||'-'}`);
      }

      const systemPrompt = `あなたは陸上中長距離のプロコーチです。
      ユーザーのことは名前で呼ばず、二人称は「あなた」を使ってください。
【プロフィール】${profileText}
【直近7日間のログ】
${history.join('\n')}
上記データを分析し、特に筋肉マップから抽出された「疲労部位」と練習メニューの関連性を科学的に、そして本質的に分析してアドバイスしてください。また、練習の組み方へも言及すること。回答は見やすく整形してください。`;

      aiChatHistory = [{ role: 'user', parts: [{ text: systemPrompt }] }];
    }

    // --- モデル呼び出し (最新版: gemini-2.5-flash) ---
    const call = async () => {
      // ★ここを修正しました: gemini-2.5-flash
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${cleanKey}`;
      
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: aiChatHistory })
      });
      
      if(!res.ok) throw { status: res.status, statusText: res.statusText };
      return res.json();
    };

    let json;
    try {
      json = await call();
    } catch(e) {
      console.warn("AI Analysis failed:", e);
      throw e; 
    }

    const aiText = json.candidates?.[0]?.content?.parts?.[0]?.text || '回答を得られませんでした';
    addAiChatMessage('model', aiText);

  } catch(e) {
    console.error(e);
    let errorMsg = "エラーが発生しました。";
    
    // エラーメッセージの分岐
    if(e.status === 429) {
      errorMsg = "アクセスが集中しています（429）。\n1分ほど時間を空けてから、再度ボタンを押してください。";
    } else if(e.status === 404) {
      errorMsg = "指定されたモデルが見つかりません（404）。\nコード内のモデル名を 'gemini-2.5-flash' に修正してください。";
    } else if(e.status === 400) {
      errorMsg = "リクエストが無効です（400）。\nAPIキーが正しいか確認してください。";
    }
    
    addAiChatMessage('system', errorMsg);
  } finally {
    if(runBtn) runBtn.disabled = false;
    if(sendBtn) sendBtn.disabled = false;
  }
}
async function callGeminiApi(key, history) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: history })
  });
  if(!res.ok) throw new Error('API Error');
  return res.json();
}
let typePieChart = null;

async function renderTypePieChart(){
  const ctx = document.getElementById('typePieChart')?.getContext('2d');
  if(!ctx) return;

  // 1. 集計対象の月を決める（カレンダーで選択中の月）
  const targetDate = selDate || new Date();
  const y = targetDate.getFullYear();
  const m = targetDate.getMonth() + 1;
  const monthPrefix = `${y}-${String(m).padStart(2,'0')}`; // 例: "2025-12"

  // タイトル更新
  const titleEl = document.getElementById('typePieTitle');
  if(titleEl) titleEl.textContent = `${m}月の練習割合`;

  // 2. データ取得
  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
  const snaps = await db.collection('teams').doc(srcTeam).collection('members').doc(viewingMemberId).collection('journal').get();
  
  // 3. 集計
  const counts = { "ジョグ":0, "ポイント":0, "補強":0, "オフ":0, "その他":0 };
  
  snaps.forEach(doc => {
    // IDが "2025-12" で始まるデータ（その月の日誌）だけを対象
    if(doc.id.startsWith(monthPrefix)){
      const data = doc.data();
      const tags = data.tags || [];
      
      // タグがない日は「オフ」扱いにする等のルールはお好みで（今回はタグがあるものだけ集計）
      tags.forEach(tag => {
        if(counts.hasOwnProperty(tag)){
          counts[tag]++;
        } else {
          // 未定義のタグがあればその他へ
          counts["その他"]++;
        }
      });
    }
  });

  // 4. グラフ用データ準備
  const labels = Object.keys(counts); // ["ジョグ", "ポイント", ...]
  const dataValues = Object.values(counts);

  // データが空っぽ（まだ記録がない月）の場合の表示対策
  const total = dataValues.reduce((a,b)=>a+b, 0);
  if(total === 0) {
    // データなし時は空の円を表示するなど
    if(typePieChart) typePieChart.destroy();
    typePieChart = new Chart(ctx, {
      type: 'doughnut',
      data: { labels: ["データなし"], datasets: [{ data: [1], backgroundColor: ['#eee'] }] },
      options: { plugins: { legend: { display:false }, tooltip: { enabled:false } } }
    });
    return;
  }

  // 色設定（カレンダーの色と合わせる）
  const bgColors = [
    '#93c5fd', // ジョグ (青)
    '#fdba74', // ポイント (橙)
    '#86efac', // 補強 (緑)
    '#e5e7eb', // オフ (灰)
    '#f0abfc'  // その他 (紫)
  ];

  // 5. チャート描画
  if(typePieChart) typePieChart.destroy();
  
  typePieChart = new Chart(ctx, {
    type: 'doughnut', // ドーナツ型（円グラフ）
    data: {
      labels: labels,
      datasets: [{
        data: dataValues,
        backgroundColor: bgColors,
        borderWidth: 2,
        borderColor: '#ffffff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right', // 凡例を右側に配置
          labels: { boxWidth: 12, font: { size: 11 } }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const val = context.raw;
              const percent = Math.round((val / total) * 100);
              return ` ${context.label}: ${val}回 (${percent}%)`;
            }
          }
        }
      }
    }
  });
}


// app.js に追加

// ■ AIプロフィールを保存する関数
async function saveAiProfile() {
  const btn = document.getElementById('saveAiProfileBtn');
  btn.textContent = '保存中...';
  
  try {
    const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
    // メンバーのドキュメント自体に 'aiProfile' というフィールドを作って保存
    await db.collection('teams').doc(srcTeam)
            .collection('members').doc(viewingMemberId)
            .set({
              aiProfile: {
                specialty: document.getElementById('aiSpecialty').value,
                sb: document.getElementById('aiSb').value,
                note: document.getElementById('aiNote').value
              }
            }, { merge: true }); // 他のデータ(名前など)を消さないようにmergeする

    alert('AI用プロフィールを保存しました！\n次回の分析から反映されます。');
  } catch(e) {
    console.error(e);
    alert('保存に失敗しました');
  } finally {
    btn.textContent = '設定を保存';
  }
}

// ■ (補助) 画面表示時にプロフィールを読み込んでフォームに入れる関数
// ※これを showMemberDetail() などの「メンバー詳細表示時」に呼ぶのがベストですが、
// 面倒なら「分析開始」ボタンを押した瞬間にフォームにセットしてもOKです。
// 今回は「AI分析実行時」に最新データを取得するので、表示用は必須ではありませんが、
// 利便性のために、detailsを開いたとき用として作っておきます。
async function loadAiProfileToForm() {
  try {
    const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
    const doc = await db.collection('teams').doc(srcTeam)
                        .collection('members').doc(viewingMemberId).get();
    const data = doc.data() || {};
    const prof = data.aiProfile || {};
    
    if(document.getElementById('aiSpecialty')) document.getElementById('aiSpecialty').value = prof.specialty || '';
    if(document.getElementById('aiSb')) document.getElementById('aiSb').value = prof.sb || '';
    if(document.getElementById('aiNote')) document.getElementById('aiNote').value = prof.note || '';
  } catch(e) {
    console.log('プロフィール読み込み失敗(まだ保存されていないかも)', e);
  }
}

// app.js の一番最後

const shareStyle = document.createElement('style');
shareStyle.innerHTML = `
  /* === 全体設定 === */
  body.share-mode {
    background-color: #222 !important;
    overflow: hidden !important;
    height: 100vh !important; width: 100vw !important;
    margin: 0 !important; padding: 16 !important;
    box-sizing: border-bax !important;
    display: flex !important; 
    align-items: center !important; 
    justify-content: center !important;
  }

  /* === カード本体 === */
  body.share-mode #app {
    aspect-ratio: 9 / 16 !important;
    height: auto !important; 
    width: auto !important; 
    max-width: calc(100vw - 32px) !important;
    max-height: calc(100vh - 32px) !important;
    background: #fff !important;
    border-radius: 20px !important;
    box-shadow: 0 0 50px rgba(0,0,0,0.5) !important;
    padding: 14px !important; 
    box-sizing: border-box !important;
    
    /* ★重要: 強制的に縦並び & 上詰め配置 */
    display: flex !important; 
    flex-direction: column !important;
    justify-content: flex-start !important; /* 上に詰める */
    gap: 0 !important; /* 要素間の自動隙間をゼロに */
    
    position: relative !important; margin: 0 !important;
  }

  /* 非表示要素 */
  body.share-mode header, body.share-mode #journalTabs,
  body.share-mode .weekbar > *:not(#shareModeBtn),
  body.share-mode .palette, body.share-mode #saveBtn,
  body.share-mode #mergeBtn, body.share-mode #teamSwitchWrap,
  body.share-mode #memberNavWrap, body.share-mode .qbtn-area,
  body.share-mode .parts-tag-area, body.share-mode .login-note,
  body.share-mode #goHomeBtn, body.share-mode h2,
  body.share-mode #partsTagArea, body.share-mode #mergeScopeWrapper,
  body.share-mode #conditionBtns,
  body.share-mode .share-hide
  { display: none !important; }

  /* ヘッダー */
  #shareHeaderOverlay {
    display: flex; justify-content: space-between; align-items: flex-start;
    /* ヘッダー下の隙間も最小限に */
    margin-bottom: 4px; padding-bottom: 4px;
    border-bottom: 2px solid #f3f4f6; flex-shrink: 0;
    width: 100% !important;
  }
  .share-header-inner { display: flex; flex-direction: column; }
  .share-date { color: #111; line-height: 1.0; font-size: 0.95em; }
  .share-meta { display: flex !important; align-items: baseline !important; gap: 6px; margin-top: 2px; }
  .share-meta span { font-size: 0.85rem !important; }
  .share-meta .share-name { font-size: 1.1rem !important; }
  .share-brand { font-size: 8px; color: #d1d5db; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; align-self: center; }

  /* 日誌エリア（ここが広がりやすいので修正） */
  body.share-mode #journal {
    display: flex !important; 
    flex-direction: column !important;
    justify-content: flex-start !important; /* 上詰め */
    min-height: 0 !important;
    /* ★ここをゼロにして隙間をなくす */
    gap: 0 !important; 
    padding: 0 !important; margin: 0 !important;
    width: 100% !important;
  }

  /* 数値データ行 */
  body.share-mode .journal-stats-row {
    display: flex; justify-content: space-between !important;
    width: 100% !important; flex-shrink: 0;
    margin: 0 !important; padding: 0 !important;
    /* 下にわずかな隙間(2px)だけ空ける */
    margin-bottom: 0px !important;
  }
  
  body.share-mode .journal-stats-row > div,
  body.share-mode .added-cond-item {
    background: transparent !important; padding: 0 !important; 
    text-align: center !important; flex: 1 !important;
    display: flex !important; flex-direction: column !important; align-items: center !important;
    margin: 0 !important;
  }

  body.share-mode .journal-stats-row input,
  body.share-mode .share-val {
    font-size: 18px !important; font-weight: 800 !important;
    color: #ea580c !important; 
    text-align: center; border: none !important; background: transparent !important;
    width: 100% !important; margin: 0 !important; padding: 0 !important;
    font-family: sans-serif;
    line-height: 1.1 !important;
  }
  
  body.share-mode .added-cond-item .share-val { color: #000 !important; }

  body.share-mode label {
    font-size: 8px !important; color: #ea580c !important; font-weight:bold;
    display: block !important; margin-bottom: 0px; text-align: center; width: 100% !important;
    line-height: 1.0 !important;
  }

  /* テキストエリア */
  body.share-mode textarea {
    border: 1px solid #f3f4f6 !important; background: #f9fafb !important;
    border-radius: 8px !important; padding: 6px !important;
    font-size: 11px !important; color: #374151 !important;
    width: 100% !important; box-sizing: border-box !important;
    height: 48px !important; flex-shrink: 0 !important; resize: none !important;
    line-height: 1.3;
    margin: 0 !important; /* マージン除去 */
    margin-top: 0px !important; 
  }

  /* === 筋肉マップ (JSで最後に移動済みだが念のためCSSも) === */
  body.share-mode #mmWrap {
    /* 残りのスペースを埋める */
    flex-grow: 1 !important; 
    margin-top: auto !important; /* 強制的に下へ */
    margin-bottom: 0 !important;
    width: 100% !important;
    
    aspect-ratio: unset !important;
    height: auto !important;
    top: 0 !important; 
    
    position: relative !important; 
    display: block !important;
    overflow: hidden !important;
  }
  
  body.share-mode canvas {
    position: absolute !important;
    top: 0 !important; left: 0 !important;
    width: 100% !important; 
    height: 100% !important;
    object-fit: contain !important; 
    object-position: bottom center !important;
  }

  body.share-mode #shareModeBtn {
    position: absolute; top: 12px; right: 12px; z-index: 10001; 
  }
  /* ===== 見出し・ラベルの縦圧縮 ===== */
body.share-mode label {
  margin-bottom: 0px !important;
  line-height: 0.95 !important;
}

/* 「練習内容」「タイム・感想」など見出しが span/label の場合 */
body.share-mode .journal-section-title,
body.share-mode .section-title {
  margin-bottom: 2px !important;
  line-height: 1.0 !important;
}

/* ===== 数値ブロック上下を詰める ===== */
body.share-mode .journal-stats-row {
  margin-top: 0px !important;
  margin-bottom: 2px !important;
}

body.share-mode .journal-stats-row > div {
  margin-bottom: 0px !important;
}

/* ===== textarea 前後の余白を最小化 ===== */
body.share-mode textarea {
  margin-top: 2px !important;
  margin-bottom: 2px !important;
  line-height: 1.25 !important;
}

/* textarea 同士の間隔（2つある場合） */
body.share-mode textarea + textarea {
  margin-top: 2px !important;
}
`;
document.head.appendChild(shareStyle);

// app.js の一番最後に追加（または前回の部分を上書き）してください

// スクショモード時のスケーリング管理
(function manageShareScale() {
  const CARD_WIDTH = 400; // CSSの --share-card-width と同じ値にする
  const MARGIN_X   = 40;  // 左右に確保したい余白の合計 (px)

  function updateScale() {
    const app = document.getElementById('app');
    if (!app) return;

    // シェアモードでないならリセットして終了
    if (!document.body.classList.contains('share-mode')) {
      app.style.transform = '';
      app.style.marginBottom = '';
      return;
    }

    // 現在の画面幅を取得
    const viewportWidth = window.innerWidth;
    
    // ■計算ロジック:
    // (画面幅 - 確保したい余白) ÷ カードの元幅 = 倍率
    let scale = (viewportWidth - MARGIN_X) / CARD_WIDTH;
    
    // (オプション) PCなどで極端に大きくなりすぎないように制限したい場合は以下を有効化
    // if (scale > 1.2) scale = 1.2;

    // 変形を適用
    app.style.transform = `scale(${scale})`;
    
    // ■高さの補正:
    // transform: scale を使っても、要素が占有する場所（レイアウト上の高さ）は元のままです。
    // そのため、縮小すると下に大きな空白ができ、拡大すると下の要素と被ります。
    // これを解消するために、見た目の高さとの差分を margin-bottom で調整します。
    
    const originalHeight = app.offsetHeight;
    const scaledHeight   = originalHeight * scale;
    const diff           = scaledHeight - originalHeight;
    
    // 差分だけマージンを増減させる
    app.style.marginBottom = `${diff}px`;
  }

  // リサイズ時に再計算
  window.addEventListener('resize', updateScale);

  // スクショボタンのクリックを監視して発火
  const btn = document.getElementById('shareModeBtn');
  if (btn) {
    btn.addEventListener('click', () => {
      // 少し待ってから実行（クラス付与やDOM描画の完了待ち）
      setTimeout(updateScale, 50);
    });
  }
  
  // bodyのクラス変化も監視（念のため）
  const observer = new MutationObserver(updateScale);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

})();

// ==========================================
// ========== Ltimer to Journal Logic =======
// ==========================================

async function reflectLtimerToJournal() {
  const pmScreen = document.getElementById('lt-pm');
  const splitScreen = document.getElementById('lt-split');
  
  let appendText = "";
  let addDist = 0;

  // --- A. インターバル (PM) モードの場合 ---
  if (pmScreen && !pmScreen.classList.contains('lt-hidden')) {
    const distPerRep = Number($("#pm-distance")?.value || 0);
    const reps = Number($("#pm-reps")?.value || 0);
    const rest = $("#pm-rest-dist")?.value;
    
    // 距離計算 (メートル -> キロメートル)
    if (distPerRep > 0 && reps > 0) {
      addDist = (distPerRep * reps) / 1000;
    }

    // 本文生成
    appendText += `【timer: インターバル】\n`;
    appendText += `${distPerRep}m × ${reps}`;
    if(rest) appendText += ` (r:${rest}m)`;
    appendText += `\n`;

    // 各レーンの計測結果
    if (ltPmState && ltPmState.lanes) {
      ltPmState.lanes.forEach(l => {
        if (l.laps && l.laps.length > 0) {
          const times = l.laps.map(ms => fmt(ms)).join(", ");
          appendText += `[${l.name}] ${times}\n`;
        }
      });
    }
  }
  // --- B. ペース走/ストップウォッチ (Split) モードの場合 ---
  else if (splitScreen && !splitScreen.classList.contains('lt-hidden')) {
    appendText += `【timer: 計測結果】\n`;
    
    let targetW = ltWatches.find(w => w.name == viewingMemberId);
    if (!targetW && ltWatches.length > 0) targetW = ltWatches[0];

    if (targetW) {
        const totalTime = fmt(targetW.elapsed);
        appendText += `Total: ${totalTime}\n`;
        if (targetW.laps && targetW.laps.length > 0) {
          targetW.laps.forEach((lap, i) => {
            appendText += `- Lap${i+1}: ${fmt(lap)}\n`;
          });
        }
    } else {
        ltWatches.forEach(w => {
            appendText += `${w.name || 'Runner'}: ${fmt(w.elapsed)}\n`;
        });
    }
  }

  // データなし
  if (!appendText) {
    alert("反映するデータがありません。");
    return;
  }

  // 確認ダイアログ（日付も表示して確認しやすくする）
  const dateStr = typeof ymd === 'function' ? ymd(selDate) : "選択中の日付";
  if (!confirm(`計測結果を日誌（タイム・感想欄）に追記しますか？\n日付: ${dateStr}`)) {
    return;
  }

  // ★修正ポイント: DBを直接読み書きすることで「データ消失」を防ぐ
  try {
    const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
    const docRef = getJournalRef(srcTeam, viewingMemberId, selDate);

    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      const data = doc.exists ? doc.data() : {};

      // 既存のデータを取得（なければ初期値）
      const currentDist = Number(data.dist || 0);
      const currentFeel = data.feel || "";

      // 新しい値を計算（既存データ + 今回の計測データ）
      // 距離は小数点2桁程度に丸める
      const newDist = parseFloat((currentDist + addDist).toFixed(2));
      const newFeel = currentFeel ? (currentFeel + "\n\n" + appendText) : appendText;

      // 保存
      transaction.set(docRef, {
        dist: newDist,
        feel: newFeel
      }, { merge: true });
    });

    // 保存完了後に画面を日誌タブへ切り替える（これで最新データが読み込まれます）
    switchTab('journal');

    $("#lt-summary")?.classList.add("lt-hidden");
    
  } catch(e) {
    console.error("Reflect Error:", e);
    alert("反映に失敗しました。\n" + e.message);
  }
}

// app.js の末尾に追加

// ▼▼▼ キーボードショートカット（PC用） ▼▼▼
document.addEventListener('keydown', (e) => {
  // 入力フォームにフォーカスがある場合は何もしない
  const active = document.activeElement;
  if (active && (['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.isContentEditable)) {
    return;
  }

  // 左右キー：日付移動（日誌タブが表示されている時のみ推奨だが、利便性のため常時有効またはタブ判定を入れる）
  // ここではシンプルに「現在のタブが日誌系なら」有効にします
  const currentTab = $(".tab.active")?.dataset.tab;
  const isJournalMode = ['journal', 'month', 'dashboard'].includes(currentTab);

  if (e.key === 'ArrowLeft') {
    if (isJournalMode) {
      e.preventDefault();
      selDate = addDays(selDate, -1);
      const dp = document.getElementById("datePicker");
      if(dp) dp.value = ymd(selDate);
      renderJournal(); // 月表示などを連動させたい場合は switchTab(currentTab, true) でも可
    }
  } else if (e.key === 'ArrowRight') {
    if (isJournalMode) {
      e.preventDefault();
      selDate = addDays(selDate, 1);
      const dp = document.getElementById("datePicker");
      if(dp) dp.value = ymd(selDate);
      renderJournal();
    }
  } 
  // 上下キー：メンバー切り替え
  else if (e.key === 'ArrowUp') {
    e.preventDefault();
    goMemberDelta(-1); // 前のメンバーへ
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    goMemberDelta(1); // 次のメンバーへ
  }
});
