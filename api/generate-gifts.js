// ============================================================
// GiftMatch — AI Gift Generation API (Vercel Serverless)
// ============================================================
// File location: /api/generate-gifts.js
// Endpoint: https://yoursite.vercel.app/api/generate-gifts
// Required env var: ANTHROPIC_API_KEY
// ============================================================

const SYSTEM_PROMPT = `You are a gift recommendation expert curating matches for European customers. You speak warmly and write engaging, specific descriptions. All prices are in EUR. All gifts must be plausibly available from EU retailers (Amazon EU, Etsy EU, niche European brands).

Return ONLY valid JSON. No prose, no markdown, no code fences. Schema:
{
  "summary": "One short warm sentence (max 25 words) describing what kind of person this is, based on the profile.",
  "gifts": [
    {
      "emoji": "single emoji that fits the gift",
      "name": "Specific product name (max 8 words)",
      "meta": "Why it suits THEM — reference their personality (max 12 words)",
      "price_eur": number_between_15_and_200_inclusive
    }
  ]
}

The gifts array must have exactly 12 items, sorted by best-fit first. Use diverse price points: 3 budget (€15-35), 5 mid (€35-90), 4 premium (€90-200). Avoid generic suggestions like "a candle" — be specific: "Diptyque Baies candle (190g)". Reference their actual personality traits from the profile.`;

// In-memory rate limiter (resets on cold start — good enough for MVP)
const requestLog = new Map();
const RATE_LIMIT = 5;
const RATE_WINDOW = 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entries = requestLog.get(ip) || [];
  const recent = entries.filter(t => now - t < RATE_WINDOW);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  requestLog.set(ip, recent);
  return true;
}

export default async function handler(req, res) {
  // CORS headers — same domain so '*' is fine, but tighten if you embed elsewhere
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limit by IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  // Validate input
  const { profile } = req.body || {};
  if (!profile || typeof profile !== 'string' || profile.length > 5000) {
    return res.status(400).json({ error: 'Invalid profile data' });
  }

  // Get API key from env
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY environment variable is not set');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  try {
    // Call Claude API
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Here is the gift recipient profile (20 quiz answers):\n\n${profile}\n\nReturn the JSON now.`
        }]
      })
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error('Claude API error:', claudeRes.status, errText);
      return res.status(502).json({ error: 'AI service unavailable' });
    }

    const result = await claudeRes.json();
    const text = result.content[0].text.trim();

    // Strip code fences if Claude wrapped JSON in them
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/\s*```$/, '');

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('JSON parse failed. Claude returned:', text);
      return res.status(502).json({ error: 'Invalid AI response format' });
    }

    // Validate shape
    if (!parsed.gifts || !Array.isArray(parsed.gifts) || parsed.gifts.length === 0) {
      return res.status(502).json({ error: 'AI returned malformed data' });
    }

    return res.status(200).json(parsed);

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
