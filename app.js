// ===== Firebase Configuration =====
const firebaseConfig = {
    apiKey: "AIzaSyA8oCOusnqZCSax9ZY3-n4KNt2AxEmvT-E",
    authDomain: "athlog-126d2.firebaseapp.com",
    projectId: "athlog-126d2",
    storageBucket: "athlog-126d2.appspot.com",
    messagingSenderId: "784178114661",
    appId: "1:784178114661:web:d41103b0dad1187b85168c"
};

// ===== Firebase Initialization =====
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// ===== Utilities =====
const $ = (q, el = document) => el.querySelector(q);
const $$ = (q, el = document) => Array.from(el.querySelectorAll(q));

function ymd(d) { 
  const date = new Date(d.getTime() - (d.getTimezoneOffset() * 60000));
  return date.toISOString().slice(0, 10);
}
function startOfWeek(d) { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function getMonthStr(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function getWeekDates(d) {
  const s = startOfWeek(d);
  return [...Array(7).keys()].map(i => addDays(s, i));
}

async function sumWeekKm(d) {
  const dates = getWeekDates(d);
  let s = 0;
  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
  for (const dt of dates) {
    const doc = await getJournalRef(srcTeam, viewingMemberId, dt).get();
    if (doc.exists) s += Number(doc.data().dist || 0);
  }
  return s;
}

// ===== Main/Sub helpers =====
function getProfiles() {
  try { return JSON.parse(localStorage.getItem('athlog:profiles') || '[]'); }
  catch { return []; }
}
function upsertProfile(team, member) {
  const arr = getProfiles();
  if (!arr.some(p => p.team === team && p.member === member)) {
    arr.push({ team, member });
    localStorage.setItem('athlog:profiles', JSON.stringify(arr));
  }
}
function getMainTeamOf(user) {
  try {
    const map = JSON.parse(localStorage.getItem('athlog:mainTeamByUser') || '{}');
    return map[user] || null;
  } catch { return null; }
}
function setMainTeamOf(user, team) {
  const map = JSON.parse(localStorage.getItem('athlog:mainTeamByUser') || '{}');
  map[user] = team;
  localStorage.setItem('athlog:mainTeamByUser', JSON.stringify(map));
}
async function applyMirrorFlagsForUser(user, mainTeam) {
  const myTeams = getProfiles().filter(p => p.member === user).map(p => p.team);
  for (const t of myTeams) {
    const ref = getMembersRef(t).doc(user);
    if (t === mainTeam) {
      await ref.set({ mirrorFromTeamId: firebase.firestore.FieldValue.delete() }, { merge: true });
    } else {
      await ref.set({ mirrorFromTeamId: mainTeam }, { merge: true });
    }
  }
}
async function getViewSourceTeamId(currTeam, member) {
  try {
    const snap = await getMembersRef(currTeam).doc(member).get();
    return snap.data()?.mirrorFromTeamId || currTeam;
  } catch { return currTeam; }
}
function isEditableHere(currTeam, myUser, viewingUser) {
  if (viewingUser !== myUser) return false;
  const main = getMainTeamOf(myUser);
  if (!main) return true;
  return currTeam === main;
}
async function chooseMainTeam(newMainTeam) {
  if (!memberId || !newMainTeam) return;
  setMainTeamOf(memberId, newMainTeam);
  await applyMirrorFlagsForUser(memberId, newMainTeam);
  switchTab($(".tab.active")?.dataset.tab, true);
}

// ===== Insight helpers =====
async function getPeriodStats({ teamId, memberId, start, end }) {
  let distance = 0;
  let fatigueScore = 0;
  let condSum = 0, condCount = 0;
  const tagCount = {};

  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const snap = await getJournalRef(teamId, memberId, d).get();
    if (!snap.exists) continue;
    const j = snap.data() || {};

    distance += Number(j.dist || 0);

    // SVG部位のスコア
    if (j.regions && typeof j.regions === 'object') {
      fatigueScore += Object.values(j.regions).reduce((a, v) => a + (Number(v) || 0), 0);
    }

    if (Array.isArray(j.tags)) j.tags.forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; });
    if (typeof j.condition === 'number') { condSum += j.condition; condCount++; }
  }

  const topTags = Object.entries(tagCount).sort((a,b)=>b[1]-a[1]).slice(0,2).map(([t])=>t);
  const avgCond = condCount ? (condSum/condCount) : null;
  return { distance, fatigueScore, topTags, avgCond };
}
function fatigueLevel(score) {
  if (score > 40) return '高';
  if (score > 20) return '中';
  if (score > 0)  return '低';
  return 'なし';
}
async function makeAICommentForPeriod({ teamId, memberId, start, end, label='期間' }) {
  const { distance, fatigueScore, topTags, avgCond } = await getPeriodStats({ teamId, memberId, start, end });
  const distMsg =
    distance > 80 ? 'ハイボリューム' :
    distance > 50 ? '良い積み上げ'   : '距離は控えめ';
  const condMsg = (avgCond != null) ? `平均コンディション${avgCond.toFixed(1)}。` : '';
  const tagMsg  = topTags.length ? `主な内容：${topTags.join(' / ')}。` : '';
  let fatigueMsg = '';
  if (fatigueScore > 40) fatigueMsg = '強い疲労の兆候。回復を最優先に。';
  else if (fatigueScore > 20) fatigueMsg = 'やや疲労。ストレッチ等のケアを。';
  else if (distance > 10)     fatigueMsg = '概ね良好。';
  return `【${label}分析AI】総距離${distance.toFixed(1)}km（${distMsg}）。${condMsg}${tagMsg} 疲労度:${fatigueLevel(fatigueScore)}。${fatigueMsg}`;
}
// 週AI → 直近7日AI
async function weekAIComment(d) {
  const end = new Date(d); end.setHours(0, 0, 0, 0);
  const start = addDays(end, -6);
  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
  return await makeAICommentForPeriod({ teamId: srcTeam, memberId: viewingMemberId, start, end, label: '直近7日' });
}

// ===== 旧フリーハンドの“表示だけ”再生 &（任意）正規化保存 =====
function ensureLegacyCanvas() {
  const img = document.getElementById('humanImg');
  const cvs = document.getElementById('legacyPaint');
  if (!img || !cvs) return null;
  const rect = img.getBoundingClientRect();
  if (cvs.width  !== Math.round(rect.width))  cvs.width  = Math.round(rect.width);
  if (cvs.height !== Math.round(rect.height)) cvs.height = Math.round(rect.height);
  return cvs.getContext('2d');
}
function renderLegacyPaint(journal) {
  const ctx = ensureLegacyCanvas();
  if (!ctx) return;
  ctx.clearRect(0,0,ctx.canvas.width, ctx.canvas.height);
  const strokes = Array.isArray(journal?.paint) ? journal.paint : [];
  const w = ctx.canvas.width, h = ctx.canvas.height;
  strokes.forEach(s => {
    if (!Array.isArray(s.pts) || s.pts.length < 2) return;
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
    ctx.lineWidth = 18;
    ctx.lineCap = 'round';
    ctx.strokeStyle = s.erase ? 'rgba(0,0,0,1)'
      : (s.lvl==1 ? 'rgba(245,158,11,0.6)'
      : (s.lvl==2 ? 'rgba(239,68,68,0.6)' : 'rgba(217,70,239,0.6)'));
    ctx.beginPath();
    const first = s.pts[0];
    const x0 = (first.nx ?? (first.x / w)) * w;
    const y0 = (first.ny ?? (first.y / h)) * h;
    ctx.moveTo(x0, y0);
    for (let i = 1; i < s.pts.length; i++) {
      const p = s.pts[i];
      const x = (p.nx ?? (p.x / w)) * w;
      const y = (p.ny ?? (p.y / h)) * h;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
}
// 任意：古い {x,y} を {nx,ny} に1度だけ移行して保存
async function migrateOldPaintIfNeeded(team, member, day, j) {
  const hasOld = Array.isArray(j.paint) && j.paint.some(st => st.pts?.[0] && st.pts[0].nx === undefined);
  if (!hasOld) return;
  const ctx = ensureLegacyCanvas();
  if (!ctx) return;
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const migrated = j.paint.map(st => ({
    ...st,
    pts: (st.pts || []).map(p => (p.nx !== undefined && p.ny !== undefined)
      ? p
      : { nx: (p.x / w), ny: (p.y / h) })
  }));
  await getJournalRef(team, member, day).set({ paint: migrated }, { merge: true });
}
// 画面サイズが変わったら再描画
window.addEventListener('resize', () => { if (lastJournal) renderLegacyPaint(lastJournal); });

// ---- Team Memo paging state ----
let memoPageSize = 30;
let memoOldestDoc = null;
let memoLatestTs = 0;
let memoLiveUnsub = null;
let memoLoadingOlder = false;
const memoLastViewKey = () => `athlog:${teamId}:${memberId}:lastMemoView`;
async function markMemoRead() {
  const snap = await getTeamMemoCollectionRef(teamId).orderBy('ts', 'desc').limit(1).get();
  const latestTs = snap.empty ? Date.now() : (snap.docs[0].data().ts || Date.now());
  localStorage.setItem(memoLastViewKey(), String(latestTs));
  const memoTab = document.querySelector('[data-tab="memo"]');
  memoTab?.classList.remove('new-message');
}

// ===== App State =====
let teamId = null, memberId = null, viewingMemberId = null;
let selDate = new Date();
let brush = { lvl: 1, erase: false };
let distanceChart = null, conditionChart = null;
let dashboardOffset = 0, dashboardMode = 'month';
let conditionChartOffset = 0;
let unsubscribePlans, unsubscribeMemo, unsubscribeMonthChat, unsubscribeJournal;
let dirty = { dist: false, train: false, feel: false };

// ===== Data Access Layer (Firestore) =====
const getJournalRef = (team, member, day) => db.collection('teams').doc(team).collection('members').doc(member).collection('journal').doc(ymd(day));
const getGoalsRef = (team, member, month) => db.collection('teams').doc(team).collection('members').doc(member).collection('goals').doc(month);
const getPlansCollectionRef = (team) => db.collection('teams').doc(team).collection('plans');
const getTeamMemoCollectionRef = (team) => db.collection('teams').doc(team).collection('memo');
const getMonthChatCollectionRef = (team, month) => db.collection('teams').doc(team).collection('chat').doc(month).collection('messages');
const getMembersRef = (team) => db.collection('teams').doc(team).collection('members');

// ===== UI Boot & Tab Control =====
async function showApp() {
  $("#teamLabel").textContent = teamId;
  $("#memberLabel").textContent = viewingMemberId;
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  const __nowMon = getMonthStr(new Date());
  if ($("#monthPick") && !$("#monthPick").value) $("#monthPick").value = __nowMon;
  if ($("#planMonthPick") && !$("#planMonthPick").value) $("#planMonthPick").value = __nowMon;

  await populateMemberSelect();
  const memberSelect = $("#memberSelect");
  if (memberSelect) memberSelect.addEventListener('change', () => {
    viewingMemberId = $("#memberSelect").value;
    $("#memberLabel").textContent = viewingMemberId;
    selDate = new Date();
    const dp = $("#datePicker");
    if (dp) dp.value = ymd(selDate);
    switchTab($(".tab.active")?.dataset.tab, true);
  });

  initJournal(); initMonth(); initPlans(); initDashboard(); initMemo();

  selDate = new Date();
  const dp = $("#datePicker");
  if (dp) dp.value = ymd(selDate);
  switchTab("journal");
  checkNewMemo();
  initTeamSwitcher();
}
function initTeamSwitcher() {
  const wrap = document.getElementById('teamSwitchWrap');
  const sel  = document.getElementById('teamSwitchSelect');
  const btn  = document.getElementById('setAsMainBtn');
  if (!wrap || !sel || !btn) return;
  const profiles = getProfiles().filter(p => p.member === memberId);
  if (profiles.length <= 1) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'flex';
  sel.innerHTML = profiles.map(p => {
    const isMain = getMainTeamOf(memberId) === p.team;
    return `<option value="${p.team}" ${p.team===teamId ? 'selected' : ''}>
      ${p.team}${isMain ? '（メイン）' : ''}
    </option>`;
  }).join('');
  sel.onchange = async (e) => {
    teamId = e.target.value;
    $("#teamLabel").textContent = teamId;
    await populateMemberSelect();
    switchTab($(".tab.active")?.dataset.tab, true);
  };
  btn.onclick = async () => {
    const newMain = sel.value;
    await chooseMainTeam(newMain);
    initTeamSwitcher();
  };
}
initTeamSwitcher();

function switchTab(id, forceRender = false) {
  if (!forceRender && $(".tab.active")?.dataset.tab === id) return;
  $$(".tab").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === id));
  $$(".tabpanel").forEach(p => p.classList.toggle("active", p.id === id));
  if (unsubscribePlans) unsubscribePlans();
  if (unsubscribeMemo) unsubscribeMemo();
  if (unsubscribeMonthChat) unsubscribeMonthChat();
  if (unsubscribeJournal) unsubscribeJournal();
  if (id === "journal") renderJournal();
  if (id === "month") renderMonth();
  if (id === "plans") renderPlans();
  if (id === "dashboard") renderDashboard();
  if (id === "memo") { renderMemo(); markMemoRead(); }
}

// ===== Login & Logout =====
$("#logoutBtn")?.addEventListener("click", () => {
  localStorage.removeItem("athlog:last");
  teamId = null; memberId = null; viewingMemberId = null;
  window.location.reload();
});
$$(".tab").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));

// ----- SVG部位の表示反映（regions -> f1/f2/f3）-----
function renderRegions(regions = {}) {
  document.querySelectorAll('#bodyMap .region').forEach(el => {
    el.classList.remove('f1','f2','f3');
    const lvl = regions[el.dataset.id];
    if (lvl) el.classList.add(`f${lvl}`);
  });
}

// ----- SVGクリック処理 -----
function initRegionMap() {
  const svg = document.getElementById('bodyMap');
  if (!svg) return;
  svg.addEventListener('click', async (e) => {
    const target = e.target.closest('.region');
    if (!target) return;
    if (!isEditableHere(teamId, memberId, viewingMemberId)) return;
    const id = target.dataset.id;
    const docRef = getJournalRef(teamId, memberId, selDate);
    const payload = brush.erase
      ? { [`regions.${id}`]: firebase.firestore.FieldValue.delete() }
      : { [`regions.${id}`]: (brush.lvl || 1) };
    await docRef.set(payload, { merge: true });
  });
}

// ===== JOURNAL =====
async function saveJournal() {
  const activeCond = $('#conditionBtns button.active');
  const docRef = getJournalRef(teamId, memberId, selDate);
  const journalData = {
    dist: Number($("#distInput").value || 0),
    train: $("#trainInput").value,
    feel: $("#feelInput").value,
    condition: activeCond ? Number(activeCond.dataset.val) : null,
  };
  await docRef.set(journalData, { merge: true });
  dirty = { dist: false, train: false, feel: false };
  renderWeek();
}
function initJournal() {
  $("#distInput")?.addEventListener("input", () => { dirty.dist  = true; });
  $("#trainInput")?.addEventListener("input", () => { dirty.train = true; });
  $("#feelInput")?.addEventListener("input", () => { dirty.feel  = true; });
  const brushBtns = $$('.palette .lvl, .palette #eraser');
  brushBtns.forEach(b => b.addEventListener('click', () => {
    brush.lvl = Number(b.dataset.lvl) || 1;
    brush.erase = b.id === 'eraser';
    brushBtns.forEach(btn => btn.classList.remove('active'));
    b.classList.add('active');
  }));
  if (brushBtns.length) $('.palette .lvl[data-lvl="1"]')?.classList.add('active');

  $$(".qbtn").forEach(b => b.addEventListener("click", async () => {
    const docRef = getJournalRef(teamId, memberId, selDate);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      const base = snap.data() || {};
      const curr = Array.isArray(base.tags) ? [...base.tags] : [];
      const tag = b.textContent.trim();
      const idx = curr.indexOf(tag);
      if (idx >= 0) curr.splice(idx, 1);
      else { if (curr.length >= 2) curr.shift(); curr.push(tag); }
      const activeCondBtn = $('#conditionBtns button.active');
      tx.set(docRef, {
        dist: Number($("#distInput").value || 0),
        train: $("#trainInput").value,
        feel:  $("#feelInput").value,
        condition: activeCondBtn ? Number(activeCondBtn.dataset.val) : null,
        tags: curr
      }, { merge: true });
    });
    dirty = { dist:false, train:false, feel:false };
  }));

  $("#weekPrev")?.addEventListener("click", () => { selDate = addDays(selDate, -7); renderJournal(); });
  $("#weekNext")?.addEventListener("click", () => { selDate = addDays(selDate,  7); renderJournal(); });
  $("#gotoToday")?.addEventListener("click", () => { selDate = new Date(); renderJournal(); });
  $("#datePicker")?.addEventListener("change", (e) => { selDate = new Date(e.target.value); renderJournal(); });

  $("#mergeBtn")?.addEventListener("click", async () => {
    const scope = $("#mergeScope").value;
    const text = await collectPlansTextForDay(selDate, scope);
    if (text) $("#trainInput").value = ($("#trainInput").value ? ($("#trainInput").value + "\n") : "") + text;
    const types = await collectPlansTypesForDay(selDate, scope);
    if (types.length) {
      const docRef = getJournalRef(teamId, memberId, selDate);
      await docRef.set({ tags: types.slice(0, 2) }, { merge: true });
      renderWeek();
    }
  });

  $$('#conditionBtns button').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#conditionBtns button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  $("#saveBtn")?.addEventListener("click", async (e) => {
    const btn = e.target;
    await saveJournal();
    btn.textContent = "保存しました！"; btn.disabled = true;
    setTimeout(() => { btn.textContent = "この日を保存"; btn.disabled = false; }, 1500);
  });

  // SVGクリック塗り
  initMuscleMap();
}

async function renderJournal() {
  if (unsubscribeJournal) unsubscribeJournal();
  if (!viewingMemberId) viewingMemberId = memberId;

  dirty = { dist:false, train:false, feel:false };

  const editableHere = isEditableHere(teamId, memberId, viewingMemberId);
  $$('#journal input, #journal textarea, #journal .qbtn, #saveBtn, #mergeBtn, #conditionBtns button, .palette button')
    .forEach(el => {
      const isNavControl = ['weekPrev','weekNext','gotoToday','datePicker'].includes(el.id);
      if (!isNavControl) el.disabled = !editableHere;
    });

  const mergeScopeSelect = $("#mergeScope");
  if (mergeScopeSelect) {
    mergeScopeSelect.innerHTML =
      `<option value="auto">予定から追加(自動)</option>
       <option value="${memberId}">${memberId}の予定</option>
       <option value="team">全員の予定</option>`;
  }

  $("#datePicker").value = ymd(selDate);

  await renderWeek();

  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);

  unsubscribeJournal = getJournalRef(srcTeam, viewingMemberId, selDate).onSnapshot(doc => {
    const j = doc.data() || { dist: 0, train: "", feel: "", tags: [], paint: [], condition: null, regions: {} };
    lastJournal = j;
    drawMuscleFromDoc(j);

    if (!dirty.dist)  { $("#distInput").value  = j.dist ?? ""; }
    if (!dirty.train) { $("#trainInput").value = j.train ?? ""; }
    if (!dirty.feel)  { $("#feelInput").value  = j.feel ?? ""; }

    $$('#conditionBtns button').forEach(b => b.classList.remove('active'));
    if (j.condition) $(`#conditionBtns button[data-val="${j.condition}"]`)?.classList.add('active');

    // ▼ 旧paintの再生（先に）
    (async () => {
      try { await migrateOldPaintIfNeeded(srcTeam, viewingMemberId, selDate, j); } catch(_) {}
      renderLegacyPaint(j);
      renderRegions(j.regions || {});
    })();

    renderQuickButtons(j);
    weekAIComment(selDate).then(comment => $("#aiBox").textContent = comment);
  });
}

async function renderWeek() {
  const chips = $("#weekChips"); if (!chips) return;
  chips.innerHTML = "";
  const days = getWeekDates(selDate);
  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);

  for (const d of days) {
    const key = ymd(d);
    const doc = await getJournalRef(srcTeam, viewingMemberId, d).get();
    const j = doc.data() || {};
    const btn = document.createElement("button");
    btn.className = "chip" + (ymd(selDate) === key ? " active" : "");
    const tags = j.tags || [];
    btn.innerHTML = `<div>${["日","月","火","水","木","金","土"][d.getDay()]} ${d.getDate()}</div><div class="km">${(j.dist || 0)}km</div>`;
    btn.style.background = ''; btn.style.color = '';
    if (tags.length) {
      const map = { ジョグ:"var(--q-jog)", ポイント:"var(--q-point)", 補強:"var(--q-sup)", オフ:"var(--q-off)", その他:"var(--q-other)" };
      btn.style.color = '#1f2937';
      if (tags.length == 1) btn.style.backgroundColor = map[tags[0]];
      else btn.style.background = `linear-gradient(90deg, ${map[tags[0]]} 50%, ${map[tags[1]]} 50%)`;
    }
    btn.addEventListener("click", () => { selDate = d; renderJournal(); });
    chips.appendChild(btn);
  }
  const sum = await sumWeekKm(selDate);
  $("#weekSum").textContent = `週 走行距離: ${sum.toFixed(1)} km`;
}

function renderQuickButtons(j) {
  const currentTags = j?.tags || [];
  $$(".qbtn").forEach(b => {
    const tag = b.textContent.trim();
    b.classList.toggle('active', currentTags.includes(tag));
  });
}

// ===== MONTH LIST =====
function initMonth() {
  $("#mPrev")?.addEventListener("click", () => { const m = $("#monthPick").value.split("-"); const d = new Date(Number(m[0]), Number(m[1]) - 2, 1); $("#monthPick").value = getMonthStr(d); renderMonth(); });
  $("#mNext")?.addEventListener("click", () => { const m = $("#monthPick").value.split("-"); const d = new Date(Number(m[0]), Number(m[1]), 1); $("#monthPick").value = getMonthStr(d); renderMonth(); });
  $("#monthPick")?.addEventListener("change", renderMonth);

  const saveBtn = $("#saveMonthGoalBtn");
  if (saveBtn) saveBtn.addEventListener("click", async (e) => {
    const monthStr = $("#monthPick").value;
    await getGoalsRef(teamId, memberId, monthStr).set({ goal: $("#monthGoalInput").value });
    const btn = e.target; btn.textContent = "保存しました！";
    setTimeout(() => { btn.textContent = "目標を保存"; }, 1500);
  });
}
async function renderMonth() {
  const editableHere = isEditableHere(teamId, memberId, viewingMemberId);
  $("#monthGoalInput").disabled = !editableHere;
  $("#saveMonthGoalBtn").disabled = !editableHere;

  const box = $("#monthList"); 
  if (!box) return;
  box.innerHTML = "";

  const mp = $("#monthPick");
  const monStr = (mp && mp.value) ? mp.value : getMonthStr(new Date());
  if (mp && !mp.value) mp.value = monStr;

  const [yy, mm] = monStr.split("-").map(Number);
  const lastDay = endOfMonth(new Date(yy, mm - 1, 1)).getDate();
  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);

  let sum = 0;
  for (let d = 1; d <= lastDay; d++) {
    const dt = new Date(yy, mm - 1, d);
    const dow = ["SU","MO","TU","WE","TH","FR","SA"][dt.getDay()];
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<div class="dow">${dow}<br>${d}</div><div class="txt"><div>—</div></div>`;
    row.addEventListener("click", () => { selDate = dt; switchTab("journal"); });
    box.appendChild(row);

    (async () => {
      try {
        const snap = await getJournalRef(srcTeam, viewingMemberId, dt).get();
        const j = snap.data() || {};
        sum += Number(j.dist || 0);
        $("#monthSum").textContent = `月間走行距離: ${sum.toFixed(1)} km`;

        const classMap = { ジョグ:"jog", ポイント:"point", 補強:"sup", オフ:"off", その他:"other" };
        const tags = Array.isArray(j.tags) ? j.tags : [];
        const tagsHtml = tags.length
          ? `<div class="month-tags">${tags.map(t => `<span class="cat-tag ${classMap[t]||""}">${t}</span>`).join("")}</div>`
          : "";

        const cond = j.condition;
        const condHtml = cond
          ? `<div class="condition-display">${Array(cond).fill(0).map(() => `<span class="star c${cond}">★</span>`).join("")}</div>`
          : "";

        const txt = row.querySelector(".txt");
        txt.innerHTML = `${tagsHtml}${condHtml}
          <div>${(j.train || "—")} <span class="km">${j.dist ? ` / ${j.dist}km` : ""}</span></div>`;
      } catch (err) {
        console.error("renderMonth day read error:", err);
      }
    })();
  }

  try {
    const goalDoc = await getGoalsRef(srcTeam, viewingMemberId, monStr).get();
    $("#monthGoalInput").value = goalDoc.data()?.goal || "";
  } catch (e) {
    console.error("read goal error:", e);
  }
}

// ===== Team Memo =====
function renderMemoItem(m) {
  const div = document.createElement("div");
  div.className = "msg";
  const time = new Date(m.ts).toLocaleString("ja-JP");
  div.innerHTML = `<span class="name">${m.mem}</span><span class="txt">${m.txt}</span><span class="muted">  ${time}</span>`;
  return div;
}
async function renderMemo() {
  if (unsubscribeMemo) { try { unsubscribeMemo(); } catch(_){} }
  if (memoLiveUnsub) { try { memoLiveUnsub(); } catch(_){} memoLiveUnsub = null; }

  const box = $("#memoChatLog");
  if (!box) return;

  box.innerHTML = "";
  memoOldestDoc = null;
  memoLatestTs = 0;

  const col = getTeamMemoCollectionRef(teamId);
  const initSnap = await col.orderBy('ts', 'desc').limit(memoPageSize).get();
  if (initSnap.empty) {
    box.innerHTML = `<div class="muted">まだメモはありません</div>`;
  } else {
    const docsDesc = initSnap.docs;
    memoOldestDoc = docsDesc[docsDesc.length - 1];
    memoLatestTs  = (docsDesc[0].data().ts) || 0;
    docsDesc.slice().reverse().forEach(d => {
      box.appendChild( renderMemoItem(d.data()) );
    });
    box.scrollTop = box.scrollHeight;
  }

  box.onscroll = async () => {
    if (box.scrollTop <= 0 && !memoLoadingOlder && memoOldestDoc) {
      memoLoadingOlder = true;
      const prevHeight = box.scrollHeight;
      const olderSnap = await col.orderBy('ts', 'desc').startAfter(memoOldestDoc).limit(memoPageSize).get();
      if (!olderSnap.empty) {
        const frag = document.createDocumentFragment();
        olderSnap.docs.slice().reverse().forEach(d => {
          frag.appendChild( renderMemoItem(d.data()) );
        });
        box.insertBefore(frag, box.firstChild);
        memoOldestDoc = olderSnap.docs[olderSnap.docs.length - 1];
        const newHeight = box.scrollHeight;
        box.scrollTop = newHeight - prevHeight;
      }
      memoLoadingOlder = false;
    }
  };

  memoLiveUnsub = col.orderBy('ts', 'desc').limit(1).onSnapshot(snap => {
    const d = snap.docs[0];
    if (!d) return;
    const data = d.data();
    if (data.ts > memoLatestTs) {
      box.appendChild( renderMemoItem(data) );
      memoLatestTs = data.ts;
      box.scrollTop = box.scrollHeight;
    }
  });

  unsubscribeMemo = () => {
    if (memoLiveUnsub) { try { memoLiveUnsub(); } catch(_){} memoLiveUnsub = null; }
    box.onscroll = null;
  };
}

// ===== PLANS (Schedule) =====
function createPlanTagHtml(type) {
  const classMap = { ジョグ: "jog", ポイント: "point", 補強: "sup", オフ: "off", その他: "other" };
  const className = classMap[type] || '';
  return `<span class="cat-tag ${className}">${type}</span>`;
}
function populatePlanScopeSelect() {
  const select = $("#planScope");
  if (!select) return;
  const currentVal = select.value;
  select.innerHTML = `
    <option value="all">全件</option>
    <option value="team">全員</option>
    <option value="${viewingMemberId}">${viewingMemberId}</option>
  `;
  select.value = currentVal || 'all';
}
function initPlans() {
  $("#pPrev")?.addEventListener("click", () => { const m = $("#planMonthPick").value.split("-"); const d = new Date(Number(m[0]), Number(m[1]) - 2, 1); $("#planMonthPick").value = getMonthStr(d); renderPlans(); });
  $("#pNext")?.addEventListener("click", () => { const m = $("#planMonthPick").value.split("-"); const d = new Date(Number(m[0]), Number(m[1]), 1); $("#planMonthPick").value = getMonthStr(d); renderPlans(); });
  $("#planMonthPick")?.addEventListener("change", renderPlans);
  $("#planScope")?.addEventListener("change", renderPlans);
  $("#tagFilter")?.addEventListener("input", renderPlans);
  $("#toggleChat")?.addEventListener("click", () => $("#chatBox").classList.toggle("hidden"));
  const chatInput = $("#chatInput");
  if (chatInput) chatInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      const txt = e.target.value.trim(); if (!txt) return;
      const mon = $("#planMonthPick").value;
      await getMonthChatCollectionRef(teamId, mon).add({ mem: memberId, txt, ts: Date.now() });
      e.target.value = "";
    }
  });
}
async function renderPlans() {
  populatePlanScopeSelect();
  const editableHere = isEditableHere(teamId, memberId, viewingMemberId);
  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
  if (unsubscribePlans) unsubscribePlans();
  const mon = $("#planMonthPick")?.value || getMonthStr(new Date());
  if ($("#planMonthPick") && !$("#planMonthPick").value) $("#planMonthPick").value = mon;

  const box = $("#planList");
  if (!box) return;
  box.innerHTML = "";

  const [yy, mm] = mon.split("-").map(Number);
  const daysInMonth = endOfMonth(new Date(yy, mm - 1, 1)).getDate();
  const unsubs = [];
  unsubscribePlans = () => { unsubs.forEach(fn => { try { fn && fn(); } catch(_){} }); };

  const classMap = { ジョグ: "jog", ポイント: "point", 補強: "sup", オフ: "off", その他: "other" };

  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(yy, mm - 1, d);
    const dayKey = ymd(dt);
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="dow">${["SU","MO","TU","WE","TH","FR","SA"][dt.getDay()]}<br>${d}</div>
      <div class="txt" id="pl_${dayKey}" style="flex-wrap: wrap; flex-direction: row; align-items: center;">—</div>
    `;
    if (editableHere) row.addEventListener("click", () => openPlanModal(dt));
    box.appendChild(row);

    const unsub = getPlansCollectionRef(srcTeam)
      .doc(dayKey)
      .collection('events')
      .orderBy('mem')
      .onSnapshot(snapshot => {
        const scope = $("#planScope")?.value || "all";
        const tagText = $("#tagFilter")?.value.trim() || "";
        const tagSet = new Set(tagText ? tagText.split(",").map(s => s.trim()).filter(Boolean) : []);

        const arr = [];
        snapshot.docs.forEach(doc => {
          const it = doc.data();
          if (scope === "team" && it.scope !== "team") return;
          if (scope !== "all" && scope !== "team" && it.mem !== scope) return;
          if (tagSet.size && !(it.tags || []).some(t => tagSet.has(t))) return;
          arr.push(it);
        });

        const targetEl = document.getElementById("pl_" + dayKey);
        if (!targetEl) return;

        if (arr.length) {
          targetEl.innerHTML = arr.map(x =>
            `<span style="display:inline-flex; align-items:center; gap:6px; margin: 2px 8px 2px 0;">
               <span class="cat-tag ${classMap[x.type] || ""}">${x.type}</span>
               <span>${x.content}</span>
             </span>`
          ).join("");
        } else {
          targetEl.textContent = "—";
        }
      }, (err) => {
        const targetEl = document.getElementById("pl_" + dayKey);
        if (targetEl) targetEl.textContent = "—";
        console.error("plans onSnapshot error:", err);
      });

    unsubs.push(unsub);
  }

  renderChat();
}
function renderChat() {
  if (unsubscribeMonthChat) unsubscribeMonthChat();
  const mon = $("#planMonthPick").value;
  unsubscribeMonthChat = getMonthChatCollectionRef(teamId, mon).orderBy('ts').onSnapshot(snapshot => {
    const box = $("#chatLog"); if(!box) return;
    box.innerHTML = "";
    snapshot.docs.forEach(doc => {
      const m = doc.data();
      const div = document.createElement("div"); div.className = "msg";
      const time = new Date(m.ts).toLocaleString("ja-JP");
      div.innerHTML = `<span class="name">${m.mem}</span><span class="txt">${m.txt}</span><span class="muted">  ${time}</span>`;
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
  });
}
let modalDiv = null;
function openPlanModal(dt) {
  closePlanModal();
  const mon = getMonthStr(dt);
  const dayKey = ymd(dt);
  let editingId = null;

  modalDiv = document.createElement("div");
  modalDiv.style.cssText = "position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:100;";
  modalDiv.innerHTML = `<div style="background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;max-width:520px;margin:10vh auto;">
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

  const pActionBtn = $("#p_action", modalDiv), pDeleteBtn = $("#p_delete", modalDiv);
  const pType = $("#ptype", modalDiv), pScope = $("#pscope", modalDiv), pTags = $("#ptags", modalDiv), pContent = $("#pcontent", modalDiv);
  const resetForm = () => {
    editingId = null;
    pType.value = "ジョグ"; pScope.value = "self"; pTags.value = ""; pContent.value = "";
    pActionBtn.textContent = "追加"; pDeleteBtn.style.display = "none";
    $$("#plist .row", modalDiv).forEach(r => r.style.outline = 'none');
  };
  const editItem = (id, targetRow) => {
    const planDocRef = getPlansCollectionRef(teamId).doc(dayKey).collection('events').doc(id);
    planDocRef.get().then(doc => {
      const item = doc.data();
      if (!item || item.mem !== memberId) return;
      editingId = id;
      pType.value = item.type; pScope.value = item.scope; pTags.value = (item.tags || []).join(","); pContent.value = item.content;
      pActionBtn.textContent = "更新"; pDeleteBtn.style.display = "block";
      $$("#plist .row", modalDiv).forEach(r => r.style.outline = 'none');
      targetRow.style.outline = `2px solid var(--primary)`;
    });
  };
  renderPlanListInModal(mon, dayKey, editItem);
  $("#p_close", modalDiv).addEventListener("click", closePlanModal);
  $("#p_new", modalDiv).addEventListener("click", resetForm);
  pDeleteBtn.addEventListener("click", async () => {
    if (!editingId || !confirm("この予定を削除しますか？")) return;
    await getPlansCollectionRef(teamId).doc(dayKey).collection('events').doc(editingId).delete();
    resetForm();
  });
  pActionBtn.addEventListener("click", async () => {
    const content = pContent.value.trim(); if (!content) return;
    const planData = {
      type: pType.value,
      scope: pScope.value,
      content,
      mem: memberId,
      tags: (pTags.value || "").split(",").map(s => s.trim()).filter(Boolean),
      month: mon,
      day: dayKey,
      team: teamId
    };
    if (editingId) {
      await getPlansCollectionRef(teamId).doc(dayKey).collection('events').doc(editingId).set(planData);
    } else {
      await getPlansCollectionRef(teamId).doc(dayKey).collection('events').add(planData);
    }
    resetForm();
  });
}
function renderPlanListInModal(mon, dayKey, editCallback) {
  const cont = $("#plist", modalDiv); cont.innerHTML = '';
  getPlansCollectionRef(teamId).doc(dayKey).collection('events').orderBy('mem').get().then(snapshot => {
    if (snapshot.empty) { cont.innerHTML = '<div class="muted" style="text-align:center;">予定はありません</div>'; return; }
    snapshot.docs.forEach((doc, i) => {
      const x = doc.data();
      const isMyPlan = x.mem === memberId;
      const row = document.createElement("div"); row.className = "row";
      let ownerText = x.scope === 'team' ? ' (全員)' : ` (${x.mem})`;
      if (isMyPlan) {
        row.style.cursor = "pointer";
        row.addEventListener("click", () => editCallback(doc.id, row));
      }
      row.innerHTML = `<div class="dow">${i + 1}</div>
        <div class="txt" style="flex-direction:row; gap:8px; align-items:center;">
          ${createPlanTagHtml(x.type)}
          <span>${x.content}<span class="muted">${ownerText}</span></span>
        </div>`;
      cont.appendChild(row);
    });
  });
}
function closePlanModal() { if (modalDiv) { modalDiv.remove(); modalDiv = null; } }

// 予定本文取り込み（読みは表示元チーム）
async function collectPlansTextForDay(day, scopeSel) {
  const srcTeam = await getViewSourceTeamId(teamId, viewingMemberId);
  const dayKey = ymd(day);
  const plansRef = getPlansCollectionRef(srcTeam).doc(dayKey).collection('events');
  let query = plansRef;
  if (scopeSel === memberId) query = query.where('mem', '==', memberId);
  if (scopeSel === 'team') query = query.where('scope', '==', 'team');
  const snapshot = await query.get();
  const list = [];
  snapshot.docs.forEach(doc => {
    const it = doc.data();
    if (scopeSel === "auto") {
      if (it.mem === memberId) list.push(`[${memberId}] ${it.type} ${it.content}`);
      else if (it.scope === "team") list.push(`[全員] ${it.type} ${it.content}`);
    } else {
      list.push(`${it.type} ${it.content}`);
    }
  });
  return list.join("\n");
}
async function collectPlansTypesForDay(day, scopeSel) {
  const dayKey = ymd(day);
  const plansRef = getPlansCollectionRef(teamId).doc(dayKey).collection('events');
  let query = plansRef;
  if (scopeSel === memberId) query = query.where('mem', '==', memberId);
  if (scopeSel === 'team')   query = query.where('scope', '==', 'team');
  const snapshot = await query.get();
  const types = [];
  snapshot.docs.forEach(doc => {
    const t = doc.data().type;
    if (t && !types.includes(t)) types.push(t);
  });
  return types;
}

// ===== Dashboard =====
function initDashboard() {
  const toggleBtn = $("#distChartToggle");
  const prevBtn = $("#distChartPrev");
  const nextBtn = $("#distChartNext");
  if (toggleBtn) toggleBtn.addEventListener('click', () => {
    dashboardMode = (dashboardMode === 'month') ? 'week'
                   : (dashboardMode === 'week') ? 'day'
                   : 'month';
    dashboardOffset = 0;
    renderDashboard();
  });
  if (prevBtn) prevBtn.addEventListener('click', () => { dashboardOffset--; renderDashboard(); });
  if (nextBtn) nextBtn.addEventListener('click', () => { dashboardOffset++; renderDashboard(); });

  const condPrevBtn = $("#condChartPrev");
  const condNextBtn = $("#condChartNext");
  if (condPrevBtn) condPrevBtn.addEventListener('click', () => { conditionChartOffset -= 7; renderConditionChart(); });
  if (condNextBtn) condNextBtn.addEventListener('click', () => { conditionChartOffset += 7; renderConditionChart(); });
}
function renderDashboard() { renderDistanceChart(); renderConditionChart(); }
async function renderDistanceChart() {
  const cvs = document.getElementById('distanceChart'); if (!cvs) return;
  const ctx = cvs.getContext('2d');
  const toggleBtn = $("#distChartToggle");
  if (toggleBtn) toggleBtn.textContent = (dashboardMode === 'month') ? '週に切替' : (dashboardMode === 'week') ? '日に切替' : '月に切替';

  const labels = [];
  const chartData = [];
  const journalSnaps = await db.collection('teams').doc(teamId).collection('members').doc(viewingMemberId).collection('journal').get();
  const journal = {}; journalSnaps.forEach(doc => journal[doc.id] = doc.data());

  if (dashboardMode === 'month') {
    $("#distChartTitle").textContent = "月間走行距離グラフ";
    const monthlyTotals = {};
    for (const ymdStr in journal) {
      const monthStr = ymdStr.substring(0, 7);
      monthlyTotals[monthStr] = (monthlyTotals[monthStr] || 0) + Number(journal[ymdStr].dist || 0);
    }
    const targetMonth = new Date(); targetMonth.setMonth(targetMonth.getMonth() + dashboardOffset);
    for (let i = 5; i >= 0; i--) {
      const d = new Date(targetMonth); d.setMonth(d.getMonth() - i);
      const month = getMonthStr(d);
      labels.push(month);
      chartData.push(Number(monthlyTotals[month] || 0).toFixed(1));
    }
  } else if (dashboardMode === 'week') {
    $("#distChartTitle").textContent = "週間走行距離グラフ";
    const today = new Date();
    const currentWeekStart = startOfWeek(today);
    const targetWeekStart = addDays(currentWeekStart, dashboardOffset * 7);
    for (let i = 5; i >= 0; i--) {
      const weekStart = addDays(targetWeekStart, -i * 7);
      labels.push(`${ymd(weekStart).slice(5)}~`);
      let weeklyTotal = 0;
      for (let j = 0; j < 7; j++) {
        const day = addDays(weekStart, j);
        const dayData = journal[ymd(day)];
        if (dayData) weeklyTotal += Number(dayData.dist || 0);
      }
      chartData.push(weeklyTotal.toFixed(1));
    }
  } else {
    $("#distChartTitle").textContent = "日別走行距離グラフ";
    const windowLen = 14;
    const today = new Date();
    const end = addDays(today, dashboardOffset * windowLen);
    const start = addDays(end, -windowLen + 1);
    for (let i = 0; i < windowLen; i++) {
      const d = addDays(start, i);
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
      const dayData = journal[ymd(d)];
      chartData.push(Number(dayData?.dist || 0).toFixed(1));
    }
  }

  if (distanceChart) distanceChart.destroy();
  distanceChart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: '走行距離 (km)', data: chartData, backgroundColor: 'rgba(79, 70, 229, 0.5)', borderColor: 'rgba(79, 70, 229, 1)', borderWidth: 1 }] },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
  });

  renderDashboardInsight();
}
async function renderConditionChart() {
  const ctx = $('#conditionChart')?.getContext('2d'); if (!ctx) return;
  const labels = [];
  const chartData = [];
  const journalSnaps = await db.collection('teams').doc(teamId).collection('members').doc(viewingMemberId).collection('journal').get();
  const journal = {}; journalSnaps.forEach(doc => journal[doc.id] = doc.data());
  const today = new Date();
  const endDate = addDays(today, conditionChartOffset);

  for (let i = 13; i >= 0; i--) {
    const day = addDays(endDate, -i);
    labels.push(`${day.getMonth()+1}/${day.getDate()}`);
    const dayData = journal[ymd(day)];
    chartData.push(dayData?.condition || null);
  }
  const rangeStart = addDays(endDate, -13);
  $("#condChartRange").textContent = `${ymd(rangeStart)} ~ ${ymd(endDate)}`;

  if (conditionChart) conditionChart.destroy();
  conditionChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ label: 'コンディション (1-5)', data: chartData, borderColor: 'rgba(22, 163, 74, 1)', tension: 0.1, spanGaps: true }] },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, max: 5, ticks: { stepSize: 1 } } } }
  });
}

// ===== NEW: Team Memo =====
function initMemo() {
  const memoInput = $("#memoChatInput");
  const sendBtn = $("#memoSendBtn");
  const sendMessage = async () => {
    const txt = memoInput.value.trim();
    if (!txt) return;
    await getTeamMemoCollectionRef(teamId).add({ mem: memberId, txt, ts: Date.now() });
    memoInput.value = "";
  }
  if (memoInput) memoInput.addEventListener('keydown', (e) => { if (e.key === "Enter") sendMessage(); });
  if (sendBtn) sendBtn.onclick = sendMessage;
}

async function checkNewMemo() {
  const lastView = Number(localStorage.getItem(memoLastViewKey()) || 0);
  const snapshot = await getTeamMemoCollectionRef(teamId).orderBy('ts', 'desc').limit(1).get();
  const memoTab = document.querySelector('[data-tab="memo"]');
  if (!snapshot.empty) {
    const lastMessage = snapshot.docs[0].data();
    if (memoTab && lastMessage.ts > lastView) memoTab.classList.add('new-message');
    else if (memoTab) memoTab.classList.remove('new-message');
  }
}

// ===== Boot and Login =====
window.addEventListener("hashchange", () => { closePlanModal(); });
(async function boot() {
  try {
    const last = JSON.parse(localStorage.getItem("athlog:last") || "{}");
    if(last.team && last.member){
      teamId = last.team;
      memberId = last.member;
      viewingMemberId = last.member;
      await getMembersRef(teamId).doc(memberId).set({ name: memberId }, { merge: true });
      await showApp();
      selDate = new Date();
      const dp = document.getElementById("datePicker");
      if (dp) dp.value = ymd(selDate);
      renderJournal();
    }
  } catch (e) {
    console.error("Failed to auto-login from saved session:", e);
    localStorage.removeItem("athlog:last");
  }
})();
async function doLogin() {
  teamId = $("#teamId").value.trim();
  memberId = $("#memberName").value.trim();
  viewingMemberId = memberId;
  if (!teamId || !memberId) { alert("Team / Member を入力"); return; }
  localStorage.setItem("athlog:last", JSON.stringify({ team: teamId, member: memberId }));
  upsertProfile(teamId, memberId);
  if (!getMainTeamOf(memberId)) setMainTeamOf(memberId, teamId);
  await getMembersRef(teamId).doc(memberId).set({ name: memberId }, { merge: true });
  const lg = $("#login"); if (lg) { lg.classList.add("hidden"); lg.style.display = "none"; }
  const app = $("#app"); if (app) { app.classList.remove("hidden"); }
  try {
    await showApp();
    selDate = new Date();
    const dp = document.getElementById("datePicker");
    if (dp) dp.value = ymd(selDate);
    renderJournal();
  } catch (e) {
    console.error("Error during app initialization:", e);
    alert("アプリの起動中にエラーが発生しました。HTMLファイルが最新でない可能性があります。");
  }
}
async function populateMemberSelect() {
  const select = $("#memberSelect");
  if (!select) return;
  select.innerHTML = '';
  const snapshot = await getMembersRef(teamId).get();
  snapshot.docs.forEach(doc => {
    const mem = doc.id;
    const option = document.createElement('option');
    option.value = mem;
    option.textContent = mem;
    select.appendChild(option);
  });
  const want = viewingMemberId || memberId;
  const exists = [...select.options].some(o => o.value === want);
  select.value = exists ? want : memberId;
  viewingMemberId = select.value; 
}
document.addEventListener("DOMContentLoaded", () => {
  const btn = $("#loginBtn");
  if (btn) { btn.onclick = doLogin; }
  const t = $("#teamId"), m = $("#memberName");
  if (t && m) [t, m].forEach(inp => inp.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); }));

  const helpBody = document.getElementById("helpBody");
  if (helpBody) {
    helpBody.innerHTML = `
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

  document.getElementById("openHelpBtn")?.addEventListener("click", () => {
    document.getElementById("helpOverlay")?.classList.remove("hidden");
  });
  document.getElementById("helpClose")?.addEventListener("click", () => {
    document.getElementById("helpOverlay")?.classList.add("hidden");
  });
  document.getElementById("helpOverlay")?.addEventListener("click", (e) => {
    if (e.target.id === "helpOverlay") e.currentTarget.classList.add("hidden");
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.getElementById("helpOverlay")?.classList.add("hidden");
  });
});

function renderDashboardInsight() {}

// 最後：SVGクリック塗りを有効化（安全側の再呼び出し）
initRegionMap();


// ===== Muscle-map style fill (overlay/barrier) =====
const MM = {
  IMG_SRC: 'human.webp.png',                 // 下地
  LEVELS: {                                  // レベル別 RGBA（muscle-map と同系色）
    1: [199,210,254,210], // 青系
    2: [253,186,116,210], // 橙系
    3: [239, 68, 68,210], // 赤系
  },
  TOL: 22,                                    // エッジに滲みにくくする余裕（今回は barrier 優先なので小さめでOK）
};

let mm = { base:null, overlay:null, barrier:null, bctx:null, octx:null, wctx:null };

function initMuscleMap(){
  mm.base = document.getElementById('mmBase');
  mm.overlay = document.getElementById('mmOverlay');
  mm.barrier = document.getElementById('mmBarrier');
  if(!mm.base || !mm.overlay || !mm.barrier) return;

  mm.bctx = mm.base.getContext('2d');
  mm.octx = mm.overlay.getContext('2d', { willReadFrequently:true });
  mm.wctx = mm.barrier.getContext('2d');

  // 下地画像読み込み（サイズ基準）
  const img = new Image();
  img.onload = () => {
    [mm.base, mm.overlay, mm.barrier].forEach(c => { c.width = img.naturalWidth; c.height = img.naturalHeight; });
    mm.bctx.drawImage(img, 0, 0);
    toGray(mm.bctx, mm.base.width, mm.base.height); // 下地は見えないが解析用にグレイ化（任意）

    // その日のデータを反映
    drawMuscleFromDoc(lastJournal);
  };
  img.src = MM.IMG_SRC;

  // 塗りタップ
  mm.overlay.addEventListener('pointerdown', (e) => {
    if (!isEditableHere(teamId, memberId, viewingMemberId)) return;

    const p = mmPixPos(mm.overlay, e);
    if (brush.erase) {
      floodErase(mm.octx, mm.wctx, p.x, p.y);
    } else {
      const col = MM.LEVELS[brush.lvl || 1];
      floodFill(mm.octx, mm.wctx, p.x, p.y, MM.TOL, col);
    }
    // 変更はドキュメントへ即時反映（軽量化したければ保存時にまとめてでもOK）
    saveMuscleLayerToDoc();
  });

  // 画面サイズ変化で再描画（他日へ移動時は onSnapshot で毎回 draw）
  window.addEventListener('resize', () => drawMuscleFromDoc(lastJournal));
}

// キャンバス座標に変換
function mmPixPos(canvas, e){
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.floor((e.clientX - r.left) * (canvas.width  / r.width)),
    y: Math.floor((e.clientY - r.top)  * (canvas.height / r.height))
  };
}

// 下地をグレイスケール化（任意）
function toGray(ctx,w,h){
  const img = ctx.getImageData(0,0,w,h);
  const d = img.data;
  for(let i=0;i<d.length;i+=4){
    const g = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
    d[i]=d[i+1]=d[i+2]=g;
  }
  ctx.putImageData(img,0,0);
}

// ---- flood fill（barrierで停止） ----
function floodFill(octx, wctx, sx, sy, tol, rgba){
  const w = octx.canvas.width, h = octx.canvas.height;
  const o = octx.getImageData(0,0,w,h); const od = o.data;
  const b = wctx.getImageData(0,0,w,h); const bd = b.data;

  const A_STOP = 10; // これ以上のアルファは“塗られている/バリアあり”
  const stack = [ (sy<<16) | sx ];
  const seen = new Uint8Array(w*h);

  const within = (x,y) => x>=0 && y>=0 && x<w && y<h;
  const idx = (x,y) => ((y*w+x)<<2);

  while(stack.length){
    const p = stack.pop();
    const x =  p & 0xffff;
    const y =  p >>> 16;
    if(!within(x,y)) continue;
    const si = y*w + x;
    if (seen[si]) continue; seen[si]=1;

    const i = idx(x,y);
    if (bd[i+3] > A_STOP) continue;   // barrier の線にぶつかった
    if (od[i+3] > A_STOP) continue;   // 既に塗られている領域は越えない

    // 着色
    od[i]   = rgba[0];
    od[i+1] = rgba[1];
    od[i+2] = rgba[2];
    od[i+3] = rgba[3];

    stack.push((y<<16)|(x-1));
    stack.push((y<<16)|(x+1));
    stack.push(((y-1)<<16)|x);
    stack.push(((y+1)<<16)|x);
  }
  octx.putImageData(o,0,0);
}

// 同系色の“つながり”を消す（start を含む着色領域を透明化）
function floodErase(octx, wctx, sx, sy){
  const w = octx.canvas.width, h = octx.canvas.height;
  const o = octx.getImageData(0,0,w,h); const od = o.data;
  const b = wctx.getImageData(0,0,w,h); const bd = b.data;

  const A_STOP = 10;
  const stack = [ (sy<<16) | sx ];
  const seen = new Uint8Array(w*h);

  const within = (x,y) => x>=0 && y>=0 && x<w && y<h;
  const idx = (x,y) => ((y*w+x)<<2);

  // 始点が透明なら何もしない
  if (od[idx(sx,sy)+3] <= A_STOP) return;

  while(stack.length){
    const p = stack.pop();
    const x =  p & 0xffff;
    const y =  p >>> 16;
    if(!within(x,y)) continue;
    const si = y*w + x;
    if (seen[si]) continue; seen[si]=1;

    const i = idx(x,y);
    if (bd[i+3] > A_STOP) continue; // barrier は越えない
    if (od[i+3] <= A_STOP) continue; // 透明は広げない

    // 透明化
    od[i]=od[i+1]=od[i+2]=0; od[i+3]=0;

    stack.push((y<<16)|(x-1));
    stack.push((y<<16)|(x+1));
    stack.push(((y-1)<<16)|x);
    stack.push(((y+1)<<16)|x);
  }
  octx.putImageData(o,0,0);
}

// Firestore ⇄ キャンバス
function drawDataURL(ctx, url){ return new Promise(res=>{ if(!url) return res(); const im=new Image(); im.onload=()=>{ ctx.drawImage(im,0,0); res(); }; im.src=url; }); }
async function drawMuscleFromDoc(j){
  if(!mm.octx || !mm.wctx) return;
  mm.octx.clearRect(0,0,mm.octx.canvas.width, mm.octx.canvas.height);
  mm.wctx.clearRect(0,0,mm.wctx.canvas.width, mm.wctx.canvas.height);
  if (j?.mmOverlayWebp) await drawDataURL(mm.octx, j.mmOverlayWebp);
  if (j?.mmBarrierPng)  await drawDataURL(mm.wctx,  j.mmBarrierPng);
}

// 保存（ドキュメントサイズが心配なら Storage に置き換え検討）
async function saveMuscleLayerToDoc(){
  const docRef = getJournalRef(teamId, memberId, selDate);
  const overlayWebp = mm?.octx ? mm.octx.canvas.toDataURL('image/webp', 0.65) : null;
  const barrierPng  = mm?.wctx ? mm.wctx.canvas.toDataURL('image/png')        : null;
  const stats = analyzeOverlay(mm.octx); // AI用の簡易スコア
  await docRef.set({ mmOverlayWebp: overlayWebp, mmBarrierPng: barrierPng, mmStats: stats }, { merge:true });
}

// 着色量の概算（AI疲労スコア用）
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

