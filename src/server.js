import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3001;
const FIGMA_MCP_TOKEN = process.env.FIGMA_MCP_TOKEN;

const client = new Anthropic();

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

// Generate landing page
app.post("/generate", async (req, res) => {
  const { prompt, plan_key } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  console.log(`[generate] Received prompt: "${prompt.slice(0, 100)}..."`);

  try {
    // Step 1: Generate the Figma Plugin API code using Claude
    console.log("[generate] Calling Claude API to generate design code...");

    const stream = client.messages.stream({
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

    console.log(`[generate] Code generated (${generatedCode.length} chars)`);

    // Step 2: Create a new Figma file via MCP
    let fileKey = null;
    let fileUrl = null;

    if (FIGMA_MCP_TOKEN) {
      try {
        console.log("[generate] Creating Figma file via REST API...");

        // Create file using Figma REST API
        const createResponse = await fetch("https://api.figma.com/v1/files", {
          method: "POST",
          headers: {
            "X-Figma-Token": FIGMA_MCP_TOKEN,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: `Landing Page - ${prompt.slice(0, 50)}`,
          }),
        });

        if (createResponse.ok) {
          const fileData = await createResponse.json();
          fileKey = fileData.key;
          fileUrl = `https://www.figma.com/design/${fileKey}`;
          console.log(`[generate] File created: ${fileUrl}`);
        } else {
          console.log(`[generate] Could not create file: ${createResponse.status}`);
        }
      } catch (err) {
        console.log(`[generate] File creation error: ${err.message}`);
      }
    }

    res.json({
      success: true,
      generated_code: generatedCode,
      figma_file_url: fileUrl,
      figma_file_key: fileKey,
      message: "Landing page design generated successfully. The Plugin API code is ready for execution in Figma.",
    });
  } catch (error) {
    console.error("[generate] Error:", error);
    res.status(500).json({
      error: error.message || "Generation failed",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Designfolio Agent running on port ${PORT}`);
});
