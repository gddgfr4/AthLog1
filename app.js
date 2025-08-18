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

function ymd(d) { return d.toISOString().slice(0, 10); }
function startOfWeek(d) { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function getMonthStr(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }

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

    await populateMemberSelect();
    const memberSelect = $("#memberSelect");
    if (memberSelect) memberSelect.addEventListener('change', () => {
        viewingMemberId = $("#memberSelect").value;
        $("#memberLabel").textContent = viewingMemberId;
        switchTab($(".tab.active")?.dataset.tab, true);
    });

    initJournal(); initMonth(); initPlans(); initDashboard(); initMemo();
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
}

function initJournal() {
    imgEl = $("#humanImg");
    canvas = $("#paint");
    const fit = () => {
        if (!canvas || !imgEl) return;
        canvas.width = imgEl.clientWidth; canvas.height = imgEl.clientHeight;
        ctx = canvas.getContext("2d"); renderPaint();
    };
    if (imgEl && $(".canvas-wrap")) new ResizeObserver(fit).observe($(".canvas-wrap"));
    fit();

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

    $("#weekPrev")?.addEventListener("click", () => { selDate = addDays(selDate, -7); renderJournal(); });
    $("#weekNext")?.addEventListener("click", () => { selDate = addDays(selDate, 7); renderJournal(); });
    $("#gotoToday")?.addEventListener("click", () => { selDate = new Date(); renderJournal(); });
    $("#datePicker")?.addEventListener("change", (e) => { selDate = new Date(e.target.value); renderJournal(); });

    $$(".qbtn").forEach(b => b.addEventListener("click", async () => {
        const docRef = getJournalRef(teamId, memberId, selDate);
        await db.runTransaction(async (transaction) => {
            const doc = await transaction.get(docRef);
            const j = doc.data() || { tags: [] };
            const tag = b.textContent.trim();
            if (j.tags.includes(tag)) j.tags = j.tags.filter(t => t !== tag);
            else { if (j.tags.length >= 2) j.tags.shift(); j.tags.push(tag); }
            transaction.set(docRef, { tags: j.tags }, { merge: true });
        });
    }));

    $("#mergeBtn")?.addEventListener("click", async () => {
        const scope = $("#mergeScope").value;
        const text = await collectPlansTextForDay(selDate, scope);
        if (text) $("#trainInput").value = ($("#trainInput").value ? ($("#trainInput").value + "\n") : "") + text;
        const types = await collectPlansTypesForDay(selDate, scope);
        if (types.length) {
            const docRef = getJournalRef(teamId, memberId, selDate);
            await docRef.set({ tags: types.slice(0, 2) }, { merge: true });
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

    unsubscribeJournal = getJournalRef(teamId, viewingMemberId, selDate).onSnapshot(doc => {
        const j = doc.data() || { dist: 0, train: "", feel: "", tags: [], paint: [], condition: null };
        $("#distInput").value = j.dist || "";
        $("#trainInput").value = j.train || "";
        $("#feelInput").value = j.feel || "";
        
        $$('#conditionBtns button').forEach(b => b.classList.remove('active'));
        if (j.condition) $(`#conditionBtns button[data-val="${j.condition}"]`)?.classList.add('active');
        
        renderWeek(); 
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
    $("#weekSum").textContent = `週 走行距離: ${sumWeekKm(selDate).toFixed(1)} km`;
    $("#weekMonthLabel").textContent = `${selDate.getMonth() + 1}月`;
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
    const isReadOnly = viewingMemberId !== memberId;
    $("#monthGoalInput").disabled = isReadOnly;
    $("#saveMonthGoalBtn").disabled = isReadOnly;

    const box = $("#monthList"); if (!box) return;
    box.innerHTML = "";
    const [yy, mm] = $("#monthPick").value.split("-").map(Number);
    let sum = 0;
    for (let d = 1; d <= endOfMonth(new Date(yy, mm - 1, 1)).getDate(); d++) {
        const dt = new Date(yy, mm - 1, d);
        const doc = await getJournalRef(teamId, viewingMemberId, dt).get();
        const j = doc.data() || {};
        sum += Number(j.dist || 0);
        const row = document.createElement("div"); row.className = "row";
        const tags = j.tags || []; let tagsHtml = '';
        if (tags.length) {
            const classMap = { ジョグ: "jog", ポイント: "point", 補強: "sup", オフ: "off", その他: "other" };
            tagsHtml = `<div class="month-tags">` + tags.map(tag => `<span class="cat-tag ${classMap[tag] || ''}">${tag}</span>`).join('') + `</div>`;
        }
        const cond = j.condition; let condHtml = '';
        if (cond) {
            condHtml = `<div class="condition-display">` + Array(cond).fill(0).map((_, i) => `<span class="star c${cond}">★</span>`).join('') + `</div>`;
        }
        row.innerHTML = `<div class="dow">${["SU", "MO", "TU", "WE", "TH", "FR", "SA"][dt.getDay()]}<br>${d}</div>
                     <div class="txt">${tagsHtml}${condHtml}<div>${(j.train || "—")} <span class="km">${j.dist ? ` / ${j.dist}km` : ""}</span></div></div>`;
        row.addEventListener("click", () => { selDate = dt; switchTab("journal"); });
        box.appendChild(row);
    }
    $("#monthSum").textContent = `月間走行距離: ${sum.toFixed(1)} km`;
    const monthStr = $("#monthPick").value;
    const goalDoc = await getGoalsRef(teamId, viewingMemberId, monthStr).get();
    $("#monthGoalInput").value = goalDoc.data()?.goal || "";
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
    if (unsubscribePlans) unsubscribePlans();
    const mon = $("#planMonthPick").value;
    unsubscribePlans = getPlansCollectionRef(teamId).where('month', '==', mon).onSnapshot(snapshot => {
        const allPlans = {};
        snapshot.docs.forEach(doc => {
            const data = doc.data();
            if (!allPlans[data.day]) allPlans[data.day] = [];
            allPlans[data.day].push({ id: doc.id, ...data });
        });
        
        const box = $("#planList"); if(!box) return;
        box.innerHTML = "";
        const [yy, mm] = mon.split("-").map(Number);
        const scope = $("#planScope").value;
        const tagText = $("#tagFilter").value.trim();
        const tagSet = new Set(tagText ? tagText.split(",").map(s => s.trim()).filter(Boolean) : []);
        for (let d = 1; d <= endOfMonth(new Date(yy, mm - 1, 1)).getDate(); d++) {
            const dt = new Date(yy, mm - 1, d);
            const dayKey = ymd(dt);
            const row = document.createElement("div"); row.className = "row";
            row.innerHTML = `<div class="dow">${["SU", "MO", "TU", "WE", "TH", "FR", "SA"][dt.getDay()]}<br>${d}</div>
                         <div class="txt" id="pl_${dayKey}" style="flex-wrap: wrap; flex-direction: row; align-items: center;">—</div>`;
            row.addEventListener("click", () => openPlanModal(dt));
            box.appendChild(row);
            
            const arr = allPlans[dayKey] || [];
            const list = arr.filter(it => {
                if (scope === "team" && it.scope !== "team") return false;
                if (scope !== 'all' && scope !== 'team' && it.mem !== scope) return false;
                if (tagSet.size && !(it.tags || []).some(t => tagSet.has(t))) return false;
                return true;
            });

            const targetEl = $("#pl_" + dayKey);
            if (list.length) targetEl.innerHTML = list.map(x => `<span style="display:inline-flex; align-items:center; gap:6px; margin: 2px 8px 2px 0;">${createPlanTagHtml(x.type)}<span>${x.content}</span></span>`).join("");
            else targetEl.textContent = '—';
        }
    });

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
        const planData = { type: pType.value, scope: pScope.value, content, mem: memberId, tags: (pTags.value || "").split(",").map(s => s.trim()).filter(Boolean), month: mon, day: dayKey };
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
        dashboardMode = dashboardMode === 'month' ? 'week' : 'month';
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

function renderMemo() {
    if (unsubscribeMemo) unsubscribeMemo();
    unsubscribeMemo = getTeamMemoCollectionRef(teamId).orderBy('ts').onSnapshot(snapshot => {
        const box = $("#memoChatLog"); if(!box) return;
        box.innerHTML = "";
        snapshot.docs.forEach(doc => {
            const m = doc.data();
            const div = document.createElement("div");
            div.className = "msg";
            const time = new Date(m.ts).toLocaleString("ja-JP");
            div.innerHTML = `<span class="name">${m.mem}</span><span class="txt">${m.txt}</span><span class="muted">  ${time}</span>`;
            box.appendChild(div);
        });
        box.scrollTop = box.scrollHeight;
    });
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
    const last = JSON.parse(localStorage.getItem("athlog:last") || "{}");
    if(last.team && last.member){
        teamId = last.team;
        memberId = last.member;
        viewingMemberId = last.member;
        await getMembersRef(teamId).doc(memberId).set({ name: memberId }, { merge: true });
        showApp();
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
        showApp();
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
    select.value = viewingMemberId;
}

document.addEventListener("DOMContentLoaded", () => {
    const btn = $("#loginBtn");
    if (btn) { btn.onclick = doLogin; }
    const t = $("#teamId"), m = $("#memberName");
    if (t && m) [t, m].forEach(inp => inp.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); }));
});
