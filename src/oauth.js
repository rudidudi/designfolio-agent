/**
 * OAuth 2.0 Authorization Code provider for Figma Make's custom MCP connector.
 *
 * Figma Make's "OAuth with client credentials" flow per
 * https://help.figma.com/hc/en-us/articles/38147204302743 — the user pastes a
 * pre-registered client_id + client_secret (from env) into Figma Make's
 * Advanced settings. The redirect URI is fixed at
 * https://www.figma.com/oauth/mcp/callback.
 *
 * We implement only what the spec needs:
 *   GET  /oauth/authorize  — consent screen (renders HTML)
 *   POST /oauth/authorize  — user clicks "Approve", we issue a code + redirect
 *   POST /oauth/token      — exchange code for bearer token
 *
 * Storage is in-memory (Maps). Restarts wipe sessions. Fine for MVP; the user
 * just re-auths in Figma Make. Move to a DB when there are real users.
 */

import crypto from "crypto";

// --- Config from env --------------------------------------------------------

const CLIENT_ID = process.env.MCP_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.MCP_OAUTH_CLIENT_SECRET;
const FIGMA_CALLBACK = "https://www.figma.com/oauth/mcp/callback";

// Code + token lifetimes
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// --- In-memory stores -------------------------------------------------------

/** code -> { redirect_uri, state, issued_at } */
const authCodes = new Map();

/** access_token -> { issued_at } */
const accessTokens = new Map();

function sweep() {
  const now = Date.now();
  for (const [code, meta] of authCodes) {
    if (now - meta.issued_at > CODE_TTL_MS) authCodes.delete(code);
  }
  for (const [tok, meta] of accessTokens) {
    if (now - meta.issued_at > TOKEN_TTL_MS) accessTokens.delete(tok);
  }
}

// --- Config guard -----------------------------------------------------------

export function assertOAuthConfigured() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "MCP OAuth not configured. Set MCP_OAUTH_CLIENT_ID and MCP_OAUTH_CLIENT_SECRET env vars.",
    );
  }
}

// --- Route handlers ---------------------------------------------------------

/**
 * GET /oauth/authorize
 * Query params: client_id, redirect_uri, response_type=code, state, scope?
 * Renders an HTML consent page. User clicks Approve -> POST to same URL.
 */
export function getAuthorize(req, res) {
  const { client_id, redirect_uri, response_type, state, scope } = req.query;

  if (response_type !== "code") {
    return res.status(400).json({ error: "unsupported_response_type" });
  }
  if (client_id !== CLIENT_ID) {
    return res.status(400).json({ error: "invalid_client" });
  }
  if (redirect_uri !== FIGMA_CALLBACK) {
    return res.status(400).json({
      error: "invalid_redirect_uri",
      error_description: `Expected ${FIGMA_CALLBACK}`,
    });
  }

  // Minimal consent screen. No branding fanciness; we can style later.
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize Figma Make — Designfolio</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0b0f; color: #e8e8ea; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #15151b; border: 1px solid #24242c; border-radius: 16px; padding: 32px; max-width: 440px; width: 100%; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
    h1 { margin: 0 0 8px; font-size: 20px; font-weight: 700; }
    p { margin: 0 0 20px; color: #9b9ba3; font-size: 14px; line-height: 1.5; }
    ul { margin: 0 0 24px; padding-left: 18px; color: #c9c9d1; font-size: 13px; }
    li { margin-bottom: 6px; }
    form { display: flex; gap: 8px; }
    button { flex: 1; padding: 11px 16px; border-radius: 10px; border: 0; font-size: 14px; font-weight: 600; cursor: pointer; }
    .approve { background: #A259FF; color: #fff; }
    .approve:hover { background: #8B3FE0; }
    .deny { background: #24242c; color: #e8e8ea; }
    .deny:hover { background: #2e2e38; }
    .tag { display: inline-block; background: #A259FF1a; color: #A259FF; font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 999px; margin-bottom: 16px; text-transform: uppercase; letter-spacing: .04em; }
  </style>
</head>
<body>
  <div class="card">
    <span class="tag">Designfolio MCP</span>
    <h1>Authorize Figma Make</h1>
    <p>Figma Make is requesting permission to use Designfolio tools on your behalf.</p>
    <ul>
      <li>Generate landing-page design specs</li>
      <li>Return design tokens and templates</li>
    </ul>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(client_id)}" />
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}" />
      <input type="hidden" name="state" value="${escapeHtml(state || "")}" />
      <input type="hidden" name="scope" value="${escapeHtml(scope || "")}" />
      <button type="submit" name="decision" value="deny" class="deny">Deny</button>
      <button type="submit" name="decision" value="approve" class="approve">Approve</button>
    </form>
  </div>
</body>
</html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
}

/**
 * POST /oauth/authorize
 * Body: client_id, redirect_uri, state, decision ("approve"|"deny")
 * If approved: redirects to redirect_uri?code=<code>&state=<state>
 * If denied:   redirects to redirect_uri?error=access_denied&state=<state>
 */
export function postAuthorize(req, res) {
  const { client_id, redirect_uri, state, decision } = req.body;

  if (client_id !== CLIENT_ID || redirect_uri !== FIGMA_CALLBACK) {
    return res.status(400).send("invalid_request");
  }

  const params = new URLSearchParams();
  if (state) params.set("state", state);

  if (decision !== "approve") {
    params.set("error", "access_denied");
    return res.redirect(`${redirect_uri}?${params.toString()}`);
  }

  sweep();
  const code = crypto.randomBytes(32).toString("base64url");
  authCodes.set(code, {
    redirect_uri,
    state: state || null,
    issued_at: Date.now(),
  });

  params.set("code", code);
  res.redirect(`${redirect_uri}?${params.toString()}`);
}

/**
 * POST /oauth/token
 * Accepts either application/x-www-form-urlencoded OR JSON.
 * Body: grant_type=authorization_code, code, redirect_uri, client_id, client_secret
 * (client creds can also come via Basic auth header)
 */
export function postToken(req, res) {
  sweep();

  const body = req.body || {};
  // Support Basic auth for client creds per RFC 6749 §2.3.1
  const basic = parseBasicAuth(req.headers.authorization);
  const clientId = basic?.user || body.client_id;
  const clientSecret = basic?.pass || body.client_secret;

  if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET) {
    return res.status(401).json({ error: "invalid_client" });
  }

  // Two-legged flow: Figma Make server-to-server exchange. No user browser,
  // no code. Creds already validated above, so we just issue a bearer.
  if (body.grant_type === "client_credentials") {
    const accessToken = crypto.randomBytes(32).toString("base64url");
    accessTokens.set(accessToken, { issued_at: Date.now() });
    return res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(TOKEN_TTL_MS / 1000),
    });
  }

  // Three-legged flow: browser redirect through /authorize → code → here.
  if (body.grant_type === "authorization_code") {
    const record = authCodes.get(body.code);
    if (!record) {
      return res.status(400).json({ error: "invalid_grant", error_description: "code not found or expired" });
    }
    // Single-use codes
    authCodes.delete(body.code);

    if (body.redirect_uri && body.redirect_uri !== record.redirect_uri) {
      return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
    }

    const accessToken = crypto.randomBytes(32).toString("base64url");
    accessTokens.set(accessToken, { issued_at: Date.now() });
    return res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(TOKEN_TTL_MS / 1000),
    });
  }

  return res.status(400).json({ error: "unsupported_grant_type" });
}

/**
 * Validates a bearer token. Returns true if valid and unexpired.
 * Used by the MCP route's auth middleware.
 */
export function validateBearer(token) {
  if (!token) return false;
  sweep();
  return accessTokens.has(token);
}

/**
 * POST /register — RFC 7591 Dynamic Client Registration.
 *
 * The MCP 2025-06-18 auth spec requires the authorization server to
 * advertise a registration_endpoint. Figma Make (and other spec-compliant
 * clients) may refuse to proceed without it — even when the user has
 * already pasted a client_id/secret into the connector UI.
 *
 * We don't actually issue per-client credentials here; we just accept
 * the registration and hand back our single global client_id/secret.
 * This satisfies the spec without maintaining a client registry.
 */
export function postRegister(req, res) {
  assertOAuthConfigured();

  const body = req.body || {};
  const now = Math.floor(Date.now() / 1000);

  res.status(201).json({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    client_id_issued_at: now,
    client_secret_expires_at: 0, // never expires
    // Echo back what the client sent so they know we accepted it.
    redirect_uris: body.redirect_uris || [FIGMA_CALLBACK],
    grant_types: body.grant_types || ["authorization_code", "client_credentials"],
    response_types: body.response_types || ["code"],
    token_endpoint_auth_method: body.token_endpoint_auth_method || "client_secret_basic",
    client_name: body.client_name || "Figma Make",
    application_type: body.application_type || "web",
  });
}

// --- Helpers ----------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function parseBasicAuth(header) {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}
