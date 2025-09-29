// functions/index.jse

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

// (geminiComment関数は変更ありません)
exports.geminiComment = async (req, res) => {
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

    // コメントが更新された場合のみ実行
    if (before.teamComment !== after.teamComment && after.teamComment) {
      const { teamId, memberId, journalId } = context.params;
      const commenterId = after.lastCommentBy;

      // ▼▼▼ 変更点: 自分自身のコメントでも通知を送るように修正 ▼▼▼
      // コメント投稿者のIDが記録されていない場合のみ、処理を中断します。
      if (!commenterId) {
        console.log(`Commenter ID not found for journal ${journalId}. Skipping notification.`);
        return null;
      }
      // ▲▲▲ ここまでが変更点 ▲▲▲

      // 日誌の持ち主(memberId)にだけ通知を作成する
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

// functions/index.js の migrateUserData 関数をこれで置き換える

exports.migrateUserData = functions.https.onCall(async (data, context) => {
  // 認証済みユーザーでなければエラー
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'この操作には認証が必要です。');
  }

  const newUid = context.auth.uid;
  const oldName = data.oldName;
  if (!oldName) {
    throw new functions.https.HttpsError('invalid-argument', '移行元の名前(oldName)が必要です。');
  }

  const db = admin.firestore();

  try {
    const userProfileSnap = await db.collection('users').doc(newUid).get();
    if (!userProfileSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'ユーザープロファイルが見つかりません。');
    }
    const teamId = userProfileSnap.data().teamId;

    const newMemberRef = db.collection('teams').doc(teamId).collection('members').doc(newUid);
    const newMemberDoc = await newMemberRef.get();
    if (newMemberDoc.data()?.migrationCompleted) {
      return { status: 'skipped', message: '既に移行処理は完了しています。' };
    }

    const oldMemberRef = db.collection('teams').doc(teamId).collection('members').doc(oldName);
    const oldMemberDoc = await oldMemberRef.get();
    if (!oldMemberDoc.exists) {
      await newMemberRef.set({ migrationCompleted: true }, { merge: true });
      return { status: 'no_data', message: '移行対象の旧データは見つかりませんでした。' };
    }

    let journalCount = 0;
    let goalCount = 0;

    // Journal データの移行
    const journalSnapshot = await oldMemberRef.collection('journal').get();
    if (!journalSnapshot.empty) {
      const batch = db.batch();
      journalSnapshot.forEach(doc => {
        const newDocRef = newMemberRef.collection('journal').doc(doc.id);
        batch.set(newDocRef, doc.data());
        journalCount++;
      });
      await batch.commit();
    }

    // Goals データの移行
    const goalsSnapshot = await oldMemberRef.collection('goals').get();
    if (!goalsSnapshot.empty) {
      const batch = db.batch();
      goalsSnapshot.forEach(doc => {
        const newDocRef = newMemberRef.collection('goals').doc(doc.id);
        batch.set(newDocRef, doc.data());
        goalCount++;
      });
      await batch.commit();
    }
    
    // 移行完了フラグを立てる
    await newMemberRef.set({ migrationCompleted: true }, { merge: true });

    return {
      status: 'success',
      message: `データ移行が完了しました。日誌: ${journalCount}件, 目標: ${goalCount}件`,
    };

  } catch (error) {
    console.error("Migration failed:", error);
    // クライアント側でエラーを適切に処理できるよう、エラーをスローする
    throw new functions.https.HttpsError('internal', 'データ移行中にサーバーエラーが発生しました。詳細はログを確認してください。');
  }
});

