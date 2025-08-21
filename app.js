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

// === 追加：正規化/復元のユーティリティ ===
function clientToNorm(e, el) {
  const rect = el.getBoundingClientRect();
  const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  const cy = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
  return { nx: cx / rect.width, ny: cy / rect.height };
}
function ptToPx(pt, cw, ch) {
  // 新データ（正規化）: {nx,ny} / 旧データ: {x,y}
  if (pt && typeof pt.nx === 'number') return { x: pt.nx * cw, y: pt.ny * ch };
  return { x: pt.x, y: pt.y };
}
// 線分と点の距離（px）
function distPointToSegPx(P, A, B) {
  const vx = B.x - A.x, vy = B.y - A.y;
  const wx = P.x - A.x, wy = P.y - A.y;
  const c1 = vx * wx + vy * wy;
  const c2 = vx * vx + vy * vy;
  let t = c2 ? (c1 / c2) : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = A.x + t * vx - P.x;
  const dy = A.y + t * vy - P.y;
  return Math.hypot(dx, dy);
}
// タップ地点に当たるストロークを末尾側から1本だけ探す
function findHitStrokeIndex(paint, Ppx, cw, ch, thresholdPx = 14) {
  for (let i = paint.length - 1; i >= 0; i--) {
    const s = paint[i];
    if (!s || !Array.isArray(s.pts) || s.pts.length < 2) continue;
    for (let k = 0; k < s.pts.length - 1; k++) {
      const A = ptToPx(s.pts[k], cw, ch);
      const B = ptToPx(s.pts[k + 1], cw, ch);
      if (distPointToSegPx(Ppx, A, B) <= thresholdPx) return i;
    }
  }
  return -1;
}


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
    for(const dt of dates) {
        const doc = await getJournalRef(teamId, viewingMemberId, dt).get();
        if (doc.exists) {
            s += Number(doc.data().dist || 0);
        }
    }
    return s;
}

async function weekAIComment(d) {
    const wkm = await sumWeekKm(d);
    const dates = getWeekDates(d);
    let fatigueScore = 0; 
    
    for(const dt of dates) {
        const doc = await getJournalRef(teamId, viewingMemberId, dt).get();
        if (!doc.exists) continue;
        const j = doc.data();
        if (!j || !j.paint) continue;
        j.paint.forEach(stroke => {
            if (stroke.erase) return;
            fatigueScore += (stroke.lvl || 1);
        });
    }

    let distMsg = wkm > 80 ? "走行距離が多く、ハイボリュームな週でした。" : wkm > 50 ? "良いペースで走行距離を積めています。" : "走行距離は控えめでした。";
    let fatigueMsg = "";
    if (fatigueScore > 40) fatigueMsg = "また、強い筋肉疲労が蓄積しているようです。回復を最優先に考えましょう。";
    else if (fatigueScore > 20) fatigueMsg = "筋肉の疲労感も見られるため、ストレッチなどのケアを意識すると良いでしょう。";
    else if (wkm > 10) fatigueMsg = "身体のコンディションは良好のようです。";
    
    return `【週分析AI】総距離は${wkm.toFixed(1)}km。${distMsg} ${fatigueMsg}`;
}

// ---- Team Memo paging state ----
let memoPageSize = 30;        // 1ページ(表示初期/追加読込)の件数
let memoOldestDoc = null;     // いま表示している中で最古のドキュメント
let memoLatestTs = 0;         // いま表示している中で最新のタイムスタンプ
let memoLiveUnsub = null;     // 最新1件のライブ購読解除用
let memoLoadingOlder = false; // 追加読込中フラグ


// ===== App State =====
let teamId = null, memberId = null, viewingMemberId = null;
let selDate = new Date();
let brush = { lvl: 1, erase: false };
let painting = false, strokes = [];
let canvas, ctx, imgEl;
let distanceChart = null, conditionChart = null;
let dashboardOffset = 0, dashboardMode = 'month';
let conditionChartOffset = 0;
let unsubscribePlans, unsubscribeMemo, unsubscribeMonthChat, unsubscribeJournal;
// 入力中フラグ（未保存の上書き防止）
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
        // 月ピッカー初期化（空なら現在月を入れる）
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
}

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
    if (id === "memo") renderMemo();
}

// ===== Login & Logout =====
$("#logoutBtn")?.addEventListener("click", () => {
    localStorage.removeItem("athlog:last");
    teamId = null; memberId = null; viewingMemberId = null;
    window.location.reload();
});

$$(".tab").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));

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
      // 保存完了 → 未保存フラグを下ろす
    dirty = { dist: false, train: false, feel: false };
    renderWeek();

}

function initJournal() {
    imgEl = $("#humanImg");
    canvas = $("#paint");
    const fit = () => {
        if (!canvas || !imgEl) return;
        canvas.width = imgEl.clientWidth; canvas.height = imgEl.clientHeight;
        ctx = canvas.getContext("2d"); renderPaint();
    };

    // 追加：タップ地点のストロークを1本削除
async function eraseStrokeAtEvent(e) {
  if (!canvas) return;
  const { nx, ny } = clientToNorm(e, canvas);
  const Ppx = { x: nx * canvas.width, y: ny * canvas.height };
  const docRef = getJournalRef(teamId, memberId, selDate);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const base = snap.data() || {};
    const paint = Array.isArray(base.paint) ? [...base.paint] : [];
    const idx = findHitStrokeIndex(paint, Ppx, canvas.width, canvas.height, 14);
    if (idx >= 0) {
      paint.splice(idx, 1);
      tx.set(docRef, { paint }, { merge: true });
    }
  });
}

    
    if (imgEl && $(".canvas-wrap")) new ResizeObserver(fit).observe($(".canvas-wrap"));
    fit();  // 入力したら未保存フラグON（1回だけ登録）
    $("#distInput")?.addEventListener("input", () => { dirty.dist  = true; });
    $("#trainInput")?.addEventListener("input", () => { dirty.train = true; });
    $("#feelInput")?.addEventListener("input", () => { dirty.feel  = true; });


    

    const brushBtns = $$('.palette .lvl, .palette #eraser');
    brushBtns.forEach(b => b.addEventListener('click', () => {
        brush.lvl = Number(b.dataset.lvl) || 1; brush.erase = b.id === 'eraser';
        brushBtns.forEach(btn => btn.classList.remove('active'));
        b.classList.add('active');
    }));
    if (brushBtns.length) $('.palette .lvl[data-lvl="1"]')?.classList.add('active');

    $("#undoBtn")?.addEventListener("click", async () => { 
        const docRef = getJournalRef(teamId, memberId, selDate);
        await db.runTransaction(async (transaction) => {
            const doc = await transaction.get(docRef);
            if (!doc.exists) return;
            const j = doc.data();
            j.paint = j.paint || [];
            j.paint.pop();
            transaction.update(docRef, { paint: j.paint });
        });
    });
    $("#copyPrev")?.addEventListener("click", async () => {
        const prev = addDays(selDate, -1);
        const prevDoc = await getJournalRef(teamId, memberId, prev).get();
        const pj = prevDoc.data();
        if (pj && pj.paint) {
            await getJournalRef(teamId, memberId, selDate).set({ paint: pj.paint }, { merge: true });
        }
    });

    let rafId = null;
    const pos = (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
        const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
        return { x, y };
    };
    const start = (e) => {
        painting = true; const p = pos(e);
        strokes.push({ lvl: brush.lvl, erase: brush.erase, pts: [p] });
        drawLive(); e.preventDefault();
    };
    const move = (e) => {
        if (!painting) return;
        const p = pos(e); const s = strokes[strokes.length - 1];
        if (s) s.pts.push(p);
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(drawLive);
        e.preventDefault();
    };
    const end = async () => {
        if (!painting) return;
        painting = false; if (rafId) cancelAnimationFrame(rafId); rafId = null;
        const currentStroke = strokes.pop();
        if (currentStroke && currentStroke.pts.length > 1) {
            await getJournalRef(teamId, memberId, selDate).set({ 
                paint: firebase.firestore.FieldValue.arrayUnion(currentStroke) 
            }, { merge: true });
        }
    };
    if (canvas) {
        canvas.addEventListener("mousedown", start);
        canvas.addEventListener("mousemove", move);
        window.addEventListener("mouseup", end);
        canvas.addEventListener("touchstart", start, { passive: false });
        canvas.addEventListener("touchmove", move, { passive: false });
        window.addEventListener("touchend", end);
    }
// --- Quick ボタン（ジョグ/ポイント/補強/オフ/その他）
$$(".qbtn").forEach(b => b.addEventListener("click", async () => {
  const docRef = getJournalRef(teamId, memberId, selDate);

  // 下書き保存 + タグ更新を 1 回のトランザクションでまとめる
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const base = snap.data() || {};
    const curr = Array.isArray(base.tags) ? [...base.tags] : [];

    const tag = b.textContent.trim();
    const idx = curr.indexOf(tag);
    if (idx >= 0) {
      curr.splice(idx, 1);                    // トグルOFF
    } else {
      if (curr.length >= 2) curr.shift();     // 最大2件
      curr.push(tag);                         // トグルON
    }

    const activeCondBtn = $('#conditionBtns button.active');
    tx.set(docRef, {
      dist: Number($("#distInput").value || 0),
      train: $("#trainInput").value,
      feel:  $("#feelInput").value,
      condition: activeCondBtn ? Number(activeCondBtn.dataset.val) : null,
      tags: curr
    }, { merge: true });
  });

  // 保存できたので dirty をリセット
  dirty = { dist: false, train: false, feel: false };
}));

    $("#weekPrev")?.addEventListener("click", () => { selDate = addDays(selDate, -7); renderJournal(); });
    $("#weekNext")?.addEventListener("click", () => { selDate = addDays(selDate, 7); renderJournal(); });
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
}

async function renderJournal() {
    if (unsubscribeJournal) unsubscribeJournal();

    if (!viewingMemberId) viewingMemberId = memberId;

    dirty = { dist:false, train:false, feel:false };

    const isReadOnly = viewingMemberId !== memberId;
    $$('#journal input, #journal textarea, #journal .qbtn, #saveBtn, #mergeBtn, #conditionBtns button, .palette button').forEach(el => {
        const isNavControl = ['weekPrev', 'weekNext', 'gotoToday', 'datePicker'].includes(el.id);
        if (!isNavControl) el.disabled = isReadOnly;
    });
    if ($('#paint')) $('#paint').style.pointerEvents = isReadOnly ? 'none' : 'auto';
    
    const mergeScopeSelect = $("#mergeScope");
    if (mergeScopeSelect) {
        mergeScopeSelect.innerHTML = `<option value="auto">予定から追加(自動)</option><option value="${memberId}">${memberId}の予定</option><option value="team">全員の予定</option>`;
    }

    $("#datePicker").value = ymd(selDate);
    renderWeek();

    unsubscribeJournal = getJournalRef(teamId, viewingMemberId, selDate).onSnapshot(doc => {
        const j = doc.data() || { dist: 0, train: "", feel: "", tags: [], paint: [], condition: null };
        if (!dirty.dist)  { $("#distInput").value  = j.dist ?? ""; }
        if (!dirty.train) { $("#trainInput").value = j.train ?? ""; }
        if (!dirty.feel)  { $("#feelInput").value  = j.feel ?? ""; }

        
        $$('#conditionBtns button').forEach(b => b.classList.remove('active'));
        if (j.condition) $(`#conditionBtns button[data-val="${j.condition}"]`)?.classList.add('active');
        
        renderPaint(j); 
        renderQuickButtons(j);
        weekAIComment(selDate).then(comment => $("#aiBox").textContent = comment);
    });
}

function renderPaint(j) {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const allStrokes = (j?.paint || []).concat(strokes);
    const drawStroke = (s) => {
        if (!s || s.pts.length < 1) return;
        const col = s.erase ? "rgba(0,0,0,1)" : (s.lvl == 1 ? "rgba(245, 158, 11,0.6)" : s.lvl == 2 ? "rgba(239, 68, 68,0.6)" : "rgba(217, 70, 239,0.6)");
        ctx.lineWidth = 18; ctx.lineCap = "round";
        ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
        ctx.strokeStyle = col;
        ctx.beginPath(); ctx.moveTo(s.pts[0].x, s.pts[0].y);
        for (let i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i].x, s.pts[i].y);
        ctx.stroke();
    };
    allStrokes.forEach(drawStroke);
    ctx.globalCompositeOperation = "source-over";
}

function drawLive() { renderPaint(); }

async function renderWeek() {
    const chips = $("#weekChips"); if (!chips) return;
    chips.innerHTML = "";
    const days = getWeekDates(selDate);
    for (const d of days) {
        const key = ymd(d);
        const doc = await getJournalRef(teamId, viewingMemberId, d).get();
        const j = doc.data() || {};
        const btn = document.createElement("button");
        btn.className = "chip" + (ymd(selDate) === key ? " active" : "");
        const tags = j.tags || [];
        btn.innerHTML = `<div>${["日", "月", "火", "水", "木", "金", "土"][d.getDay()]} ${d.getDate()}</div><div class="km">${(j.dist || 0)}km</div>`;
        btn.style.background = ''; btn.style.color = '';
        if (tags.length) {
            const map = { ジョグ: "var(--q-jog)", ポイント: "var(--q-point)", 補強: "var(--q-sup)", オフ: "var(--q-off)", その他: "var(--q-other)" };
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
  // 編集可否
  const isReadOnly = viewingMemberId !== memberId;
  $("#monthGoalInput").disabled = isReadOnly;
  $("#saveMonthGoalBtn").disabled = isReadOnly;

  // コンテナ
  const box = $("#monthList"); 
  if (!box) return;
  box.innerHTML = "";

  // 月決定（空なら現在月をUIにも反映）
  const mp = $("#monthPick");
  const monStr = (mp && mp.value) ? mp.value : getMonthStr(new Date());
  if (mp && !mp.value) mp.value = monStr;

  const [yy, mm] = monStr.split("-").map(Number);
  const lastDay = endOfMonth(new Date(yy, mm - 1, 1)).getDate();

  // 先に全行を置く（失敗しても表示が残る）
  let sum = 0;
  for (let d = 1; d <= lastDay; d++) {
    const dt  = new Date(yy, mm - 1, d);
    const dow = ["SU","MO","TU","WE","TH","FR","SA"][dt.getDay()];

    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="dow">${dow}<br>${d}</div>
      <div class="txt"><div>—</div></div>
    `;
    row.addEventListener("click", () => { selDate = dt; switchTab("journal"); });
    box.appendChild(row);

    // 非同期でデータを埋める（失敗しても無視）
    (async () => {
      try {
        const snap = await getJournalRef(teamId, viewingMemberId, dt).get();
        const j = snap.data() || {};

        // 合計距離を都度更新
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
        // 取得に失敗しても row は残す（— のまま）
      }
    })();
  }

  // 月間目標の読み込み（安全にラップ）
  try {
    const goalDoc = await getGoalsRef(teamId, viewingMemberId, monStr).get();
    $("#monthGoalInput").value = goalDoc.data()?.goal || "";
  } catch (e) {
    console.error("read goal error:", e);
  }
}


function renderMemoItem(m) {
  const div = document.createElement("div");
  div.className = "msg";
  const time = new Date(m.ts).toLocaleString("ja-JP");
  div.innerHTML = `<span class="name">${m.mem}</span><span class="txt">${m.txt}</span><span class="muted">  ${time}</span>`;
  return div;
}


async function renderMemo() {
  // 既存の購読を解除
  if (unsubscribeMemo) { try { unsubscribeMemo(); } catch(_){} }
  if (memoLiveUnsub) { try { memoLiveUnsub(); } catch(_){} memoLiveUnsub = null; }

  const box = $("#memoChatLog");
  if (!box) return;

  box.innerHTML = "";
  memoOldestDoc = null;
  memoLatestTs = 0;

  const col = getTeamMemoCollectionRef(teamId);

  // 1) 初期は「最新 memoPageSize 件」だけ取得（降順→表示は昇順にして下端へ）
  const initSnap = await col.orderBy('ts', 'desc').limit(memoPageSize).get();
  if (initSnap.empty) {
    box.innerHTML = `<div class="muted">まだメモはありません</div>`;
  } else {
    const docsDesc = initSnap.docs; // desc
    memoOldestDoc = docsDesc[docsDesc.length - 1];          // いちばん古い
    memoLatestTs  = (docsDesc[0].data().ts) || 0;           // いちばん新しい

    // 表示は昇順で並べたいので reverse して append
    docsDesc.slice().reverse().forEach(d => {
      box.appendChild( renderMemoItem(d.data()) );
    });

    // 初期は一番下までスクロール
    box.scrollTop = box.scrollHeight;
  }

  // 2) 上にスクロールしたらさらに過去を読み足し（ページング）
  box.onscroll = async () => {
    if (box.scrollTop <= 0 && !memoLoadingOlder && memoOldestDoc) {
      memoLoadingOlder = true;
      const prevHeight = box.scrollHeight;

      const olderSnap = await col
        .orderBy('ts', 'desc')
        .startAfter(memoOldestDoc)     // さらに古いページへ
        .limit(memoPageSize)
        .get();

      if (!olderSnap.empty) {
        // 受け取るのは降順なので、表示は昇順で「先頭に」挿入
        const frag = document.createDocumentFragment();
        olderSnap.docs.slice().reverse().forEach(d => {
          frag.appendChild( renderMemoItem(d.data()) );
        });
        box.insertBefore(frag, box.firstChild);
        // 次のページング用に「今回の最古」を更新
        memoOldestDoc = olderSnap.docs[olderSnap.docs.length - 1];

        // スクロール位置を維持（ジャンプしないように）
        const newHeight = box.scrollHeight;
        box.scrollTop = newHeight - prevHeight;
      }
      memoLoadingOlder = false;
    }
  };

  // 3) 最新1件はライブ購読して、増えたら末尾に追記
  memoLiveUnsub = col.orderBy('ts', 'desc').limit(1).onSnapshot(snap => {
    const d = snap.docs[0];
    if (!d) return;
    const data = d.data();
    if (data.ts > memoLatestTs) {
      box.appendChild( renderMemoItem(data) );
      memoLatestTs = data.ts;
      box.scrollTop = box.scrollHeight; // 新着は下端へ
    }
  });

  // タブ切替時に後始末できるように束ねる
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

function renderPlans() {
  populatePlanScopeSelect();
  // 既存の購読を解除
  if (unsubscribePlans) unsubscribePlans();
  // 月文字列（YYYY-MM）。空なら現在月。
  const mon = $("#planMonthPick")?.value || getMonthStr(new Date());
  // ピッカーが空だった場合はUIにも反映
  if ($("#planMonthPick") && !$("#planMonthPick").value) $("#planMonthPick").value = mon;

  // 描画先を準備
  const box = $("#planList");
  if (!box) return;
  box.innerHTML = "";

  // 年月→その月の日数
  const [yy, mm] = mon.split("-").map(Number);
  const daysInMonth = endOfMonth(new Date(yy, mm - 1, 1)).getDate();

  // ここで per-day のサブ購読を束ねるための配列を用意
  const unsubs = [];
  unsubscribePlans = () => { unsubs.forEach(fn => { try { fn && fn(); } catch(_){} }); };

  // 右肩のフィルタ値はリスナー内で毎回読む（動的反映のため）
  const classMap = { ジョグ: "jog", ポイント: "point", 補強: "sup", オフ: "off", その他: "other" };

  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(yy, mm - 1, d);
    const dayKey = ymd(dt);                // ← 空にならない（必ず 'YYYY-MM-DD'）
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="dow">${["SU","MO","TU","WE","TH","FR","SA"][dt.getDay()]}<br>${d}</div>
      <div class="txt" id="pl_${dayKey}" style="flex-wrap: wrap; flex-direction: row; align-items: center;">—</div>
    `;
    row.addEventListener("click", () => openPlanModal(dt));
    box.appendChild(row);

    // 日別の events サブコレにリアルタイム購読を張る（インデックス不要）
    const unsub = getPlansCollectionRef(teamId)
      .doc(dayKey)                     // ← empty path にならない（上で dayKey を必ず生成）
      .collection('events')
      .orderBy('mem')                  // 任意。不要なら外してもOK
      .onSnapshot(snapshot => {
        const scope = $("#planScope")?.value || "all";
        const tagText = $("#tagFilter")?.value.trim() || "";
        const tagSet = new Set(tagText ? tagText.split(",").map(s => s.trim()).filter(Boolean) : []);

        const arr = [];
        snapshot.docs.forEach(doc => {
          const it = doc.data();
          // フィルタ：scope
          if (scope === "team" && it.scope !== "team") return;
          if (scope !== "all" && scope !== "team" && it.mem !== scope) return;
          // フィルタ：tag
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
        // エラー時も UI を落とさない
        const targetEl = document.getElementById("pl_" + dayKey);
        if (targetEl) targetEl.textContent = "—";
        console.error("plans onSnapshot error:", err);
      });

    unsubs.push(unsub);
  }

  // 月コメント（チャット）は既存ロジックのまま
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

async function collectPlansTextForDay(day, scopeSel) {
    const dayKey = ymd(day);
    const plansRef = getPlansCollectionRef(teamId).doc(dayKey).collection('events');
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

// ===== NEW: Dashboard =====
function initDashboard() {
    const toggleBtn = $("#distChartToggle");
    const prevBtn = $("#distChartPrev");
    const nextBtn = $("#distChartNext");
    if (toggleBtn) toggleBtn.addEventListener('click', () => {
        dashboardMode = (dashboardMode === 'month')
          ? 'week'
          : (dashboardMode === 'week')
            ? 'day'
            : 'month';
        dashboardOffset = 0;
        renderDashboard();
    });
    if (prevBtn) prevBtn.addEventListener('click', () => { dashboardOffset--; renderDashboard(); });
    if (nextBtn) nextBtn.addEventListener('click', () => { dashboardOffset++; renderDashboard(); });

    const condPrevBtn = $("#condChartPrev");
    const condNextBtn = $("#condChartNext");
    if(condPrevBtn) condPrevBtn.addEventListener('click', () => { conditionChartOffset -= 7; renderConditionChart(); });
    if(condNextBtn) condNextBtn.addEventListener('click', () => { conditionChartOffset += 7; renderConditionChart(); });
}

function renderDashboard() {
    renderDistanceChart();
    renderConditionChart();
}

async function renderDistanceChart() {
    const ctx = $('#distanceChart')?.getContext('2d');
    if (!ctx) return;
    
    const toggleBtn = $("#distChartToggle");
    toggleBtn.textContent = dashboardMode === 'month' ? '月' : '週';
    
    const labels = [];
    const chartData = [];
    const journalSnaps = await db.collection('teams').doc(teamId).collection('members').doc(viewingMemberId).collection('journal').get();
    const journal = {};
    journalSnaps.forEach(doc => journal[doc.id] = doc.data());
    
    if (dashboardMode === 'month') {
        $("#distChartTitle").textContent = "月間走行距離グラフ";
        const monthlyTotals = {};
        for (const ymdStr in journal) {
            const monthStr = ymdStr.substring(0, 7);
            monthlyTotals[monthStr] = (monthlyTotals[monthStr] || 0) + Number(journal[ymdStr].dist || 0);
        }
        const targetMonth = new Date();
        targetMonth.setMonth(targetMonth.getMonth() + dashboardOffset);
        for (let i = 5; i >= 0; i--) {
            const d = new Date(targetMonth);
            d.setMonth(d.getMonth() - i);
            const month = getMonthStr(d);
            labels.push(month);
            chartData.push((monthlyTotals[month] || 0).toFixed(1));
        }
    } else { // week mode
        $("#distChartTitle").textContent = "週間走行距離グラフ";
        const today = new Date();
        const currentWeekStart = startOfWeek(today);
        const targetWeekStart = addDays(currentWeekStart, dashboardOffset * 7);
        for (let i = 5; i >= 0; i--) {
            const weekStart = addDays(targetWeekStart, -i * 7);
            labels.unshift(`${ymd(weekStart).slice(5)}~`);
            let weeklyTotal = 0;
            for (let j = 0; j < 7; j++) {
                const day = addDays(weekStart, j);
                const dayData = journal[ymd(day)];
                if (dayData) weeklyTotal += Number(dayData.dist || 0);
            }
            chartData.unshift(weeklyTotal.toFixed(1));
        }
    }

    } else { // 'day'：日別ビュー
      $("#distChartTitle").textContent = "日別走行距離グラフ";
      const windowLen = 14; // 表示本数（必要なら 30 などに変更可）

      const today = new Date();
  // dashboardOffset に応じて 14 日ずつページ送り
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
}

async function renderConditionChart() {
    const ctx = $('#conditionChart')?.getContext('2d');
    if (!ctx) return;
    const labels = [];
    const chartData = [];
    const journalSnaps = await db.collection('teams').doc(teamId).collection('members').doc(viewingMemberId).collection('journal').get();
    const journal = {};
    journalSnaps.forEach(doc => journal[doc.id] = doc.data());
    
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

    if (memoInput) memoInput.addEventListener('keydown', (e) => {
        if (e.key === "Enter") sendMessage();
    });
    if(sendBtn) sendBtn.onclick = sendMessage;
}



async function checkNewMemo() {
    const lastView = localStorage.getItem(`athlog:${teamId}:lastMemoView`) || 0;
    const snapshot = await getTeamMemoCollectionRef(teamId).orderBy('ts', 'desc').limit(1).get();
    const memoTab = $('[data-tab="memo"]');
    if (!snapshot.empty) {
        const lastMessage = snapshot.docs[0].data();
        if (memoTab && lastMessage.ts > lastView) {
            memoTab.classList.add('new-message');
        } else if (memoTab) {
            memoTab.classList.remove('new-message');
        }
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
    // === ヘルプ本文を流し込み ===
const helpBody = document.getElementById("helpBody");
if (helpBody) {
  helpBody.innerHTML = `
    <!-- キャンバスで作った「AthLog1 クイックガイド」の本文をここにコピペ -->
    <!-- 例: <h2>はじめに</h2><p>…</p> など -->
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
  <li>距離：週/月切替・左右で期間移動</li>
  <li>調子：直近14日</li>
  <li>メモ：下に新着、上スクロールで過去</li>
</ul>
<h2>7. 困ったとき</h2>
<ul>
  <li>編集できない→右上の表示中メンバーが自分か確認</li>
  <li>色が変わらない→その日を保存</li>
  <li>月一覧が空→月を確認/再読み込み</li>
</ul>
  `;
}

// === 開閉イベント ===
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



















