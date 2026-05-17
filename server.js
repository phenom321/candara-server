// server.js — Candara Research Backend
// Runs on Render.com with no timeout limits
// Holds API key securely as environment variable

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

// ── DNS FIX FOR SUPABASE (IPv6 PREFERENCE) ───────────────
// Supabase serves over IPv6 by default. Force Node to try IPv6 first to avoid
// getaddrinfo ENOTFOUND errors on Render and similar IPv6-capable platforms.
const dns = require('dns');
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder('ipv6first');

// Also force fetch to use IPv6 via a custom agent
const https = require('https');
const ipv6Agent = new https.Agent({ family: 6 });

const app  = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = [
  'https://candara.ai',
  'https://www.candara.ai',
  'https://candara-ai.netlify.app',
  'http://localhost:3000',
  'http://127.0.0.1:5500'
];

app.use(function(req, res, next) {
  const origin = req.headers.origin;
  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Cookie');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});
const cookieParser = require('cookie-parser');
app.use(express.json());
app.use(cookieParser());

// ── AUTH RATE LIMITER ─────────────────────────────────────
// Max 5 attempts per IP per 15 minutes on signin/signup
const authAttempts = {};
const AUTH_WINDOW  = 15 * 60 * 1000;
const AUTH_MAX     = 5;

function authRateLimit(req, res, next) {
  const ip  = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1').split(',')[0].trim();
  const now = Date.now();
  if (!authAttempts[ip]) authAttempts[ip] = [];
  authAttempts[ip] = authAttempts[ip].filter(function(t) { return now - t < AUTH_WINDOW; });
  if (authAttempts[ip].length >= AUTH_MAX) {
    const waitMins = Math.ceil((authAttempts[ip][0] + AUTH_WINDOW - now) / 60000);
    return res.status(429).json({ error: 'Too many attempts. Please wait ' + waitMins + ' minute(s) before trying again.' });
  }
  authAttempts[ip].push(now);
  next();
}

// Clean up stale entries every 30 minutes
setInterval(function() {
  const now = Date.now();
  Object.keys(authAttempts).forEach(function(ip) {
    authAttempts[ip] = authAttempts[ip].filter(function(t) { return now - t < AUTH_WINDOW; });
    if (!authAttempts[ip].length) delete authAttempts[ip];
  });
}, 30 * 60 * 1000);


// ── SYSTEM PROMPT ─────────────────────────────────────────
const SYSTEM_PROMPT = `You are a financial research analyst. Your role is to provide objective, in-depth company research and analysis ONLY. Do NOT provide investment recommendations, buy/sell/hold opinions, target prices, or portfolio advice of any kind.

Use web search to find current, real financial data: recent earnings reports, actual financial metrics, analyst commentary, recent news, and current valuation data. Search multiple times if needed to get complete data.

Produce a research report and return it as a single valid JSON object — no markdown fencing, no preamble, raw JSON only.

Return exactly this shape:
{
  "companyName": "Full official company name",
  "ticker": "TICKER or N/A",
  "sector": "Sector",
  "exchange": "Exchange",
  "executiveSummary": {
    "business": "One key finding on core revenue model, market position, and cyclicality",
    "competitivePosition": "One key finding on moat strength or fragility",
    "financialHealth": "One key finding on earnings quality, margins, and returns",
    "balanceSheet": "One key finding on leverage position and appropriateness",
    "earningsQuality": "One key finding on reliability of reported earnings",
    "management": "One key finding on capital allocation track record and integrity",
    "valuation": "One key finding on where the stock sits relative to intrinsic value estimates",
    "risks": "The single most material risk to the analysis"
  },
  "sections": [
    {
      "num": "01",
      "title": "Business Overview",
      "subsections": [
        { "heading": "Revenue Model & Business Segments", "content": "..." },
        { "heading": "Market Size, Growth & Margin Profile", "content": "..." },
        { "heading": "Market Position", "content": "..." },
        { "heading": "Cyclicality Assessment", "content": "..." }
      ]
    },
    {
      "num": "02",
      "title": "Competitive Landscape & Moat",
      "subsections": [
        { "heading": "Competitive Advantages", "content": "..." },
        { "heading": "Defensibility & Erosion Risks", "content": "..." },
        { "heading": "Barriers to Entry", "content": "..." },
        { "heading": "Pricing Power & Margin Sustainability", "content": "..." }
      ]
    },
    {
      "num": "03",
      "title": "Financial Health",
      "metrics": [
        { "label": "FCF", "value": "actual figure from search", "note": "Most recent annual" },
        { "label": "FCF / Sales", "value": "actual % from search", "note": "vs peers" },
        { "label": "Net Margin", "value": "actual % from search", "note": "Trend" },
        { "label": "ROE", "value": "actual % from search", "note": "vs sector avg" },
        { "label": "ROIC", "value": "actual % from search", "note": "vs WACC" },
        { "label": "Revenue Growth", "value": "actual % from search", "note": "YoY" }
      ],
      "subsections": [
        { "heading": "Free Cash Flow Analysis", "content": "..." },
        { "heading": "Margins & Returns", "content": "..." },
        { "heading": "Revenue & Earnings Trajectory", "content": "..." },
        { "heading": "R&D Investment", "content": "..." },
        { "heading": "Share Count Trend", "content": "..." }
      ]
    },
    {
      "num": "04",
      "title": "Balance Sheet Health",
      "metrics": [
        { "label": "D/E Ratio", "value": "actual from search", "note": "Trend" },
        { "label": "Interest Coverage", "value": "actual from search", "note": "EBIT / interest" },
        { "label": "Net Cash/Debt", "value": "actual from search", "note": "Net position" }
      ],
      "subsections": [
        { "heading": "Debt & Leverage", "content": "..." },
        { "heading": "Net Cash / Net Debt Position", "content": "..." },
        { "heading": "Appropriateness for Business Risk Profile", "content": "..." }
      ]
    },
    {
      "num": "05",
      "title": "Earnings Quality",
      "subsections": [
        { "heading": "Net Income vs Free Cash Flow", "content": "..." },
        { "heading": "Nonrecurring Items & One-Time Charges", "content": "..." },
        { "heading": "Revenue Recognition Policy", "content": "..." },
        { "heading": "Auditor Flags & Internal Controls", "content": "..." },
        { "heading": "Earnings Consistency & Predictability", "content": "..." }
      ]
    },
    {
      "num": "06",
      "title": "Management Quality",
      "subsections": [
        { "heading": "Integrity & Capital Allocation Discipline", "content": "..." },
        { "heading": "Track Record on Guidance & Execution", "content": "..." },
        { "heading": "Response to Margin & Competitive Pressures", "content": "..." }
      ]
    },
    {
      "num": "07",
      "title": "Valuation",
      "subsections": [
        { "heading": "DCF Intrinsic Value Estimate", "content": "Show key assumptions: discount rate, terminal growth rate, FCF base. Provide estimated intrinsic value range." },
        { "heading": "Relative Valuation vs Peers & Indices", "content": "P/E and P/S vs historical averages, sector peers, S&P 500, Nasdaq." },
        { "heading": "PEG Ratio", "content": "..." },
        { "heading": "Historical Valuation Range & Current Sentiment", "content": "..." },
        { "heading": "Short-Term Technical Indicators", "content": "RSI and Bollinger Band readings and what they suggest." }
      ]
    },
    {
      "num": "08",
      "title": "Key Risks",
      "subsections": [
        { "heading": "Principal Risks", "content": "..." },
        { "heading": "Cyclical vs Structural Risk Classification", "content": "..." },
        { "heading": "Cycle Positioning & Timing Sensitivity", "content": "..." }
      ]
    }
  ]
}

Use web search to find REAL current data. Replace all metric values with actual figures. Be analytical, specific, and direct. Always return complete, valid JSON — never truncate mid-response.

You must also include a "scorecard" object at the top level of the JSON with exactly these fields:

"scorecard": {
  "businessModel": {
    "rating": "Weak" | "Moderate" | "Strong",
    "summary": "One sentence on revenue model quality, recurring revenue, unit economics, and margin profile"
  },
  "marketOpportunity": {
    "rating": "Limited" | "Moderate" | "Large",
    "summary": "One sentence on TAM size, market growth rate, and whether this is a winner-take-most market"
  },
  "teamStrength": {
    "rating": "Weak" | "Moderate" | "Strong",
    "summary": "One sentence on management track record, capital allocation discipline, and execution quality"
  },
  "competition": {
    "rating": "Weak" | "Moderate" | "Strong",
    "summary": "One sentence on competitive positioning vs peers — moat strength, market share, pricing power, and differentiation. Strong = clear moat and dominant position. Weak = commoditised or easily disrupted."
  },
  "valuation": {
    "rating": "Cheap" | "Fair" | "Expensive",
    "summary": "One sentence on P/E, P/S, EV/EBITDA and DCF vs peers and historical range — is the stock attractively priced, fairly valued, or stretched?"
  },
  "fundingAndFinancials": {
    "rating": "Weak" | "Moderate" | "Strong",
    "summary": "One sentence on balance sheet health, FCF generation quality, debt levels, interest coverage, and financial resilience"
  }
}`;

// ── IN-MEMORY RATE LIMIT (POINTS SYSTEM) ─────────────────
// Quick search = 1 point, Deep research = 2 points
// Limit: 2 points/day, 8 points/week
const rateLimitStore = {};
const DAILY_LIMIT  = 1;
const WEEKLY_LIMIT = 3;

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getWeekKey() {
  var now  = new Date();
  var day  = now.getUTCDay();
  var diff = (day === 0 ? -6 : 1 - day);
  var mon  = new Date(now);
  mon.setUTCDate(now.getUTCDate() + diff);
  return 'w:' + mon.toISOString().slice(0, 10);
}

function checkRateLimit(ip, points) {
  points = points || 1;
  var dayKey  = ip + ':' + getTodayKey();
  var weekKey = ip + ':' + getWeekKey();

  if (!rateLimitStore[dayKey])  rateLimitStore[dayKey]  = 0;
  if (!rateLimitStore[weekKey]) rateLimitStore[weekKey] = 0;

  var dayUsed  = rateLimitStore[dayKey];
  var weekUsed = rateLimitStore[weekKey];

  if (dayUsed + points > DAILY_LIMIT) {
    return { allowed: false, reason: 'daily',
      message: 'You have used all ' + DAILY_LIMIT + ' daily points. Resets at midnight UTC.',
      dayUsed, weekUsed, dayLimit: DAILY_LIMIT, weekLimit: WEEKLY_LIMIT };
  }
  if (weekUsed + points > WEEKLY_LIMIT) {
    return { allowed: false, reason: 'weekly',
      message: 'You have used all ' + WEEKLY_LIMIT + ' weekly points. Resets next Monday.',
      dayUsed, weekUsed, dayLimit: DAILY_LIMIT, weekLimit: WEEKLY_LIMIT };
  }

  rateLimitStore[dayKey]  += points;
  rateLimitStore[weekKey] += points;

  return { allowed: true,
    dayUsed:  rateLimitStore[dayKey],
    weekUsed: rateLimitStore[weekKey],
    dayLimit: DAILY_LIMIT,
    weekLimit: WEEKLY_LIMIT
  };
}

// ── SERVER-SIDE JSON REPAIR ──────────────────────────────
// Attempts to repair truncated JSON before sending to client
function repairJSON(str) {
  if (!str) return str;
  var clean = str.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

  // Try direct parse first
  try { JSON.parse(clean); return clean; } catch(e) {}

  // Find outermost { }
  var start = clean.indexOf('{');
  var end   = clean.lastIndexOf('}');

  if (start === -1) return clean;

  var extracted = end > start ? clean.slice(start, end + 1) : clean.slice(start);

  // Try extracted
  try { JSON.parse(extracted); return extracted; } catch(e) {}

  // Count and close unclosed brackets
  var opens = 0, aopens = 0, inStr = false, escape = false;
  for (var i = 0; i < extracted.length; i++) {
    var c = extracted[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"' && !escape) { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') opens++;
    if (c === '}') opens--;
    if (c === '[') aopens++;
    if (c === ']') aopens--;
  }

  var suffix = inStr ? '"' : '';
  for (var a = 0; a < aopens; a++) suffix += ']';
  for (var o = 0; o < opens; o++) suffix += '}';

  return extracted + suffix;
}

// ── TRIM SEARCH RESULTS ───────────────────────────────────
function trimSearchResults(toolResults) {
  return toolResults.map(function(block) {
    if (block.type !== 'tool_result') return block;
    var trimmed = Object.assign({}, block);
    if (typeof trimmed.content === 'string' && trimmed.content.length > 1200) {
      trimmed.content = trimmed.content.slice(0, 1200) + '...';
    }
    return trimmed;
  });
}

// ── HEALTH CHECK ──────────────────────────────────────────
app.get('/', function(req, res) {
  res.json({ status: 'Candara server running', time: new Date().toISOString() });
});

// ── GENERATE REPORT ENDPOINT ──────────────────────────────
app.post('/generate-report', async function(req, res) {

  // Rate limit
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1')
    .split(',')[0].trim();
  const rl = checkRateLimit(ip, 2);

  if (!rl.allowed) {
    return res.status(429).json({
      error:   'rate_limit',
      message: 'You have used all 3 free reports for today. Reports reset at midnight UTC.',
      used:    rl.used,
      limit:   rl.limit
    });
  }

  const { company } = req.body;
  if (!company || !company.name) {
    return res.status(400).json({ error: 'Missing company data' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  // ── TWO-MODEL APPROACH ───────────────────────────────────
  // Phase 1: Haiku runs web search rounds (cheap)
  // Phase 2: Sonnet writes the final report (quality)
  // Result: ~60% cost reduction, no impact on report quality

  const MAX_SEARCH_ROUNDS = 4;

  // Lean prompt for Haiku — just gather data, no JSON needed
  const HAIKU_SYSTEM = `You are a financial research assistant. Your job is to search the web and gather comprehensive raw data about the requested company. Search multiple times to collect:
- Actual revenue, earnings, net margin, FCF, ROE, ROIC figures (most recent annual and quarterly)
- FCF/Sales ratio, debt-to-equity, interest coverage, net cash or net debt position
- Business model description, revenue segments, market size and growth rate
- Competitive advantages, moat strength, key competitors, barriers to entry
- Management track record, capital allocation history, insider activity
- Valuation: P/E, P/S, PEG ratio vs historical averages, sector peers, S&P 500, Nasdaq
- DCF assumptions from analysts: discount rate, terminal growth, intrinsic value estimates
- Analyst price targets, buy/sell/hold consensus
- RSI, Bollinger Band readings, 52-week range, recent price action
- Key risks: cyclical vs structural, earnings quality signals, auditor flags
- Any material weaknesses, nonrecurring items, revenue recognition issues
- Share count trend, buybacks or dilution history

When done, output a detailed structured summary of ALL data found with actual numbers. Do not return JSON.`;

  const haikusSystemWithCache = [
    { type: 'text', text: HAIKU_SYSTEM, cache_control: { type: 'ephemeral' } }
  ];

  const sonnetSystemWithCache = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
  ];

  let haikusMessages = [
    {
      role:    'user',
      content: `Research this company thoroughly: ${company.name} (Ticker: ${company.ticker}, Exchange: ${company.exchange}). Search multiple times to gather ALL financial metrics, competitive data, valuation figures, technical indicators, and risk factors.`
    }
  ];

  let researchSummary = '';
  let roundCount      = 0;

  try {
    // ── PHASE 1: Haiku searches the web ──────────────────
    while (roundCount < MAX_SEARCH_ROUNDS) {
      roundCount++;
      console.log('Haiku research round', roundCount, 'of', MAX_SEARCH_ROUNDS);

      const haikusResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta':    'prompt-caching-2024-07-31'
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 8000,
          system:     haikusSystemWithCache,
          tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
          messages:   haikusMessages
        })
      });

      const haikusData = await haikusResponse.json();
      if (!haikusResponse.ok) {
        throw new Error(haikusData.error && haikusData.error.message ? haikusData.error.message : `Haiku API error ${haikusResponse.status}`);
      }

      const hContent    = haikusData.content || [];
      const hToolBlocks = hContent.filter(b => b.type === 'tool_use');
      const hTextBlocks = hContent.filter(b => b.type === 'text');

      // Haiku finished — grab summary
      if (!hToolBlocks.length || haikusData.stop_reason === 'end_turn') {
        researchSummary = hTextBlocks.map(b => b.text).join('');
        console.log('Haiku done. Rounds:', roundCount, 'Summary length:', researchSummary.length);
        break;
      }

      haikusMessages.push({ role: 'assistant', content: hContent });

      const hToolResults = hToolBlocks.map(block => ({
        type:        'tool_result',
        tool_use_id: block.id,
        content:     `Search completed for: "${block.input && block.input.query ? block.input.query : ''}"`
      }));

      haikusMessages.push({ role: 'user', content: trimSearchResults(hToolResults) });

      // On second-to-last round, tell Haiku to summarise
      if (roundCount === MAX_SEARCH_ROUNDS - 1) {
        haikusMessages.push({
          role:    'user',
          content: 'You have gathered enough data. Now write a comprehensive summary of ALL the research findings — every metric, every figure, every qualitative insight. Be thorough and specific with actual numbers.'
        });
      }
    }

    if (!researchSummary) {
      throw new Error('Research phase returned no data. Please try again.');
    }

    // ── PHASE 2: Sonnet writes the final report ───────────
    console.log('Sonnet report compilation starting...');

    const sonnetResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':    'prompt-caching-2024-07-31'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 16000,
        system:     sonnetSystemWithCache,
        messages:   [
          {
            role:    'user',
            content: `Using the following research data gathered about ${company.name} (${company.ticker}), compile a comprehensive analyst-grade research report and return it as the JSON object specified in your instructions. Use ALL data provided — do not omit any figures or findings.\n\nRESEARCH DATA:\n${researchSummary}`
          }
        ]
      })
    });

    const sonnetData = await sonnetResponse.json();
    if (!sonnetResponse.ok) {
      throw new Error(sonnetData.error && sonnetData.error.message ? sonnetData.error.message : `Sonnet API error ${sonnetResponse.status}`);
    }

    const sonnetContent = sonnetData.content || [];
    const finalText     = sonnetContent.filter(b => b.type === 'text').map(b => b.text).join('');
    const repairedText  = repairJSON(finalText);
    console.log('Sonnet done. Raw length:', finalText.length, 'Repaired:', repairedText.length);

    if (!repairedText) {
      throw new Error('Report compilation returned empty. Please try again.');
    }

    return res.json({
      text:      repairedText,
      rateLimit: { used: rl.used, limit: rl.limit, remaining: rl.limit - rl.used },
      rounds:    roundCount
    });

  } catch(err) {
    console.error('Report generation error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── QUICK SUMMARY ENDPOINT ───────────────────────────────
// Phase 1: Haiku does 1-2 searches, returns scorecard + exec summary only
// Fast (~30 seconds), gives user something to read immediately
app.post('/quick-summary', async function(req, res) {

  const { company } = req.body;
  if (!company || !company.name) {
    return res.status(400).json({ error: 'Missing company data' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const QUICK_SYSTEM = `You are a financial research analyst. Do a quick preliminary analysis of the requested company using 1-2 targeted web searches. Focus on gathering enough data to produce a high-level snapshot.

Return ONLY a valid JSON object with no markdown fencing, no preamble:
{
  "companyName": "Full official company name",
  "ticker": "TICKER or N/A",
  "sector": "Sector",
  "exchange": "Exchange",
  "executiveSummary": {
    "business": "One key finding on core revenue model, market position, and cyclicality",
    "competitivePosition": "One key finding on moat strength or fragility",
    "financialHealth": "One key finding on earnings quality, margins, and returns",
    "balanceSheet": "One key finding on leverage position and appropriateness",
    "earningsQuality": "One key finding on reliability of reported earnings",
    "management": "One key finding on capital allocation track record and integrity",
    "valuation": "One key finding on where the stock sits relative to intrinsic value estimates",
    "risks": "The single most material risk to the analysis"
  },
  "scorecard": {
    "businessModel": {
      "rating": "Weak" | "Moderate" | "Strong",
      "summary": "One sentence on revenue model quality and unit economics"
    },
    "marketOpportunity": {
      "rating": "Limited" | "Moderate" | "Large",
      "summary": "One sentence on market size and growth potential"
    },
    "teamStrength": {
      "rating": "Weak" | "Moderate" | "Strong",
      "summary": "One sentence on management track record and execution quality"
    },
    "competition": {
      "rating": "Weak" | "Moderate" | "Strong",
      "summary": "One sentence on competitive positioning, moat, and market share vs peers"
    },
    "valuation": {
      "rating": "Cheap" | "Fair" | "Expensive",
      "summary": "One sentence on P/E, P/S vs peers and historical range"
    },
    "fundingAndFinancials": {
      "rating": "Weak" | "Moderate" | "Strong",
      "summary": "One sentence on balance sheet health, FCF, and financial resilience"
    }
  }
}`;

  const systemWithCache = [
    { type: 'text', text: QUICK_SYSTEM, cache_control: { type: 'ephemeral' } }
  ];

  let messages = [{
    role: 'user',
    content: `Quick preliminary analysis for: ${company.name} (Ticker: ${company.ticker}, Exchange: ${company.exchange}). Do 1-2 targeted searches to gather key financial data, then return the JSON snapshot.`
  }];

  let finalText = '';
  let rounds = 0;

  try {
    while (rounds < 3) {
      rounds++;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4000,
          system: systemWithCache,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || `API error ${response.status}`);

      const content  = data.content || [];
      const toolBlocks = content.filter(b => b.type === 'tool_use');
      const textBlocks = content.filter(b => b.type === 'text');

      if (!toolBlocks.length || data.stop_reason === 'end_turn') {
        finalText = textBlocks.map(b => b.text).join('');
        break;
      }

      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: toolBlocks.map(b => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: `Search completed for: "${b.input?.query || ''}"`
        }))
      });
    }

    return res.json({ text: finalText });

  } catch(err) {
    console.error('Quick summary error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});


// ── PRIVATE COMPANY: VERIFY ENDPOINT ─────────────────────
// Step 1: Haiku does a quick search and returns 2-3 line confirmation
// of what company it found so user can verify before full research runs
app.post('/verify-company', async function(req, res) {

  const { companyName, websiteUrl } = req.body;
  if (!companyName) return res.status(400).json({ error: 'Missing company name' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const VERIFY_SYSTEM = `You are a company research assistant. Given a company name and optional website URL, do a quick web search to identify the company and return a brief 2-3 line confirmation of what you found.

Return ONLY a valid JSON object:
{
  "found": true | false,
  "companyName": "Full official company name as found",
  "confirmation": "2-3 sentences describing what the company does, where it is based, its approximate stage/size, and any other key identifying details that would help a user confirm this is the right company.",
  "website": "Website URL if found or confirmed"
}

If you cannot find any matching company, set found to false and explain briefly in confirmation.`;

  let messages = [{
    role: 'user',
    content: `Find and briefly describe this company: "${companyName}"${websiteUrl ? ` — Website: ${websiteUrl}` : ''}. Do a quick search and confirm what you found in 2-3 sentences.`
  }];

  let finalText = '';
  let rounds = 0;

  try {
    while (rounds < 2) {
      rounds++;
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 800,
          system: VERIFY_SYSTEM,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || `API error ${response.status}`);

      const content    = data.content || [];
      const toolBlocks = content.filter(b => b.type === 'tool_use');
      const textBlocks = content.filter(b => b.type === 'text');

      if (!toolBlocks.length || data.stop_reason === 'end_turn') {
        finalText = textBlocks.map(b => b.text).join('');
        break;
      }

      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: toolBlocks.map(b => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: `Search completed for: "${b.input?.query || ''}"`
        }))
      });
    }

    const clean = finalText.replace(/```json\s*/gi,'').replace(/```\s*/gi,'').trim();
    let parsed;
    try { parsed = JSON.parse(clean); }
    catch(e) {
      const m = clean.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : { found: false, confirmation: 'Could not identify company. Please try again.' };
    }

    // Strip any citation markup from confirmation text
    if (parsed.confirmation) {
      parsed.confirmation = parsed.confirmation
        .replace(/<cite[^>]*>/gi, '')
        .replace(/<\/cite>/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    return res.json(parsed);

  } catch(err) {
    console.error('Verify error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── PRIVATE COMPANY: FULL RESEARCH ENDPOINT ───────────────
// Step 2: Full deep research after user confirms the company
app.post('/angel-research', async function(req, res) {

  // Rate limit — deep research costs 2 points
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1').split(',')[0].trim();
  const rl = checkRateLimit(ip, 2);
  if (!rl.allowed) {
    return res.status(429).json({
      error: 'rate_limit',
      message: rl.message || 'Daily limit reached.',
      dayUsed: rl.dayUsed, weekUsed: rl.weekUsed,
      dayLimit: rl.dayLimit, weekLimit: rl.weekLimit
    });
  }

  const { companyName, websiteUrl } = req.body;
  if (!companyName) return res.status(400).json({ error: 'Missing company data' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const ANGEL_SYSTEM_TEXT = 'You are an expert startup and private company analyst. Your role is to provide objective, in-depth research and analysis of private and early-stage companies ONLY. Do NOT provide investment recommendations, verdicts to invest or pass, target returns, portfolio advice, or any opinion on whether someone should commit capital.\n\nResearch the company using credible, independent sources (company website, news articles, Crunchbase, LinkedIn, customer reviews, employee reviews, competitor sites, industry reports, etc.). Analyze the company across all dimensions and present findings objectively.\n\nReturn a single valid JSON object only — no markdown fencing, no preamble.\n\nReturn exactly this shape:\n{\n  "companyName": "Full official company name",\n  "website": "Website URL",\n  "stage": "Stage (e.g. Seed, Series A, Series B, Growth, Unknown)",\n  "hq": "Headquarters location",\n  "industry": "Industry / sector",\n  "executiveSummary": {\n    "snapshot": "One paragraph summarising what the company does, its stage, and market position",\n    "strengths": ["Strength 1 (1-3 sentences)", "Strength 2", "Strength 3"],\n    "concerns": ["Concern 1 (1-3 sentences)", "Concern 2", "Concern 3"],\n    "valuationContext": "Brief objective assessment of how the company is priced relative to peers and what current funding terms imply",\n    "confidence": "One paragraph on how confident you are in the analysis given data quality and completeness"\n  },\n  "scorecard": {\n    "businessModel": { "rating": "Weak|Moderate|Strong", "summary": "One sentence on revenue model quality and problem-solution fit" },\n    "marketOpportunity": { "rating": "Limited|Moderate|Large", "summary": "One sentence on market size and growth potential" },\n    "teamStrength": { "rating": "Weak|Moderate|Strong", "summary": "One sentence on founder-market fit and execution capability" },\n    "traction": { "rating": "Early|Developing|Strong", "summary": "One sentence on revenue, growth, and customer quality" },\n    "defensibility": { "rating": "Low|Moderate|High", "summary": "One sentence on moats, differentiation, and competitive position" },\n    "capitalEfficiency": { "rating": "Inefficient|Moderate|Efficient", "summary": "One sentence on burn rate, runway, and capital deployment quality" }\n  },\n  "sections": [\n    { "num": "01", "title": "Business Model & Problem", "subsections": [\n      { "heading": "Product & Service Overview", "content": "..." },\n      { "heading": "Target Customer & Problem", "content": "..." },\n      { "heading": "Revenue Model", "content": "..." },\n      { "heading": "Value Proposition & Differentiation", "content": "..." },\n      { "heading": "Growth & Revenue Trajectory", "content": "..." },\n      { "heading": "Unit Economics", "content": "..." }\n    ]},\n    { "num": "02", "title": "Market, Category & Competition", "subsections": [\n      { "heading": "Market Size & Structure", "content": "..." },\n      { "heading": "Competitive Landscape", "content": "..." },\n      { "heading": "Differentiation & Positioning", "content": "..." },\n      { "heading": "Regulation & Macro", "content": "..." }\n    ]},\n    { "num": "03", "title": "Product, Technology & Defensibility", "subsections": [\n      { "heading": "Technology Quality", "content": "..." },\n      { "heading": "AI Disruption & Platform Risk", "content": "..." },\n      { "heading": "Moats & Defensibility", "content": "..." },\n      { "heading": "Data Advantage", "content": "..." }\n    ]},\n    { "num": "04", "title": "Go-To-Market, Distribution & Traction", "subsections": [\n      { "heading": "GTM & Distribution Strategy", "content": "..." },\n      { "heading": "Traction & Growth Quality", "content": "..." },\n      { "heading": "Customer Behaviour & Cohorts", "content": "..." },\n      { "heading": "Customer Concentration & Switching Costs", "content": "..." }\n    ]},\n    { "num": "05", "title": "Durability, Pricing Power & Long-Term Position", "subsections": [\n      { "heading": "10-Year Defensibility", "content": "..." },\n      { "heading": "Pricing Power vs Commoditisation", "content": "..." },\n      { "heading": "Unique Opportunity & Timing", "content": "..." }\n    ]},\n    { "num": "06", "title": "Financial Health, Burn & Capital Efficiency", "subsections": [\n      { "heading": "Revenue Scale & Growth Rate", "content": "..." },\n      { "heading": "Burn Rate & Runway", "content": "..." },\n      { "heading": "Capital Efficiency vs Peers", "content": "..." }\n    ]},\n    { "num": "07", "title": "Pricing, Valuation & Funding Dynamics", "subsections": [\n      { "heading": "Relative Valuation", "content": "..." },\n      { "heading": "Current Round Terms", "content": "..." },\n      { "heading": "Future Funding Prospects", "content": "..." },\n      { "heading": "Timing", "content": "..." }\n    ]},\n    { "num": "08", "title": "Team, Leadership & Talent", "subsections": [\n      { "heading": "Founders Background & Founder-Market Fit", "content": "..." },\n      { "heading": "Execution Capability", "content": "..." },\n      { "heading": "Key Person Risk", "content": "..." },\n      { "heading": "Talent Attraction & Scaling", "content": "..." }\n    ]},\n    { "num": "09", "title": "Governance, Culture & Operating Model", "subsections": [\n      { "heading": "Governance", "content": "..." },\n      { "heading": "Culture", "content": "..." },\n      { "heading": "Operating Discipline", "content": "..." }\n    ]},\n    { "num": "10", "title": "Risk Mapping & Scenario Analysis", "subsections": [\n      { "heading": "Principal Risks", "content": "..." },\n      { "heading": "Bear Case", "content": "..." },\n      { "heading": "Base Case", "content": "..." },\n      { "heading": "Bull Case", "content": "..." }\n    ]},\n    { "num": "11", "title": "Exit Pathways & Liquidity", "subsections": [\n      { "heading": "Realistic Exit Options", "content": "..." },\n      { "heading": "Build vs Buy Analysis", "content": "..." },\n      { "heading": "Timeline to Liquidity", "content": "..." }\n    ]},\n    { "num": "12", "title": "Evidence Quality & Red Flags", "subsections": [\n      { "heading": "Evidence Strength", "content": "..." },\n      { "heading": "Red Flags", "content": "..." }\n    ]}\n  ]\n}\n\nUse web search to find REAL current data from credible sources. Be analytical, specific, and direct. Always return complete, valid JSON — never truncate mid-response.';
  const ANGEL_SYSTEM_WITH_CACHE = [
    { type: 'text', text: ANGEL_SYSTEM_TEXT, cache_control: { type: 'ephemeral' } }
  ];

  // Phase 1: Haiku gathers research data
  const HAIKU_GATHER = `You are a startup research assistant. Your job is to thoroughly search the web and gather comprehensive data about the requested private company. Search multiple times using different queries to collect:
- What the company does, its products/services, target customers
- Founding story, founders backgrounds, team size
- Revenue, growth metrics, funding raised, investors, valuation
- Business model, unit economics if available
- Key customers, partnerships, traction metrics
- Competitive landscape and positioning
- Any news, controversies, red flags, or notable milestones
- Employee/customer reviews and sentiment
- Technology stack and defensibility
- Exit potential and comparable companies

Search aggressively. When done output ALL findings as detailed structured prose — not JSON.`;

  let haikusMessages = [{
    role: 'user',
    content: `Research this private company thoroughly: "${companyName}"${websiteUrl ? ` (Website: ${websiteUrl})` : ''}. Search multiple times to gather all available data.`
  }];

  let researchSummary = '';
  let roundCount = 0;

  try {
    while (roundCount < 4) {
      roundCount++;
      console.log('Angel research round', roundCount);

      const hRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 8000,
          system: [{ type: 'text', text: HAIKU_GATHER, cache_control: { type: 'ephemeral' } }],
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: haikusMessages
        })
      });

      const hData = await hRes.json();
      if (!hRes.ok) throw new Error(hData.error?.message || `Haiku error ${hRes.status}`);

      const hContent    = hData.content || [];
      const hToolBlocks = hContent.filter(b => b.type === 'tool_use');
      const hTextBlocks = hContent.filter(b => b.type === 'text');

      if (!hToolBlocks.length || hData.stop_reason === 'end_turn') {
        researchSummary = hTextBlocks.map(b => b.text).join('');
        console.log('Haiku done. Summary length:', researchSummary.length);
        break;
      }

      haikusMessages.push({ role: 'assistant', content: hContent });
      haikusMessages.push({
        role: 'user',
        content: trimSearchResults(hToolBlocks.map(b => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: `Search completed for: "${b.input?.query || ''}"`
        })))
      });

      if (roundCount === 3) {
        haikusMessages.push({
          role: 'user',
          content: 'You have gathered enough data. Now write a comprehensive summary of ALL research findings with every metric, fact, and insight you found.'
        });
      }
    }

    if (!researchSummary) throw new Error('Research returned no data. Please try again.');

    // Phase 2: Sonnet writes the full report
    console.log('Sonnet compiling angel report...');

    const sRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        system: ANGEL_SYSTEM_WITH_CACHE,
        messages: [{
          role: 'user',
          content: `Using the following research data gathered about "${companyName}"${websiteUrl ? ` (${websiteUrl})` : ''}, compile a comprehensive analyst-grade research report and return it as the JSON object specified. Use ALL data provided.\n\nRESEARCH DATA:\n${researchSummary}`
        }]
      })
    });

    const sData = await sRes.json();
    if (!sRes.ok) throw new Error(sData.error?.message || `Sonnet error ${sRes.status}`);

    const finalText = (sData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    console.log('Angel report done. Length:', finalText.length);

    const repairedAngelText = repairJSON(finalText);
    return res.json({
      text: repairedAngelText,
      rateLimit: { used: rl.used, limit: rl.limit, remaining: rl.limit - rl.used }
    });

  } catch(err) {
    console.error('Angel research error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});


// ── QUICK SNAPSHOT ENDPOINT ───────────────────────────────
// 1 point, Haiku only, returns scorecard + exec summary only
// Fast (~30 seconds), no deep sections
app.post('/quick-snapshot', async function(req, res) {

  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1').split(',')[0].trim();
  const rl = checkRateLimit(ip, 1);

  if (!rl.allowed) {
    return res.status(429).json({
      error: 'rate_limit',
      message: rl.message || 'Limit reached.',
      dayUsed: rl.dayUsed, weekUsed: rl.weekUsed,
      dayLimit: rl.dayLimit, weekLimit: rl.weekLimit
    });
  }

  const { company } = req.body;
  if (!company || !company.name) return res.status(400).json({ error: 'Missing company data' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const SNAPSHOT_SYSTEM = `You are a financial research analyst. Do a quick analysis of the requested company using 1-2 targeted web searches. Return ONLY a valid JSON object, no markdown, no preamble.

Return exactly this shape:
{
  "companyName": "Full official company name",
  "ticker": "TICKER or N/A",
  "sector": "Sector",
  "exchange": "Exchange",
  "executiveSummary": {
    "business": "One key finding on core revenue model, market position, and cyclicality",
    "competitivePosition": "One key finding on moat strength or fragility",
    "financialHealth": "One key finding on earnings quality, margins, and returns",
    "balanceSheet": "One key finding on leverage position and appropriateness",
    "earningsQuality": "One key finding on reliability of reported earnings",
    "management": "One key finding on capital allocation track record and integrity",
    "valuation": "One key finding on where the stock sits relative to intrinsic value estimates",
    "risks": "The single most material risk to the analysis"
  },
  "scorecard": {
    "businessModel": { "rating": "Weak|Moderate|Strong", "summary": "One sentence on revenue model quality and unit economics" },
    "marketOpportunity": { "rating": "Limited|Moderate|Large", "summary": "One sentence on market size and growth potential" },
    "teamStrength": { "rating": "Weak|Moderate|Strong", "summary": "One sentence on management track record and execution quality" },
    "competition": { "rating": "Weak|Moderate|Strong", "summary": "One sentence on competitive positioning, moat, and market share vs peers" },
    "valuation": { "rating": "Cheap|Fair|Expensive", "summary": "One sentence on P/E, P/S vs peers and historical range" },
    "fundingAndFinancials": { "rating": "Weak|Moderate|Strong", "summary": "One sentence on balance sheet health, FCF, and financial resilience" }
  }
}`;

  const systemWithCache = [
    { type: 'text', text: SNAPSHOT_SYSTEM, cache_control: { type: 'ephemeral' } }
  ];

  let messages = [{
    role: 'user',
    content: `Quick snapshot for: ${company.name} (Ticker: ${company.ticker}, Exchange: ${company.exchange}). Do 1-2 targeted searches and return the JSON snapshot.`
  }];

  let finalText = '';
  let rounds = 0;

  try {
    while (rounds < 3) {
      rounds++;
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4000,
          system: systemWithCache,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || `API error ${response.status}`);

      const content  = data.content || [];
      const toolBlocks = content.filter(b => b.type === 'tool_use');
      const textBlocks = content.filter(b => b.type === 'text');

      if (!toolBlocks.length || data.stop_reason === 'end_turn') {
        finalText = textBlocks.map(b => b.text).join('');
        break;
      }

      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: toolBlocks.map(b => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: `Search completed for: "${b.input?.query || ''}"`
        }))
      });
    }

    const repairedText = repairJSON(finalText);
    return res.json({
      text: repairedText,
      rateLimit: { dayUsed: rl.dayUsed, weekUsed: rl.weekUsed, dayLimit: rl.dayLimit, weekLimit: rl.weekLimit }
    });

  } catch(err) {
    console.error('Quick snapshot error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── SUPABASE AUTH PROXY ──────────────────────────────────
// Uses node-fetch directly — no supabase-js SDK to avoid DNS init issues
const SUPABASE_URL      = 'https://zovnmpwubzyvhaxheji.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpvdm5tcHd1Ynp5eXZoYXhoZWppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5ODEyMDIsImV4cCI6MjA5NDU1NzIwMn0.MEQSvxH45ubrgddkcnm5g6Cxf_gNc_dVf58HCzh3xx8';

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
}

async function sbRequest(path, method, body, token) {
  const headers = {
    'Content-Type':  'application/json',
    'apikey':        getServiceKey(),
    'Authorization': 'Bearer ' + (token || getServiceKey())
  };
  const res = await fetch(SUPABASE_URL + path, {
    method:  method || 'GET',
    headers: headers,
    body:    body ? JSON.stringify(body) : undefined,
    agent:   ipv6Agent
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch(e) { return { ok: res.ok, status: res.status, data: { error: text } }; }
}

// Sign Up
app.post('/auth/signup', authRateLimit, async function(req, res) {
  try {
    const { email, password, fullName } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const r = await sbRequest('/auth/v1/signup', 'POST', {
      email, password,
      data: { full_name: fullName || '' }
    });
    if (!r.ok) return res.status(400).json({ error: r.data.msg || r.data.error_description || r.data.error || 'Signup failed' });
    return res.json({ user: r.data.user, message: 'Account created! Check your email to confirm, then sign in.' });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
});

// Sign In — returns tokens in response body (stored in localStorage by client)
app.post('/auth/signin', authRateLimit, async function(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const r = await sbRequest('/auth/v1/token?grant_type=password', 'POST', { email, password });
    if (!r.ok) return res.status(401).json({ error: r.data.error_description || r.data.msg || r.data.error || 'Sign in failed' });
    return res.json({
      user:          r.data.user,
      access_token:  r.data.access_token,
      refresh_token: r.data.refresh_token
    });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
});

// Sign Out — client clears localStorage, we just confirm
app.post('/auth/signout', async function(req, res) {
  try {
    const token = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
    if (token) {
      try { await sbRequest('/auth/v1/logout', 'POST', {}, token); } catch(e) {}
    }
    return res.json({ success: true });
  } catch(err) {
    return res.json({ success: true });
  }
});

// Get session / current user — token passed in Authorization header
app.get('/auth/session', async function(req, res) {
  try {
    const token = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
    if (!token) return res.json({ user: null });

    const r = await sbRequest('/auth/v1/user', 'GET', null, token);
    if (!r.ok || !r.data.id) return res.json({ user: null });
    return res.json({ user: r.data });
  } catch(err) {
    return res.json({ user: null });
  }
});

// Refresh token
app.post('/auth/refresh', async function(req, res) {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.json({ user: null });

    const r = await sbRequest('/auth/v1/token?grant_type=refresh_token', 'POST', { refresh_token });
    if (!r.ok) return res.json({ user: null });
    return res.json({
      user:          r.data.user,
      access_token:  r.data.access_token,
      refresh_token: r.data.refresh_token
    });
  } catch(err) {
    return res.json({ user: null });
  }
});

// Supabase DB proxy — for saving reports and usage
app.post('/db/:table', async function(req, res) {
  try {
    const token = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const { method, body, filters } = req.body;
    const table = req.params.table;

    // Use Supabase REST API directly
    let url = SUPABASE_URL + '/rest/v1/' + table;
    const dbMethod = method || 'GET';
    if (filters) url += '?' + filters;

    const headers = {
      'Content-Type':  'application/json',
      'apikey':        getServiceKey(),
      'Authorization': 'Bearer ' + token,
      'Prefer':        dbMethod === 'POST' ? 'return=representation' : dbMethod === 'PATCH' ? 'return=representation' : ''
    };

    const r = await fetch(url, {
      method:  dbMethod,
      headers: headers,
      body:    body ? JSON.stringify(body) : undefined,
      agent:   ipv6Agent
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch(e) { data = text; }

    if (!r.ok) return res.status(r.status).json({ error: typeof data === 'object' ? (data.message || data.error) : data });
    return res.json(data);
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── START SERVER ──────────────────────────────────────────
app.listen(PORT, function() {
  console.log('Candara server running on port ' + PORT);
});
