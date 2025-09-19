const functions = require('firebase-functions');

// node-fetch v3（ESM）をCJSで使う小技
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const GEMINI_API_KEY = functions.config().gemini.key;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;

exports.geminiComment = functions.region('asia-northeast1').https.onRequest(async (req, res) => {
  // CORS（必要に応じて本番ドメインだけ残す）
  const ORIGIN = req.headers.origin || '';
  const ALLOW = [
    'https://gddgfr4.github.io', // ← 本番
    'http://localhost:5173',     // ← 開発
    'http://127.0.0.1:5500'
  ];
  if (ALLOW.includes(ORIGIN)) res.set('Access-Control-Allow-Origin', ORIGIN);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'content-type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  try{
    const { prompt } = req.body || {};
    if(!prompt || typeof prompt !== 'string'){
      return res.status(400).json({ error: 'prompt is required' });
    }

    const upstream = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }]}],
        generationConfig: { maxOutputTokens: 256, temperature: 0.7 }
      })
    });

    if(!upstream.ok){
      const detail = await upstream.text();
      return res.status(502).json({ error: 'Gemini upstream error', detail });
    }

    const data = await upstream.json();
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text
      || data?.candidates?.[0]?.content?.parts?.[0]?.stringValue
      || '';

    return res.json({ text });
  }catch(e){
    console.error('[geminiComment]', e);
    return res.status(500).json({ error: 'server error' });
  }
});
