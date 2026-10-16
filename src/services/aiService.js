const axios = require('axios');
const pool = require('../../config/db');

// ---------------------------------------------------------------------------
// AI Disaster Assistant.
//
// Primary: Google Gemini (free tier) via the generativelanguage REST API when
// GEMINI_API_KEY is configured. Fallback: a local rule-based engine that scores
// the question against the ai_knowledge table, so the assistant always works
// even with no API key or no internet.
// ---------------------------------------------------------------------------

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

function geminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

// Most recent active alerts, used to ground the assistant in live conditions.
async function liveContext() {
  try {
    const [alerts] = await pool.query(
      `SELECT a.title, a.severity FROM alerts a
       WHERE a.status = 'sent'
         AND (a.expires_at IS NULL OR a.expires_at > NOW())
       ORDER BY a.sent_at DESC, a.id DESC LIMIT 3`);
    if (alerts.length) {
      return 'Current active alerts in the municipality:\n' +
        alerts.map(a => `- [${a.severity.toUpperCase()}] ${a.title}`).join('\n');
    }
    return 'There are currently no active alerts for the municipality.';
  } catch {
    return '';
  }
}

const SYSTEM_PROMPT =
  'You are the Municipality Disaster Alert System (MDAS) AI assistant for a Philippine municipality. ' +
  'Give accurate, practical, calm and concise disaster-preparedness guidance (flood, typhoon, earthquake, ' +
  'landslide, storm surge, fire, go-bags, evacuation, missing persons, first aid). ' +
  'Use Philippine context (PAGASA storm signals, DRRM terminology). Format answers as short numbered or ' +
  'bulleted steps that are easy to read on a phone. In life-threatening emergencies, always tell the user ' +
  'to call the local hotlines first (police 117, fire 117/143, ambulance 143, MDRRMO). ' +
  'Never give instructions that could cause harm. If a question is unrelated to disaster safety or this ' +
  'system, politely steer back to how you can help with preparedness.';

async function askGemini(question, context) {
  // gemini-1.5-* has been retired from the API; default to a current model.
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const key = process.env.GEMINI_API_KEY;
  const url = `${GEMINI_URL}/${model}:generateContent`;
  const prompt = context ? `${question}\n\n---\nLive situation context: ${context}` : question;

  const resp = await axios.post(url, {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 700 }
  }, {
    timeout: 15000,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }
  });

  const parts = (((resp.data || {}).candidates || [])[0] || {}).content;
  const text = parts && Array.isArray(parts.parts)
    ? parts.parts.map(p => p.text).filter(Boolean).join('').trim()
    : '';
  if (!text) throw new Error('Empty response from Gemini');
  return { answer: text, topic: 'gemini', source: 'gemini' };
}

// Local rule-based fallback (original behavior).
async function askRule(question) {
  const q = String(question || '').toLowerCase().trim();
  const [rows] = await pool.query('SELECT topic, keywords, answer, category FROM ai_knowledge');
  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    const keywords = String(row.keywords).toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
    let score = 0;
    for (const kw of keywords) {
      if (q.includes(kw)) score += kw.split(/\s+/).length; // multi-word matches weigh more
    }
    if (score > bestScore) { bestScore = score; best = row; }
  }

  let contextNote = '';
  try {
    const [alerts] = await pool.query(
      `SELECT a.title, a.severity FROM alerts a
       WHERE a.status = 'sent'
         AND (a.expires_at IS NULL OR a.expires_at > NOW())
       ORDER BY a.sent_at DESC, a.id DESC LIMIT 3`);
    contextNote = alerts.length
      ? '\n\nActive alerts right now:\n' + alerts.map(a => `• [${a.severity.toUpperCase()}] ${a.title}`).join('\n')
      : '\n\nThere are currently no active alerts for the municipality.';
  } catch { /* context is optional */ }

  if (!best || bestScore === 0) {
    if (/^(hi|hello|hey|good (morning|afternoon|evening))/.test(q)) {
      return {
        answer: 'Hello! I am the MDAS Disaster Assistant. Ask me about flood, typhoon, earthquake, fire or landslide preparedness, go-bags, evacuation centers, risk levels, missing persons, or how to report an incident.' + contextNote,
        topic: 'greeting', source: 'local'
      };
    }
    return {
      answer: 'I can help with disaster preparedness and this system. Try asking, for example: "What should I do before a flood?", "What is in a go-bag?", "Where are the evacuation centers?", or "How do I report an incident?"' + contextNote,
      topic: null, source: 'local'
    };
  }
  return { answer: best.answer + contextNote, topic: best.topic, category: best.category, source: 'local' };
}

async function ask(question) {
  const q = String(question || '').trim();
  if (!q) {
    return { answer: 'Please type your question about disaster preparedness, alerts, or how to use this system.', topic: null, source: 'local' };
  }
  if (geminiConfigured()) {
    try {
      return await askGemini(q, await liveContext());
    } catch (err) {
      console.error('[ai] Gemini call failed, using local fallback:', err.message);
    }
  }
  return askRule(q);
}

module.exports = { ask, askRule, askGemini, geminiConfigured };
