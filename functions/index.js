// functions/index.js

// ▼▼▼ 冒頭で一度だけ初期化するように修正 ▼▼▼
const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
// ▲▲▲ ここまで ▲▲▲

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
  // (geminiCommentの中身は変更なし)
  setCors(res, req.headers.origin || '');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    return res.status(200).json({ text: 'ok' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Internal', detail: String(e) });
  }
};

exports.createCommentNotification = functions.firestore
  .document('teams/{teamId}/members/{memberId}/journal/{journalId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();

    if (before.teamComment !== after.teamComment && after.teamComment) {
      const { teamId, journalId } = context.params;
      const commenterId = after.lastCommentBy;

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
        
        // ▼▼▼ if文を削除し、全員に通知を作成するように修正 ▼▼▼
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
        // ▲▲▲ ここまで ▲▲▲
      });
      
      console.log(`Creating notifications for comment on ${journalId} by ${commenterId}`);
      return batch.commit();
    }
    return null;
  });
