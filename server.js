// server.js — Candara Research Backend
// Runs on Render.com with no timeout limits
// Holds API key securely as environment variable

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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

Use web search to find REAL current data. Replace all metric values with actual figures. Be analytical, specific, and direct. Always return complete, valid JSON — never truncate mid-response.`;

// ── IN-MEMORY RATE LIMIT ──────────────────────────────────
const rateLimitStore = {};
const DAILY_LIMIT   = 3;

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function checkRateLimit(ip) {
  const key = ip + ':' + getTodayKey();
  if (!rateLimitStore[key]) rateLimitStore[key] = 0;
  if (rateLimitStore[key] >= DAILY_LIMIT) {
    return { allowed: false, used: rateLimitStore[key], limit: DAILY_LIMIT };
  }
  rateLimitStore[key]++;
  return { allowed: true, used: rateLimitStore[key], limit: DAILY_LIMIT };
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
  const rl = checkRateLimit(ip);

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

  // ── FULL AGENTIC LOOP — no timeout pressure ───────────
  const MAX_ROUNDS = 5;

  const systemWithCache = [
    {
      type:          'text',
      text:          SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral' }
    }
  ];

  let messages = [
    {
      role:    'user',
      content: `Generate a comprehensive deep-research report for: ${company.name} (Ticker: ${company.ticker}, Exchange: ${company.exchange}). Use web search to find current financial data, recent earnings, actual metrics, analyst estimates, and valuation data. Return only the JSON report object with real figures.`
    }
  ];

  let finalText  = '';
  let roundCount = 0;

  try {
    while (roundCount < MAX_ROUNDS) {
      roundCount++;
      console.log('Research round', roundCount, 'of', MAX_ROUNDS);

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta':    'prompt-caching-2024-07-31'
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-6',
          max_tokens: 32000,
          system:     systemWithCache,
          tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
          messages:   messages
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error && data.error.message
            ? data.error.message
            : `Anthropic API error ${response.status}`
        );
      }

      const content    = data.content || [];
      const toolBlocks = content.filter(b => b.type === 'tool_use');
      const textBlocks = content.filter(b => b.type === 'text');

      // Done — no more tool calls
      if (!toolBlocks.length || data.stop_reason === 'end_turn') {
        finalText = textBlocks.map(b => b.text).join('');
        break;
      }

      // Add assistant turn
      messages.push({ role: 'assistant', content });

      // Build trimmed tool results
      const toolResults = toolBlocks.map(block => ({
        type:        'tool_result',
        tool_use_id: block.id,
        content:     `Search completed for: "${block.input && block.input.query ? block.input.query : ''}"`
      }));

      messages.push({
        role:    'user',
        content: trimSearchResults(toolResults)
      });

      // On final round, ask model to compile
      if (roundCount === MAX_ROUNDS - 1) {
        messages.push({
          role:    'user',
          content: 'You have completed your research. Now compile and return the complete JSON report based on everything you have found.'
        });
      }
    }

    if (!finalText) {
      throw new Error('Research completed but no report was returned. Please try again.');
    }

    return res.json({
      text:      finalText,
      rateLimit: { used: rl.used, limit: rl.limit, remaining: rl.limit - rl.used },
      rounds:    roundCount
    });

  } catch(err) {
    console.error('Report generation error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── START SERVER ──────────────────────────────────────────
app.listen(PORT, function() {
  console.log('Candara server running on port ' + PORT);
});
