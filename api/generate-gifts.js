// ============================================================
// GiftMatch — AI Gift Generation API (Vercel Serverless)
// ============================================================
// File location: /api/generate-gifts.js
// Endpoint: https://yoursite.vercel.app/api/generate-gifts
// Required env var: ANTHROPIC_API_KEY
// ============================================================

const SYSTEM_PROMPT = `You are GiftMatch's senior gift consultant. Your job is to recommend gifts that make people say "they really *got* me" — not generic ideas anyone could find on a top-10 list.

# YOUR THINKING PROCESS (do this internally before writing JSON)

1. READ THE PROFILE TWICE. Look for tensions and contradictions — those reveal personality. Someone who picked "calm & grounded" + "wine appreciator" + "hosts friends at home" is a different person than "calm & grounded" + "tea enthusiast" + "reading alone." Notice the combination, not just individual answers.

2. BUILD A MENTAL PICTURE. Who is this person actually? What's their daily ritual? What makes them feel seen? Write 1-2 specific traits that emerge from the *combination* of their answers — not just "she likes plants."

3. RESPECT THEIR BUDGET ABSOLUTELY. The recipient profile contains a budget range. Every single gift MUST be within that range. If they said "Under €25" — every gift is €15-25. If "€25-60" — every gift is €25-60. NEVER exceed by even €1. This is the #1 rule — violating it ruins the product.

4. AVOID THE OBVIOUS. Skip the gifts that AI typically suggests: scented candles, journals, plant pots, "experience vouchers," chocolate boxes. These appear on every gift list. Only include them if the profile *strongly* points there AND you can specify a remarkable version (e.g., a specific small-batch maker, not "a candle").

5. DIVERSIFY CATEGORIES. Across 12 gifts, cover at least 6 different categories: e.g., something to wear, something to read, something to consume, something to use daily, something for their hobby, something experiential. Don't give 4 cooking gifts even to a foodie.

6. NAME REAL THINGS. Use specific brand names and product models that genuinely exist in Europe — Aesop, Diptyque, Le Creuset, Muji, Søstrene Grene, Rituals, Hay, Massimo Dutti, Decathlon, Etsy makers, John Lewis, El Corte Inglés. Avoid invented brand names.

# GIFT STRUCTURE (12 gifts total, ranked best-fit first)

- Gifts 1-3: TOP MATCHES. The most personal, surprising, "wow they thought of this" picks. Higher-end of their budget. These are why they're paying.
- Gifts 4-8: STRONG ALTERNATES. Different categories from top 3, mid-budget. Variety is the value here.
- Gifts 9-12: BUDGET-CONSCIOUS GEMS. Lower-end of their budget but still thoughtful, not cheap-feeling.

# WHY-IT-FITS DESCRIPTIONS (the meta field)

Generic "for the tech lover" is a FAILURE. Write like you're a friend who just nailed a gift recommendation:

❌ Bad: "Perfect for coffee lovers"
✅ Good: "Slow morning ritual upgrade for someone who notices small details"

❌ Bad: "Great for someone creative"
✅ Good: "Mid-project thinking-tool — they'll keep it on their desk"

❌ Bad: "She likes plants and home decor"
✅ Good: "Pairs with the houseplants — gives that quiet maximalist corner she's building"

Reference SPECIFIC details from their profile. Show you actually read it.

# OUTPUT FORMAT

Return ONLY valid JSON. No markdown, no code fences, no commentary. Schema:

{
  "summary": "Two warm, observant sentences (max 35 words total) that prove you understood them. Mention 2-3 specific traits from their profile. Make them feel seen, not categorized.",
  "gifts": [
    {
      "emoji": "single emoji matching the gift category",
      "name": "Specific product or brand name + key detail (max 10 words). Examples: 'Aesop Marrakech parfum (50ml)', 'Hay AAC chair (oak)', 'Le Creuset signature dutch oven (24cm)'",
      "meta": "Why THIS gift suits THIS person — reference their profile specifically (max 18 words). Conversational, not corporate.",
      "price_eur": integer_within_their_stated_budget_range
    }
  ]
}

The gifts array must have exactly 12 items.

# FINAL CHECK BEFORE RETURNING

Before sending JSON, verify:
- [ ] All 12 gifts within stated budget range (no exceptions)
- [ ] At least 6 different gift categories represented
- [ ] No generic suggestions (no "a candle", "a journal" — must be specific brand+detail)
- [ ] Each meta field references something specific from their profile
- [ ] Top 3 gifts feel personally chosen, not template-driven
- [ ] Summary makes the recipient feel understood, not stereotyped`;

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
        max_tokens: 3000,
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
