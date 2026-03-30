import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3001;

const client = new Anthropic();

// In-memory job storage (jobs expire after 1 hour)
const jobs = new Map();

// In-memory paired Figma MCP tokens (expire after 1 hour)
const pairedTokens = new Map();

function generateJobCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function cleanExpiredJobs() {
  const now = Date.now();
  for (const [code, job] of jobs) {
    if (now - job.created_at > 3600000) {
      jobs.delete(code);
    }
  }
  for (const [code, token] of pairedTokens) {
    if (now - token.created_at > 3600000) {
      pairedTokens.delete(code);
    }
  }
}

// Strip markdown fences and leading/trailing whitespace from generated code
function cleanGeneratedCode(code) {
  let cleaned = code.trim();
  cleaned = cleaned.replace(/^```(?:javascript|js)?\s*\n?/, "");
  cleaned = cleaned.replace(/\n?```\s*$/, "");
  return cleaned.trim();
}

const SYSTEM_PROMPT = `You are a Figma landing page designer. You generate Figma Plugin API JavaScript code to create landing pages.

When given a prompt, generate a SINGLE complete JavaScript code block that creates a full landing page in Figma.

DESIGN RULES:
- Create a top-level frame sized 1440 wide, height auto (use HUG).
- Use auto-layout extensively for responsive structure.
- Load ALL fonts before using them: await figma.loadFontAsync({ family: "Inter", style: "Regular" }) etc.
- Font style names MUST have spaces: "Semi Bold" (NOT "SemiBold"), "Extra Bold" (NOT "ExtraBold"), "Extra Light" (NOT "ExtraLight").
- Set fills using RGB 0-1 range (not 0-255). NEVER include "a" (alpha) in the color object. For transparency, use "opacity" on the fill object instead: { type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 0.5 }.
- For text: create with figma.createText(), set fontName BEFORE setting characters. NEVER create a bare figma.createText() without immediately setting fontName and characters on it.
- Fills/strokes are read-only arrays — clone, modify, reassign.
- Set layoutSizingHorizontal/Vertical = 'FILL' AFTER parent.appendChild(child).
- NEVER use figma.createText() as a spacer or placeholder — use a frame with fixed height instead.
- Structure the page with: Header/Nav, Hero section, Features/Benefits, CTA section, Footer.
- Use consistent spacing (16, 24, 32, 48, 64, 80 px).
- Make the design modern, clean, and professional with realistic content.
- End with: figma.currentPage.appendChild(frame); figma.viewport.scrollAndZoomIntoView([frame]);
- Return all created node IDs.
- Use top-level await (code is auto-wrapped in async context).
- Do NOT use figma.notify() or console.log() for output — use return.
- Do NOT wrap code in an async IIFE.

Output ONLY the JavaScript code. No markdown fences, no explanation.`;

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Generate landing page via Plugin mode (Anthropic SDK → Figma Plugin API code)
app.post("/generate", async (req, res) => {
  const { prompt, api_key } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  console.log(`[generate] Received prompt: "${prompt.slice(0, 100)}..." (user key: ${api_key ? "yes" : "no"})`);

  try {
    const anthropic = api_key ? new Anthropic({ apiKey: api_key }) : client;

    console.log("[generate] Calling Claude API to generate design code...");

    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 64000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Create a Figma landing page with this description:\n\n${prompt}`,
        },
      ],
    });

    const response = await stream.finalMessage();

    const textBlock = response.content.find((b) => b.type === "text");
    const generatedCode = textBlock?.text;

    if (!generatedCode) {
      return res.status(500).json({ error: "No design code generated" });
    }

    const cleanedCode = cleanGeneratedCode(generatedCode);

    cleanExpiredJobs();
    const jobCode = generateJobCode();
    jobs.set(jobCode, {
      code: cleanedCode,
      prompt: prompt.slice(0, 200),
      created_at: Date.now(),
      status: "ready",
    });

    console.log(`[generate] Job ${jobCode} created (${generatedCode.length} chars)`);

    res.json({
      success: true,
      job_code: jobCode,
      message: `Design generated! Open the Designfolio plugin in Figma and enter code: ${jobCode}`,
    });
  } catch (error) {
    console.error("[generate] Error:", error);
    res.status(500).json({
      error: error.message || "Generation failed",
    });
  }
});

// Pair a Figma MCP token from Claude Code CLI
app.post("/pair", (req, res) => {
  const { access_token, refresh_token, expires_at, client_id, client_secret } = req.body;

  if (!access_token) {
    return res.status(400).json({ error: "access_token is required" });
  }

  cleanExpiredJobs(); // reuse cleanup cycle

  const pairCode = generateJobCode();
  pairedTokens.set(pairCode, {
    access_token,
    refresh_token,
    expires_at,
    client_id,
    client_secret,
    created_at: Date.now(),
  });

  console.log(`[pair] Token paired with code ${pairCode}`);

  res.json({ success: true, pair_code: pairCode });
});

// Verify a pair code exists (called by frontend)
app.get("/pair/:code", (req, res) => {
  const code = req.params.code.toUpperCase();
  const token = pairedTokens.get(code);

  if (!token) {
    return res.status(404).json({ error: "Pair code not found or expired" });
  }

  // Don't expose the actual token, just confirm it exists
  res.json({
    success: true,
    has_refresh: !!token.refresh_token,
    expires_at: token.expires_at,
  });
});

// Generate landing page via MCP mode (Agent SDK → Figma MCP → directly in Figma)
app.post("/generate-mcp", async (req, res) => {
  const { prompt, figma_access_token, pair_code, api_key } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  // Resolve the Figma token: either directly provided or via pair code
  let figmaToken = figma_access_token;

  if (!figmaToken && pair_code) {
    const paired = pairedTokens.get(pair_code.toUpperCase());
    if (!paired) {
      return res.status(404).json({ error: "Pair code not found or expired. Run 'npx designfolio-connect' again." });
    }
    figmaToken = paired.access_token;
  }

  if (!figmaToken) {
    return res.status(400).json({ error: "Figma access token or pair code is required for MCP generation" });
  }

  console.log(`[generate-mcp] Received prompt: "${prompt.slice(0, 100)}..." (user key: ${api_key ? "yes" : "no"}, pair: ${pair_code ? "yes" : "no"})`);

  try {
    // Set API key for the Agent SDK (uses ANTHROPIC_API_KEY env var by default)
    if (api_key) {
      process.env.ANTHROPIC_API_KEY = api_key;
    }

    let result = null;
    let error = null;

    for await (const message of query({
      prompt: `Create a complete, professional landing page in Figma with this description:\n\n${prompt}\n\nUse the Figma MCP tools to create the design. Create a new file called "Designfolio - Landing Page" and build a full landing page with: Header/Nav, Hero section, Features/Benefits section, CTA section, and Footer. Use modern design with clean typography, consistent spacing, and a professional color scheme. Make it 1440px wide.`,
      options: {
        mcpServers: {
          figma: {
            type: "http",
            url: "https://mcp.figma.com/mcp",
            headers: {
              Authorization: `Bearer ${figmaToken}`,
            },
          },
        },
        allowedTools: ["mcp__figma__*"],
      },
    })) {
      // Log MCP connection status
      if (message.type === "system" && message.subtype === "init") {
        console.log("[generate-mcp] MCP servers:", JSON.stringify(message.mcp_servers));
        const failed = (message.mcp_servers || []).filter((s) => s.status !== "connected");
        if (failed.length > 0) {
          console.error("[generate-mcp] Failed MCP connections:", failed);
          error = `Failed to connect to Figma MCP: ${JSON.stringify(failed)}`;
        }
      }

      // Log tool calls
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === "tool_use" && block.name?.startsWith("mcp__")) {
            console.log(`[generate-mcp] Tool call: ${block.name}`);
          }
        }
      }

      // Capture final result
      if (message.type === "result") {
        if (message.subtype === "success") {
          result = message.result;
        } else {
          error = message.result || "Agent execution failed";
        }
      }
    }

    // Restore server API key if we changed it
    if (api_key) {
      process.env.ANTHROPIC_API_KEY = process.env.SERVER_ANTHROPIC_API_KEY || "";
    }

    if (error) {
      console.error("[generate-mcp] Error:", error);
      return res.status(500).json({ error });
    }

    console.log("[generate-mcp] Design created successfully via MCP");

    res.json({
      success: true,
      message: "Landing page created directly in your Figma account via MCP!",
      result,
    });
  } catch (err) {
    console.error("[generate-mcp] Error:", err);
    res.status(500).json({
      error: err.message || "MCP generation failed",
    });
  }
});

// Retrieve job code (called by Figma plugin)
app.get("/job/:code", (req, res) => {
  const jobCode = req.params.code.toUpperCase();
  const job = jobs.get(jobCode);

  if (!job) {
    return res.status(404).json({ error: "Job not found or expired" });
  }

  res.json({
    success: true,
    code: job.code,
    prompt: job.prompt,
  });
});

app.listen(PORT, () => {
  console.log(`Designfolio Agent running on port ${PORT}`);
});
