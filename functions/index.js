// functions/index.js

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const ALLOWED_ORIGINS = [
  'https://gddgfr4.github.io', // 本番
  'http://localhost:5173',     // 開発用
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
  // (この関数は変更なし)
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

// ▼▼▼ この関数を追加 ▼▼▼
exports.createCommentNotification = functions.firestore
  .document('teams/{teamId}/members/{memberId}/journal/{journalId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();

    // コメントが更新された場合のみ実行
    if (before.teamComment !== after.teamComment && after.teamComment) {
      const { teamId, memberId, journalId } = context.params;
      const commenterId = after.lastCommentBy;

      if (!commenterId) {
        console.log(`Commenter ID not found for journal ${journalId}. Skipping notification.`);
        return null;
      }

      const db = admin.firestore();
      const notificationRef = db.collection('teams').doc(teamId).collection('notifications').doc();
      
      console.log(`Creating notification for ${memberId} about a comment on ${journalId} by ${commenterId}.`);
      
      return notificationRef.set({
        type: 'dayComment',
        team: teamId,
        day: journalId,
        text: after.teamComment,
        from: commenterId,
        to: memberId, // 通知の宛先は日誌の持ち主
        ts: Date.now(),
        read: false
      });
    }
    return null;
  });
