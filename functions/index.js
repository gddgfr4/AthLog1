// functions/index.js
const ALLOWED_ORIGINS = [
  'https://gddgfr4.github.io', // 本番
  'http://localhost:5173',     // 開発用（不要なら削除）
  'http://127.0.0.1:5500'
];

function setCors(res, origin) {
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

exports.geminiComment = async (req, res) => {
  setCors(res, req.headers.origin || '');

  // Preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).send(''); // 必ず 204 と CORS ヘッダ
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    // ← ここで Gemini API を呼ぶ（省略可：今までの実装そのままでOK）
    // 例:
    // const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`;
    // const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ contents:[{ parts:[{ text: prompt }]}] }) });
    // const data = await r.json();
    // const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    return res.status(200).json({ text: 'ok' }); // ↑実際は text を返す
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Internal', detail: String(e) });
  }
};


// functions/index.js に追記・修正
const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

// (既存のgeminiCommentなどのコード...)

// ↓ ここから追記
exports.createCommentNotification = functions.firestore
  .document('teams/{teamId}/members/{memberId}/journal/{journalId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();

    // teamCommentフィールドが変更され、かつ中身がある場合のみ実行
    if (before.teamComment !== after.teamComment && after.teamComment) {
      const { teamId, memberId, journalId } = context.params;
      
      // コメント投稿者の情報はドキュメントからは直接取れないため、
      // `app.js`からコメント保存時に投稿者IDも保存するように改修が必要です。
      // (例: after.lastCommentBy)
      const commenterId = after.lastCommentBy; // このフィールドをapp.js側で追加する

      if (!commenterId) {
        console.log('Commenter ID not found. Skipping notification.');
        return null;
      }

      const db = admin.firestore();
      const membersSnap = await db.collection('teams').doc(teamId).collection('members').get();
      
      const batch = db.batch();
      const ts = Date.now();

      membersSnap.docs.forEach(memberDoc => {
        const toMemberId = memberDoc.id;
        // 自分自身には通知しない
        if (toMemberId !== commenterId) {
          const notificationRef = db.collection('teams').doc(teamId).collection('notifications').doc();
          batch.set(notificationRef, {
            type: 'dayComment',
            team: teamId,
            day: journalId,
            text: after.teamComment,
            from: commenterId,
            to: toMemberId,
            ts: ts,
            read: false
          });
        }
      });
      
      console.log(`Creating notifications for comment on ${journalId} by ${commenterId}`);
      return batch.commit();
    }
    return null;
  });
