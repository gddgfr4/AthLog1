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

async function showApp(){
  // 1. まずUIをホーム状態にリセット
  switchTab("home", true);
  
  $("#teamLabel").textContent=teamId;
  
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");

  const __nowMon=getMonthStr(new Date());
  if($("#monthPick") && !$("#monthPick").value) $("#monthPick").value=__nowMon;
  if($("#planMonthPick") && !$("#planMonthPick").value) $("#planMonthPick").value=__nowMon;

  // メンバーリストを取得してプルダウンを作成
  await populateMemberSelect();
  
  // ★追加: ログイン時に入力された名前から「自分」のIDを特定して保存
  const loginName = $("#memberName").value.trim();
  const memberSelect = $("#memberSelect");
  let foundId = null;
  
  // プルダウンの選択肢から、入力された名前と一致するものを探す
  for (let opt of memberSelect.options) {
    // 表示名の一部一致なども考慮する場合はここを調整。現状は完全一致または含む場合で判定
    if (opt.text.includes(loginName)) {
      foundId = opt.value;
      break;
    }
  }

  if (foundId) {
    myMemberId = foundId;       // 自分のIDを確定
    viewingMemberId = foundId;  // 初期表示も自分にする
    memberSelect.value = foundId;
  } else {
    // 名前が見つからない場合は、リストの先頭（または現在選択されているもの）を自分とみなす
    myMemberId = memberSelect.value;
    viewingMemberId = myMemberId;
  }

  $("#memberLabel").textContent = getDisplayName(viewingMemberId);
  
  // メンバー変更時のイベントリスナー
  if(memberSelect) memberSelect.addEventListener('change', ()=>{
    viewingMemberId=$("#memberSelect").value;
    $("#memberLabel").textContent = getDisplayName(viewingMemberId);
    
    selDate=new Date();
    const dp=$("#datePicker"); if(dp) dp.value=ymd(selDate);
    refreshBadges();
    
    // 現在アクティブなタブを再表示
    const currentTab = $(".tab.active")?.dataset.tab || 'home';
    switchTab(currentTab, true);
  });

  // 各画面の初期化
  initJournal(); initMonth(); initPlans(); initDashboard(); initMemo();
  
  // ホーム画面のボタン初期化
  initHome(); 

  selDate=new Date();
  const dp=$("#datePicker"); if(dp) dp.value=ymd(selDate);
  refreshBadges();
  
  // ★ 初期表示をホーム画面にする（ここで myMemberId が適用される）
  switchTab("home");

  checkNewMemo();
  initTeamSwitcher();
  initGlobalTabSwipe();
  initNotifyBadgeCheck();
  initMemberNav();
  initAiAnalysis();
  
  $("#goHomeBtn")?.addEventListener("click", () => switchTab("home"));
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
    // 自分が特定できていて、かつ現在表示中が自分でない場合のみ実行
    if (myMemberId && viewingMemberId !== myMemberId) {
      viewingMemberId = myMemberId;
      const ms = document.getElementById("memberSelect");
      if (ms) ms.value = myMemberId;
      const ml = document.getElementById("memberLabel");
      if (ml) ml.textContent = getDisplayName(viewingMemberId);
      refreshBadges();
      // 注: ここでのrender呼び出しは不要（この後の各画面描画処理で行われるため）
    }
  };

  // ★ ヘルパー: メンバー選択UIの有効/無効切り替え
  // enable=true: 変更可能(日誌用), enable=false: 表示するけど変更不可(他用)
  const configureMemberUI = (enable) => {
    const navWrap = document.getElementById("memberNavWrap");
    const sel = document.getElementById("memberSelect");
    const prev = document.getElementById("memberPrev");
    const next = document.getElementById("memberNext");

    // UI自体は常に表示する（hiddenを削除）
    if (navWrap) {
      navWrap.classList.remove("hidden");
      // 変更不可の時は少し薄くして分かりやすくする（お好みで調整可）
      navWrap.style.opacity = enable ? "1" : "0.7"; 
    }

    // 入力要素の disabled を切り替え
    if (sel) sel.disabled = !enable;
    if (prev) prev.disabled = !enable;
    if (next) next.disabled = !enable;
  };

  // ===============================================
  // 1. 特殊モード: 競技場マップ
  // ===============================================
  if (id === 'stadium') {
    $$(".tabpanel").forEach(p => p.classList.remove("active"));
    const clockPanel = document.getElementById('clock');
    if (clockPanel) { clockPanel.style.display = 'none'; clockPanel.classList.remove('active'); }
    
    const stdPanel = document.getElementById('stadium');
    if (stdPanel) stdPanel.classList.add("active");

    const tabsNav = document.getElementById("journalTabs");
    const homeBtn = document.getElementById("goHomeBtn");

    if (tabsNav) tabsNav.classList.add("hidden");
    if (homeBtn) homeBtn.classList.remove("hidden");

    // ★自分に固定し、変更UIを無効化
    enforceMyData();
    configureMemberUI(false);

    ltimerRunning = false;
    initStadium();
    return;
  }

  // ===============================================
  // 2. 特殊モード: 時計 (Ltimer)
  // ===============================================
  if (id === 'clock') {
    $$(".tabpanel").forEach(p => p.classList.remove("active"));
    const clockPanel = document.getElementById('clock');
    if (clockPanel) { clockPanel.style.display = 'block'; clockPanel.classList.add('active'); }

    const tabsNav = document.getElementById("journalTabs");
    const homeBtn = document.getElementById("goHomeBtn");

    if (tabsNav) tabsNav.classList.add("hidden");
    if (homeBtn) homeBtn.classList.remove("hidden");

    // ★自分に固定し、変更UIを無効化
    enforceMyData();
    configureMemberUI(false);

    initLtimer();
    return;
  }

  // ===============================================
  // 3. 通常モード
  // ===============================================
  ltimerRunning = false;
  const clockPanel = document.getElementById('clock');
  if (clockPanel) { clockPanel.style.display = 'none'; clockPanel.classList.remove('active'); }

  if (!forceRender && $(".tabpanel.active")?.id === id && id !== 'home') return;

  $$(".tabpanel").forEach(p => p.classList.remove("active"));
  const targetPanel = document.getElementById(id);
  if (targetPanel) targetPanel.classList.add("active");

  const tabsNav = document.getElementById("journalTabs");
  const homeBtn = document.getElementById("goHomeBtn");

  $$(".tab").forEach(btn => btn.classList.remove("active"));

  // ★ 日誌系画面かどうかの判定
  const isJournalTab = ['journal', 'month', 'dashboard'].includes(id);

  if (isJournalTab) {
    // === 日誌・月一覧・グラフ ===
    // メンバー変更を許可
    configureMemberUI(true);

    if (tabsNav) tabsNav.classList.remove("hidden");
    if (homeBtn) homeBtn.classList.remove("hidden");

    const activeBtn = $(`.tab[data-tab="${id}"]`);
    if (activeBtn) activeBtn.classList.add("active");

    // 注意: ここで enforceMyData() は呼びません。
    // これにより、日誌タブ内でのメンバー切り替え状態が維持されます。
    // ただし、他のタブ(Home等)から戻ってきた場合は、Home側で既に「自分」になっているため、
    // 結果として「日誌を開いたときは自分のページ」になります。

  } else {
    // === ホーム、予定、メモ、通知、AIコーチなど ===
    // 自分に固定し、変更UIを無効化
    enforceMyData();
    configureMemberUI(false);

    if (tabsNav) tabsNav.classList.add("hidden");

    // ホーム画面だけ戻るボタンを隠す
    if (id === 'home') {
      if (homeBtn) homeBtn.classList.add("hidden");
    } else {
      if (homeBtn) homeBtn.classList.remove("hidden");
    }
  }

  // データのクリーンアップ
  if (unsubscribePlans) unsubscribePlans();
  if (unsubscribeMemo) unsubscribeMemo();
  if (unsubscribeMonthChat) unsubscribeMonthChat();
  if (unsubscribeJournal) unsubscribeJournal();

  // 各画面の描画
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
  
  // イベントリスナー設定
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

function setupLtimerEvents() {
  // 重複登録防止のためのフラグチェック
  if(window._ltEventsSetup) return;
  window._ltEventsSetup = true;

  // 内部戻るボタン
  $("#lt-back button").onclick = (e) => {
    e.stopPropagation();
    stopCustomTimer();
    if(ltPmState.lanes) ltPmState.lanes.forEach(l => l.running = false);
    if(ltSessionRef && ltUserId) {
        ltSessionRef.child('users').child(ltUserId).remove();
        ltSessionRef.off(); ltSessionRef = null; ltUserId = null;
        $("#share-status-msg").textContent = "";
    }
    showLtScreen('menu');
  };

  // 共有接続
  $("#share-connect-btn").onclick = async () => {
    const code = $("#share-passcode").value.trim();
    if(!code) return alert("合言葉を入力してください");
    await connectLtSession(code);
  };

  // モード選択
  $("#choose-split").onclick = () => { initSplit(!!ltSessionRef); showLtScreen('split'); };
  $("#choose-pm").onclick = (e) => { if(!e.target.disabled) { initPacemaker(); showLtScreen('pm'); }};
  $("#choose-custom").onclick = (e) => { if(!e.target.disabled) { initCustom(); showLtScreen('custom'); }};

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
  $("#help-split").onclick = () => showHelp('split');
  $("#help-pm").onclick = () => showHelp('pm');
  $("#help-custom").onclick = () => showHelp('custom');
  $("#help-close").onclick = () => $("#lt-help").classList.add("lt-hidden");
  $("#summary-close").onclick = () => $("#lt-summary").classList.add("lt-hidden");
}

function updateLtChooserView() {
  const isShared = !!ltSessionRef;
  const msg = $("#share-status-msg");
  if(isShared) {
      msg.textContent = "接続中";
      msg.style.color = "var(--primary)";
  } else {
      msg.textContent = "";
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

// ★ ヘルパー: メンバー選択肢のHTML生成
function getLtMemberOptions(selectedVal) {
  const ms = document.getElementById("memberSelect");
  // メンバーリストがまだロードされていない、または存在しない場合は単純なテキスト表示用のoptionを返す
  if(!ms || ms.options.length === 0) return `<option value="${selectedVal}">${selectedVal || '選手を選択'}</option>`;
  
  let html = '<option value="">-- 選手を選択 --</option>';
  // グローバルなメンバー選択プルダウン(memberSelect)の選択肢をコピー
  for(let i=0; i<ms.options.length; i++) {
    const opt = ms.options[i];
    // ID(value)が一致するかチェック
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
        controls.classList.remove('lt-hidden');
        standalone.classList.add('lt-hidden');
        if(!ltUserId) standalone.classList.remove('lt-hidden');
    } else {
        controls.classList.add('lt-hidden');
        standalone.classList.remove('lt-hidden');
        // 初期化: 自分1人 (IDでセット)
        const myId = viewingMemberId || ''; 
        ltWatches = [{id:0, name:myId, running:false, start:0, elapsed:0, lastLap:0, laps:[], target:0}];
        renderSplit();
    }
}

function renderSplit() {
    const grid = $("#split-grid");
    grid.innerHTML = ltWatches.map(w => {
        let cum = 0;
        const hist = (w.laps || []).map((l, i) => {
            cum += l;
            return `<div style="display:flex; justify-content:space-between; font-size:11px;"><span>${i+1}</span><span>${fmt(l)}</span><span style="color:#666">(${fmt(cum)})</span></div>`;
        }).reverse().join('');
        
        // ★ 修正: input type="text" を select に変更
        return `
        <div class="runner-card ${getCardColor(w)}" id="w-${w.id}">
           <button class="lt-btn-del" data-id="${w.id}" onclick="ltDelWatch(${w.id})" style="position:absolute; right:4px; top:4px; background:#ddd; border-radius:50%; width:24px; height:24px; border:none; z-index:10;">×</button>
           <div class="runner-card-header">
             <select onchange="ltUpdateName(${w.id}, this.value)" class="lt-input" style="padding:4px; font-weight:bold;">
                ${getLtMemberOptions(w.name)}
             </select>
             <input type="number" placeholder="目標" value="${w.target||''}" onchange="ltUpdateTarget(${w.id}, this.value)" class="lt-input" style="padding:4px;">
           </div>
           <div class="runner-main-time">${fmt(w.elapsed)}</div>
           <div class="runner-lap-live">${fmt(w.elapsed - w.lastLap)}</div>
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
    const lapTime = (Date.now() - w.start) - w.lastLap;
    const diff = (w.target * 1000) - lapTime;
    if(diff < 0) return 'frame-bad';
    if(diff < 5000) return 'frame-warn5';
    if(diff < 10000) return 'frame-warn10';
    return '';
}

// Windowスコープ関数
window.ltDelWatch = (id) => {
    ltWatches = ltWatches.filter(w => w.id !== id);
    if(ltSessionRef) updateSharedWatches(); else renderSplit();
};
window.ltUpdateName = (id, val) => {
    const w = ltWatches.find(x => x.id === id); if(w) w.name = val;
    if(ltSessionRef) updateSharedWatches();
};
window.ltUpdateTarget = (id, val) => {
    const w = ltWatches.find(x => x.id === id); if(w) w.target = +val;
    if(ltSessionRef) updateSharedWatches();
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
        const lap = w.running ? (elapsed - w.lastLap) : (w.elapsed - w.lastLap);
        
        card.querySelector('.runner-main-time').textContent = fmt(elapsed);
        card.querySelector('.runner-lap-live').textContent = fmt(lap);
        card.className = `runner-card ${getCardColor({...w, running: w.running, start:w.start, lastLap:w.lastLap})}`;
    });
}

// Standalone Buttons
$("#standalone-controls button[data-action='add']").onclick = () => {
    const newId = ltWatches.length ? Math.max(...ltWatches.map(w=>w.id))+1 : 0;
    ltWatches.push({id:newId, name:'', running:false, elapsed:0, start:0, lastLap:0, laps:[]});
    renderSplit();
};
$("#standalone-controls button[data-action='start-all']").onclick = () => {
    const now = Date.now();
    ltWatches.forEach(w => { if(!w.running){ w.running=true; w.start=now-w.elapsed; }});
    renderSplit();
};
$("#standalone-controls button[data-action='stop-all']").onclick = () => {
    const now = Date.now();
    ltWatches.forEach(w => { if(w.running){ w.running=false; w.elapsed=now-w.start; }});
    renderSplit();
};
$("#standalone-controls button[data-action='review-reset']").onclick = () => {
    let html = '<table style="width:100%; text-align:center;"><tr><th>Name</th><th>Total</th><th>Laps</th></tr>';
    ltWatches.forEach(w => {
        // 名前解決（IDから表示名へ）
        const dispName = getDisplayName(w.name) || w.name || 'No Name';
        html += `<tr><td>${dispName}</td><td>${fmt(w.elapsed)}</td><td>${w.laps.length}</td></tr>`;
    });
    html += '</table>';
    $("#summary-table").innerHTML = html;
    $("#lt-summary").classList.remove('lt-hidden');
    ltWatches = ltWatches.map(w => ({...w, running:false, elapsed:0, start:0, lastLap:0, laps:[]}));
    renderSplit();
};

// ===== PM Logic =====
function initPacemaker() {
    ltPmState = { lanes: [] };
    renderPmSettings();
}

function renderPmSettings(cnt=1) {
    $("#pm-lane-count").textContent = cnt + "レーン";
    const box = $("#pm-lane-targets");
    box.innerHTML = '';
    for(let i=1; i<=cnt; i++) {
        // ★ 修正: テキスト入力ではなくメンバー選択プルダウンに変更
        // デフォルトは自分、または空
        const defVal = (i===1) ? (viewingMemberId||'') : '';
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
$("#pm-lane-plus").onclick = () => { let c=parseInt($("#pm-lane-count").textContent); if(c<4) renderPmSettings(c+1); };
$("#pm-lane-minus").onclick = () => { let c=parseInt($("#pm-lane-count").textContent); if(c>1) renderPmSettings(c-1); };

$("#pm-start-btn").onclick = () => {
    const dist = +$("#pm-distance").value;
    const reps = +$("#pm-reps").value;
    if(!dist || !reps) return;
    
    const cnt = parseInt($("#pm-lane-count").textContent);
    ltPmState.lanes = [];
    for(let i=1; i<=cnt; i++) {
        const val = $(`#pm-name-${i}`).value;
        const name = getDisplayName(val) || val || `レーン${i}`; // 名前解決
        const m = +$(`#pm-m-${i}`).value || 0;
        const s = +$(`#pm-s-${i}`).value || 0;
        ltPmState.lanes.push({
            id:i, name:name, 
            targetTime: (m*60+s)*1000, 
            running:false, startTime:0, laps:[], 
            rep:1, totalReps: reps
        });
    }
    
    document.querySelector("#lt-pm #pm-settings").classList.add("lt-hidden");
    document.querySelector("#lt-pm #pm-runner").classList.remove("lt-hidden");
    
    renderPmRunner();
};

function renderPmRunner() {
    const grid = $("#pm-runner-grid");
    grid.innerHTML = ltPmState.lanes.map(l => `
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
        document.querySelector(`#pm-l-${id} button`).textContent = "LAP";
        document.querySelector(`#pm-l-${id} button`).classList.replace('lt-bg-blue-500', 'lt-bg-gray-800');
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
    box.innerHTML = ltCustomSteps.map((s, i) => `
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
$("#custom-add-step-btn").onclick = () => { ltCustomSteps.push({type:'WORK', dur:30}); renderCustomSteps(); };

$("#custom-start-btn").onclick = () => {
    ltCustomState = {
        running: true, steps: [...ltCustomSteps], 
        rep: 1, totalReps: +$("#custom-reps").value,
        stepIdx: 0, stepStart: Date.now(), remain: ltCustomSteps[0].dur
    };
    $("#custom-settings").classList.add("lt-hidden");
    $("#custom-runner").classList.remove("lt-hidden");
};
$("#custom-reset-btn").onclick = () => {
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
    runner.className = `lt-h-full custom-runner ${curStep.type==='WORK'?'work-bg':'rest-bg'}`;
    $("#custom-runner-step-info").textContent = `${curStep.type} (${ltCustomState.stepIdx+1}/${ltCustomState.steps.length})`;
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
    if(!ltAudioCtx) ltAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if(ltAudioCtx.state === 'suspended') ltAudioCtx.resume();
    const osc = ltAudioCtx.createOscillator();
    const gain = ltAudioCtx.createGain();
    osc.connect(gain); gain.connect(ltAudioCtx.destination);
    osc.frequency.setValueAtTime(800, ltAudioCtx.currentTime);
    gain.gain.setValueAtTime(0.1, ltAudioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ltAudioCtx.currentTime + 0.1);
    osc.start(); osc.stop(ltAudioCtx.currentTime + 0.1);
}

// ===== Firebase Shared (Mock) =====
async function connectLtSession(code) {
    if(!firebase.apps.length) return;
    alert("接続機能はサーバー側の設定が必要です。UIのみ実装しました。");
    ltSessionRef = { key: code };
    updateLtChooserView();
}
function updateSharedWatches() {}

// ==========================================
// ========== Stadium Map Logic =============
// ==========================================

let mapInstance = null;
let markersLayer = null;

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

// ===== JOURNAL =====
async function saveJournal(){
  const activeCond=$('#conditionBtns button.active');
  const docRef=getJournalRef(teamId,memberId,selDate);
  const journalData={
    dist: Number($("#distInput").value||0),
    weight: Number($("#weightInput").value||0),
    train: $("#trainInput").value,
    feel:  $("#feelInput").value,
    condition: activeCond ? Number(activeCond.dataset.val) : null,
  };
  await docRef.set(journalData,{merge:true});
  dirty={ dist:false, train:false, feel:false, weight:false };
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

function initJournal(){
  const scheduleAutoSave = makeJournalAutoSaver(700);
  $("#distInput")?.addEventListener("input", ()=>{ dirty.dist=true; scheduleAutoSave(); renderWeek(); });
  $("#weightInput")?.addEventListener("input", ()=>{ dirty.weight=true; scheduleAutoSave(); });
  $("#trainInput")?.addEventListener("input", ()=>{ dirty.train=true; scheduleAutoSave(); });
  $("#feelInput")?.addEventListener("input", ()=>{ dirty.feel=true; scheduleAutoSave(); });

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

  // ナビゲーション等
  $("#weekPrev")?.addEventListener("click",()=>{ selDate=addDays(selDate,-7); renderJournal(); });
  $("#weekNext")?.addEventListener("click",()=>{ selDate=addDays(selDate, 7); renderJournal(); });
  $("#gotoToday")?.addEventListener("click",()=>{ selDate=new Date(); renderJournal(); });
  $("#datePicker")?.addEventListener("change",(e)=>{ selDate=parseDateInput(e.target.value); renderJournal(); });

  // 反映ボタン
  $("#mergeBtn")?.addEventListener("click", async ()=>{
    const scope  = $("#mergeScope").value;                
    const tagCSV = ($("#mergeTagFilter")?.value || "").trim();
    const text  = await collectPlansTextForDay(selDate, scope, tagCSV);
    if(text) $("#trainInput").value = ($("#trainInput").value ? ($("#trainInput").value+"\n") : "") + text;
    const types = await collectPlansTypesForDay(selDate, scope, tagCSV);
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
  // ★重要: スクショボタンのリスナーなどは省略しませんが、長くなるので元のコードにある shareModeBtn 処理などはそのまま維持してください
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
    renderPartsTags(j);

    if (!dirty.dist)  $("#distInput").value  = j.dist ?? "";
    if (!dirty.weight) $("#weightInput").value = j.weight ?? "";
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

// app.js (renderWeek 関数周辺を修正)

// ★★★ 追加: 週カレンダーの描画リクエストID（競合防止用） ★★★
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

// app.js (末尾の方、renderAllDistanceChartsの後ろあたりに追加)

async function renderWeightChart(){
  const ctx = document.getElementById('weightChart')?.getContext('2d');
  if(!ctx) return;

  // データの取得
  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
  const snaps = await db.collection('teams').doc(srcTeam).collection('members').doc(viewingMemberId).collection('journal').get();
  const journal = {}; 
  snaps.forEach(doc => journal[doc.id] = doc.data());

  const labels = [];
  const dataPoints = [];
  const today = new Date(); today.setHours(0,0,0,0);

  // 期間設定
  let start, end, stepFunc, labelFunc;
  
  if(weightMode === 'day'){
    // 直近14日
    const len = 14;
    end = addDays(today, weightOffset * len);
    start = addDays(end, -len + 1);
    
    for(let i=0; i<len; i++){
      const d = addDays(start, i);
      labels.push(`${d.getMonth()+1}/${d.getDate()}`);
      const val = journal[ymd(d)]?.weight;
      dataPoints.push(val ? Number(val) : null);
    }
    $("#weightRangeLabel").textContent = `${ymd(start)}~`;

  } else if(weightMode === 'week'){
    // 直近12週 (平均)
    const len = 12;
    const currWeekStart = startOfWeek(today);
    const baseWeek = addDays(currWeekStart, weightOffset * len * 7); // オフセットはlen週単位で移動
    
    // 表示は左(過去)から右(未来)へ
    // baseWeekを「右端(最新)」とするため、startはそこから戻る
    const endWeekStart = baseWeek; 
    
    for(let i=len-1; i>=0; i--){
      const ws = addDays(endWeekStart, -i * 7);
      labels.push(`${ws.getMonth()+1}/${ws.getDate()}`);
      
      // 週平均の計算
      let sum=0, count=0;
      for(let j=0; j<7; j++){
        const d = addDays(ws, j);
        const val = journal[ymd(d)]?.weight;
        if(val){ sum += Number(val); count++; }
      }
      dataPoints.push(count > 0 ? (sum/count).toFixed(1) : null);
    }
    const rangeStart = addDays(endWeekStart, -(len-1)*7);
    $("#weightRangeLabel").textContent = `${ymd(rangeStart)}~`;

  } else {
    // 直近12ヶ月 (平均)
    const len = 12;
    const baseMonth = new Date(today); baseMonth.setDate(1);
    baseMonth.setMonth(baseMonth.getMonth() + (weightOffset * len));

    for(let i=len-1; i>=0; i--){
      const d = new Date(baseMonth);
      d.setMonth(d.getMonth() - i);
      const mStr = getMonthStr(d); // YYYY-MM
      labels.push(`${d.getMonth()+1}月`);

      // 月平均の計算
      let sum=0, count=0;
      // その月の日誌データを走査（全データ走査は重いが、クライアント保持データ量なら許容範囲）
      // 本来はクエリで絞るべきだが、既存構造に合わせてJS側でフィルタ
      for(const k in journal){
        if(k.startsWith(mStr) && journal[k].weight){
          sum += Number(journal[k].weight);
          count++;
        }
      }
      dataPoints.push(count > 0 ? (sum/count).toFixed(1) : null);
    }
    const sDate = new Date(baseMonth); sDate.setMonth(sDate.getMonth()-(len-1));
    $("#weightRangeLabel").textContent = `${sDate.getFullYear()}/${sDate.getMonth()+1}~`;
  }

  if(weightChart) weightChart.destroy();
  weightChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: '体重 (kg)',
        data: dataPoints,
        borderColor: 'rgba(234, 88, 12, 1)', // オレンジ系
        backgroundColor: 'rgba(234, 88, 12, 0.1)',
        borderWidth: 2,
        tension: 0.1,
        spanGaps: true // データがない日は線を飛ばしてつなぐ
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { 
          beginAtZero: false, 
          grace: '10%'
        }
      }
    }
  });
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
      const targetColor = MM.LEVELS[brush.lvl||1];
      const pixel = mm.octx.getImageData(p.x, p.y, 1, 1).data;
      // アルファ値を見て「既に塗られている場所か」を判定
      const isPainted = pixel[3] > 50; 

      if(isPainted){
        // 既に塗られている場合、色が同じか判定 (RGB差分の合計で比較)
        const dist = Math.abs(pixel[0]-targetColor[0]) +
                     Math.abs(pixel[1]-targetColor[1]) +
                     Math.abs(pixel[2]-targetColor[2]);

        if(dist < 15) { // 許容誤差
          // 【同じ色】なら消す (トグル動作)
          floodErase(mm.octx, mm.wctx, p.x, p.y);
        } else {
          // 【違う色】なら上書き (一度消してから新しい色で塗る)
          floodErase(mm.octx, mm.wctx, p.x, p.y);
          floodFill(mm.octx, mm.wctx, p.x, p.y, MM.TOL, targetColor);
        }
      } else {
        // 塗られていない場所 → 普通に塗る
        floodFill(mm.octx, mm.wctx, p.x, p.y, MM.TOL, targetColor);   
      }
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

// app.js (tscSave 関数を修正)

async function tscSave(){
  try{
    const ta = document.getElementById('teamSharedComment');
    if(!ta) return;
    const text = ta.value;

    // データの実体があるチーム（メインチーム）を取得
    const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
    const ref = getJournalRef(srcTeam, viewingMemberId, selDate);
    
    const dayKey = ymd(selDate); 

    // 1. コメント保存（メインチームへ）
    await ref.set({ teamComment: text, lastCommentBy: memberId }, { merge:true });
    
    tscDirty = false;
    tscSetStatus('保存済み');

    // 2. 通知作成（★修正: これもメインチームへ送る）
    // これにより、通知もデータと同じ場所に集約される
    await createDayCommentNotifications({
      teamId: srcTeam,          // ★変更: currentのteamIdではなくsrcTeamを使う
      from: memberId,           // コメントした人
      to: viewingMemberId,      // 日誌の持ち主
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

   // const toMark = [];  // 既読化対象

    // app.js (renderNotify 関数内の snap.docs.forEach の部分を置き換え)

    snap.docs.forEach(doc=>{
      const n = doc.data();
      const notifId = doc.id; // ★通知ドキュメントIDを取得
      const div = document.createElement('div');
      // ★修正：新しいクラス名に変更し、カードデザインを適用
      div.className = 'notify-card'; 
      
      try {
        const at = new Date(n.ts || Date.now()).toLocaleString('ja-JP');
        const senderName = getDisplayName(n.from || '不明');
        
        // 通知本文の新しいHTML構造
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
          : `<div class="notify-content">システム通知</div>`; // その他のタイプの場合

        div.innerHTML = bodyHtml;

        // ★★★ 修正: クリック時に既読化と画面遷移を実行 ★★★
        div.querySelector('.notify-day-link')?.addEventListener('click', (e)=>{
          const day = e.currentTarget.getAttribute('data-day');
          const clickedId = e.currentTarget.getAttribute('data-notif-id'); 

          if (day && clickedId && /^\d{4}-\d{2}-\d{2}$/.test(day)){
              // 1. 該当通知を既読にする
              const notifRef = db.collection('teams').doc(teamId).collection('notifications').doc(clickedId);
              notifRef.update({ read: true }).catch(err => {
                  console.error("Failed to mark notification as read:", err);
              });
              
              // 2. 日誌タブに移動
              selDate = parseDateInput(day);
              switchTab('journal', true);
          }
        });

        box.appendChild(div);

      } catch (e) {
        // レンダリングエラーのデバッグコードはそのまま維持
        console.error("RENDERING ERROR: 通知表示に失敗しました", e, "データ:", n);
        div.innerHTML = `<div style="color:red;">【レンダリングエラー】コンソールを確認してください。</div>`;
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


// app.js (ファイル末尾に追加)

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
  $("#memberLabel").textContent = getDisplayName(viewingMemberId);
  refreshBadges();

  // 現在のタブを再描画してデータを読み込み直す
  switchTab($(".tab.active")?.dataset.tab, true);
}

// メンバー移動ボタンの初期化
function initMemberNav(){
    $("#memberPrev")?.addEventListener("click", () => goMemberDelta(-1));
    $("#memberNext")?.addEventListener("click", () => goMemberDelta(1));
}



// 通知バッジ用購読解除
let notifyBadgeUnsub = null;

// 通知バッジの常時監視を開始
function initNotifyBadgeCheck(){
  if(notifyBadgeUnsub) { try{ notifyBadgeUnsub(); }catch{} notifyBadgeUnsub=null; }
  
  const notifyTab = document.querySelector('[data-tab="notify"]');
  if(!notifyTab || !memberId) return;

  const col = db.collection('teams').doc(teamId).collection('notifications');
  
  // 自分宛ての未読アイテムを購読し、1つでもあればバッジを付ける
  const q = col.where('to','==', memberId)
               .where('read','==', false)
               .limit(1); // 1件でもあればOKなので、効率化のため limit(1)

  notifyBadgeUnsub = q.onSnapshot(snap => {
    if(notifyTab) {
      // 未読が1つでもあればtrue
      const hasUnread = !snap.empty; 
      notifyTab.classList.toggle('new-message', hasUnread);
    }
    // 通知タブを開くと renderNotify() が実行され read: true になるため、
    // ここで自動的にバッジが消える（markMemoRead のような個別処理は不要）
  }, err => {
    console.error("Notify badge check failed:", err);
  });
}

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

// チャットログにメッセージを追加
function addAiChatMessage(role, text){
  const box = document.getElementById('aiChatLog');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const name = role === 'user' ? 'あなた' : 'AIコーチ';
  // 改行を反映
  const htmlText = text.replace(/\n/g, '<br>');
  div.innerHTML = `<span class="name">${name}</span><span class="txt">${htmlText}</span>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  
  // 履歴に追加
  aiChatHistory.push({ role: role === 'user' ? 'user' : 'model', parts: [{ text: text }] });
}

// 部位名への変換用辞書
const BODY_PART_NAMES = {
  'neck': '首', 'shoulder': '肩', 'back': '背中', 'waist': '腰',
  'glute_l': '左臀部', 'glute_r': '右臀部', 'groin_l': '左股関節', 'groin_r': '右股関節',
  'quad_l': '左前もも', 'quad_r': '右前もも', 'hams_l': '左ハム', 'hams_r': '右ハム',
  'knee_l': '左膝', 'knee_r': '右膝', 'calf_l': '左ふくらはぎ', 'calf_r': '右ふくらはぎ',
  'shin_l': '左すね', 'shin_r': '右すね', 'ankle_l': '左足首', 'ankle_r': '右足首',
  'foot_l': '左足裏', 'foot_r': '右足裏'
};

// app.js (runGeminiAnalysis 関数)

async function runGeminiAnalysis(apiKey, isInitial, userMessage = "") {
  const runBtn = document.getElementById('runAiBtn');
  const sendBtn = document.getElementById('aiSendBtn');
  const cleanKey = apiKey.trim().replace(/:\d+$/, '');

  if(isInitial) runBtn.disabled = true;
  sendBtn.disabled = true;

  try {
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
        
        // ★筋肉マップの「塗り(mmStats)」から疲労部位を特定
        let fatigueParts = [];
        const stats = data.mmStats || {}; 
        Object.keys(stats).forEach(partId => {
          const val = stats[partId]; 
          if(val > 0) {
            const name = BODY_PART_NAMES[partId] || partId;
            // 塗り面積(px数)に応じてレベルを推測
            const lv = val > 2000 ? 3 : (val > 500 ? 2 : 1); 
            fatigueParts.push(`${name}(Lv${lv})`);
          }
        });
        const fatigueStr = fatigueParts.length > 0 ? fatigueParts.join(", ") : "なし";
        let menuText = (data.train || "").replace(/\n/g, " ").slice(0, 50);

        history.push(`- ${ymd(d)}: ${data.dist||0}km, [${(data.tags||[]).join(',')}], 内容:${menuText}, 疲労:${fatigueStr}, 調子:${data.condition||'-'}`);
      }

      const systemPrompt = `あなたは陸上中長距離のプロコーチです。
【プロフィール】${profileText}
【直近7日間のログ】
${history.join('\n')}
上記データを分析し、特に筋肉マップから抽出された「疲労部位」と練習メニューの関連性を科学的に分析してアドバイスしてください。`;

      aiChatHistory = [{ role: 'user', parts: [{ text: systemPrompt }] }];
    } else {
      // チャット継続時は aiChatHistory は更新済み
    }

    // --- モデル切り替えのリレー方式 ---
    let json;
    const call = async (model) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cleanKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: aiChatHistory })
      });
      if(!res.ok) throw { status: res.status, model: model };
      return res.json();
    };

    try {
      // 1回目: 本命 2.0 Flash
      json = await call('gemini-2.0-flash');
    } catch(e1) {
      console.warn("2.0 Flash Busy. Waiting 5s for Backup...", e1);
      // 混雑時は5秒待つ
      await new Promise(r => setTimeout(r, 5000));
      try {
        // 2回目: 予備 1.5 Flash (正式名称に変更)
        json = await call('gemini-1.5-flash');
      } catch(e2) {
        console.warn("Backup failed. Waiting 5s for Final...", e2);
        await new Promise(r => setTimeout(r, 5000));
        // 3回目: 最終予備
        json = await call('gemini-pro-latest');
      }
    }

    const aiText = json.candidates?.[0]?.content?.parts?.[0]?.text || '回答を得られませんでした';
    addAiChatMessage('model', aiText);

  } catch(e) {
    console.error(e);
    let errorMsg = "エラーが発生しました。時間を置いて試してください。";
    if(e.status === 429) errorMsg = "アクセス集中により制限されています。1分ほど待ってから再度お試しください。";
    addAiChatMessage('system', errorMsg);
  } finally {
    runBtn.disabled = false;
    sendBtn.disabled = false;
  }
}
// API呼び出し補助
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
