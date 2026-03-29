import express from "express";
import cors from "cors";
import { query } from "@anthropic-ai/claude-agent-sdk";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

const SYSTEM_PROMPT = `You are a Figma landing page designer. You have access to Figma via MCP tools.

When given a prompt describing a landing page, you MUST:

1. First call create_new_file to create a new Figma design file. Use planKey from the user's message.
2. Then use the use_figma tool to execute Figma Plugin API JavaScript code that creates the landing page.

DESIGN RULES:
- Create a top-level frame sized 1440x900 (desktop).
- Use auto-layout extensively.
- Load fonts before using them: await figma.loadFontAsync({ family: "Inter", style: "Regular" }) etc.
- Set fills using RGB 0-1 range.
- For text: create with figma.createText(), set fontName BEFORE characters.
- Structure: Header/Nav, Hero section, Features/Benefits, Social proof or CTA, Footer.
- Use consistent spacing (16, 24, 32, 48, 64, 80 px).
- Make the design modern, clean, and professional.
- After creating all elements, call: figma.currentPage.appendChild(frame); figma.viewport.scrollAndZoomIntoView([frame]);
- Return created node IDs.

IMPORTANT: Always pass skillNames: "figma-use" when calling use_figma.`;

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

  if (!plan_key) {
    return res.status(400).json({ error: "plan_key is required" });
  }

  console.log(`[generate] Received prompt: "${prompt.slice(0, 100)}..."`);

  try {
    let result = null;
    let figmaFileUrl = null;

    const userMessage = `Create a Figma landing page with this description:

${prompt}

Use planKey: "${plan_key}" when creating the new file.
Name the file based on what the user is describing.`;

    for await (const message of query({
      prompt: userMessage,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        model: "claude-sonnet-4-6",
        maxTurns: 15,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        allowedTools: [],
        mcpServers: {
          figma: {
            type: "http",
            url: "https://mcp.figma.com/mcp",
          },
        },
      },
    })) {
      if ("result" in message) {
        result = message.result;
        console.log(`[generate] Agent completed. Result length: ${result?.length || 0}`);
      }

      // Look for figma file URLs in any message content
      if (message.type === "assistant") {
        const text = JSON.stringify(message);
        const urlMatch = text.match(/https:\/\/www\.figma\.com\/design\/[^\s"]+/);
        if (urlMatch) {
          figmaFileUrl = urlMatch[0];
        }
      }
    }

    res.json({
      success: true,
      result,
      figma_file_url: figmaFileUrl,
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
