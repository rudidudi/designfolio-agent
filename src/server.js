import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3001;

const client = new Anthropic();

// In-memory job storage (jobs expire after 1 hour)
const jobs = new Map();

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
}

const SYSTEM_PROMPT = `You are a Figma landing page designer. You generate Figma Plugin API JavaScript code to create landing pages.

When given a prompt, generate a SINGLE complete JavaScript code block that creates a full landing page in Figma.

DESIGN RULES:
- Create a top-level frame sized 1440 wide, height auto (use HUG).
- Use auto-layout extensively for responsive structure.
- Load ALL fonts before using them: await figma.loadFontAsync({ family: "Inter", style: "Regular" }) etc.
- Set fills using RGB 0-1 range (not 0-255).
- For text: create with figma.createText(), set fontName BEFORE setting characters.
- Fills/strokes are read-only arrays — clone, modify, reassign.
- Set layoutSizingHorizontal/Vertical = 'FILL' AFTER parent.appendChild(child).
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

// Generate landing page and store as a job
app.post("/generate", async (req, res) => {
  const { prompt, api_key } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  console.log(`[generate] Received prompt: "${prompt.slice(0, 100)}..." (user key: ${api_key ? "yes" : "no"})`);

  try {
    // Use user's API key if provided, otherwise fall back to server key
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

    // Store the job
    cleanExpiredJobs();
    const jobCode = generateJobCode();
    jobs.set(jobCode, {
      code: generatedCode,
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
