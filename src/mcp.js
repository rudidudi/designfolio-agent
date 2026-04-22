/**
 * MCP server for Figma Make's custom connector.
 *
 * Transport: Streamable HTTP (stateless). Figma Make calls our /mcp endpoint
 * with a JSON-RPC POST; we spin up a fresh transport per request, register
 * our tools, dispatch, and close. Stateless is simplest for a stateless
 * tool surface.
 *
 * Auth: Bearer token issued by src/oauth.js.
 *
 * Tools (v1):
 *   - design_landing_page(prompt): returns a structured JSON design spec
 *     that Figma Make can translate into frames.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";

import { validateBearer } from "./oauth.js";

// One shared Anthropic client; matches the style of server.js.
const anthropic = new Anthropic();

// --- System prompt for the spec-generating tool ----------------------------

const DESIGN_SPEC_SYSTEM = `You are a landing-page design planner. Given a prompt describing a landing page, return a structured JSON spec that a design tool (Figma Make) can render.

Output ONLY valid JSON. No markdown, no commentary. Conform to this shape:

{
  "meta": {
    "title": "string — page title",
    "tagline": "string — one-line value prop",
    "industry": "string",
    "tone": "string — e.g. minimal, playful, enterprise"
  },
  "tokens": {
    "colors": {
      "background": "#hex",
      "surface": "#hex",
      "primary": "#hex",
      "primary_text": "#hex",
      "text": "#hex",
      "muted_text": "#hex",
      "border": "#hex"
    },
    "typography": {
      "heading_family": "string — Google Fonts name",
      "body_family": "string — Google Fonts name"
    },
    "spacing_scale": [4, 8, 12, 16, 24, 32, 48, 64, 96],
    "radius": {"sm": 6, "md": 12, "lg": 20}
  },
  "sections": [
    {
      "type": "nav|hero|features|social_proof|pricing|testimonials|faq|cta|footer",
      "content": { /* shape depends on type; include realistic copy */ }
    }
  ]
}

Always include sections in this order: nav, hero, features (3–6 items), social_proof, pricing (2–3 tiers), testimonials (2–3), cta, footer. Generate realistic, specific copy — never lorem ipsum.`;

// --- Tool handler: design_landing_page -------------------------------------

async function designLandingPage({ prompt }) {
  // Figma Make's MCP client times out tool calls around ~30s. The spec
  // itself rarely exceeds ~2.5k output tokens, so cap generous but tight
  // and log timing so we can see where we stand on latency.
  const t0 = Date.now();
  console.log(`[mcp] design_landing_page: start (prompt=${prompt.slice(0, 60)}…)`);

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 3000,
    system: DESIGN_SPEC_SYSTEM,
    messages: [{ role: "user", content: `Generate a landing page design spec for:\n\n${prompt}` }],
  });

  const elapsed = Date.now() - t0;
  const textBlock = message.content.find((b) => b.type === "text");
  const raw = textBlock?.text ?? "";
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  console.log(`[mcp] design_landing_page: done in ${elapsed}ms, ${cleaned.length} chars, stop=${message.stop_reason}`);

  // Validate the model returned JSON — if not, fall back to raw text so
  // Figma Make at least sees the error.
  try {
    JSON.parse(cleaned);
  } catch (err) {
    return {
      content: [{
        type: "text",
        text: `Failed to produce valid JSON spec. Raw model output:\n\n${raw}`,
      }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: cleaned }],
  };
}

// --- Server factory --------------------------------------------------------

function buildMcpServer() {
  const server = new McpServer(
    { name: "designfolio", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "design_landing_page",
    {
      title: "Design a landing page",
      description:
        "Produces a structured JSON spec for a landing page (tokens, sections, realistic copy) that Figma Make can translate into frames. Call this when the user asks for a landing page, marketing site, or product page.",
      inputSchema: {
        prompt: z
          .string()
          .min(10)
          .describe("Natural-language description of the landing page, including target industry, audience, value prop, and any style preferences."),
      },
    },
    designLandingPage,
  );

  return server;
}

// --- Express route handler -------------------------------------------------

/**
 * Handles POST /mcp. Stateless — we build a fresh transport per request,
 * handle it, then tear down. Works because our tools have no session state.
 */
export async function handleMcpRequest(req, res) {
  // Auth: bearer token must validate against oauth.js store
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;

  if (!validateBearer(token)) {
    // Point clients at the protected-resource metadata per MCP auth spec
    // (2025-06-18 revision) so they can discover the authorization server.
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const scheme = /^(localhost|127\.|::1|\[::1\])/.test(host || "") ? proto : "https";
    const metadataUrl = `${scheme}://${host}/.well-known/oauth-protected-resource`;
    res.setHeader(
      "WWW-Authenticate",
      `Bearer realm="mcp", error="invalid_token", resource_metadata="${metadataUrl}"`,
    );
    return res.status(401).json({ error: "invalid_token" });
  }

  let server;
  let transport;
  try {
    server = buildMcpServer();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    // Clean up when the client disconnects.
    res.on("close", () => {
      transport?.close().catch(() => {});
      server?.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] Handler error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal_error", message: err.message });
    }
    transport?.close().catch(() => {});
    server?.close().catch(() => {});
  }
}

/**
 * GET /mcp — Streamable HTTP also uses GET for the server-initiated
 * notification stream. Forward to the same handler.
 */
export async function handleMcpGet(req, res) {
  return handleMcpRequest(req, res);
}
