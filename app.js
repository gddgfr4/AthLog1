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

// ... (The rest of the file is identical to the one provided in the previous turn)
