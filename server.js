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
const DAILY_LIMIT   = 2;

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
    console.log('Sonnet done. Report length:', finalText.length);

    if (!finalText) {
      throw new Error('Report compilation returned empty. Please try again.');
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
