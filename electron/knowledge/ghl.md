# Knowledge: the GHL agent (GoHighLevel MCP server)

This is background knowledge Jarvis has been trained on. When the user (Danny)
asks about "the GHL agent", "GoHighLevel", "my CRM agent", contacts, leads,
opportunities/pipelines, appointments, or messaging clients, use this. Answer
conversationally and concretely; you built and understand this system.

## What it is
The GHL agent is a **Model Context Protocol (MCP) server** that connects Claude
Code to a **GoHighLevel** (GHL) sub-account. It turns GHL's CRM into tools an AI
can call — so Danny can say "list my open opportunities" or "text this lead" and
it happens against his real GHL account. It's a TypeScript/Node project
(`ghl-mcp-server`), run over stdio, that authenticates to GHL and exposes CRM
actions as tools.

## What it can do (its tools)
- **Contacts:** list, get, create, update contacts; add/remove tags.
- **Pipelines & Opportunities:** list pipelines; list/get/create/update
  opportunities (deals/leads moving through a pipeline).
- **Calendar & Appointments:** list calendars; list/get appointments; find free
  slots; create, update, and cancel appointments.
- **Conversations & Messaging:** list conversations; read conversation messages;
  send a message to a contact (SMS/email through GHL).

## How it's set up
1. In GoHighLevel: **Settings → Other Settings → Private Integrations →
   Create new Integration**. Enable read/write scopes for Contacts,
   Opportunities, Calendars/Calendar Events, and Conversations. Copy the token
   immediately (GHL shows it once).
2. Note the **Location ID** (the sub-account ID) from Settings → Business Info.
3. Provide two secrets to the server as environment variables:
   `GHL_API_TOKEN` (the Private Integration token) and `GHL_LOCATION_ID`.
4. Build and register it with Claude Code (`npm install && npm run build`, then
   add it as an MCP server pointing at `dist/index.js`). On Claude Code web, a
   committed `.mcp.json` plus a session-start hook builds it automatically; you
   just add the two secrets in the environment settings.

## How it works under the hood
- Talks to GHL's API at `https://services.leadconnectorhq.com` using API
  version header `2021-07-28`, authenticating with `Bearer {GHL_API_TOKEN}`.
- The token is scoped to a single sub-account, so there's no location parameter
  to pass around — it's read from `GHL_LOCATION_ID`.
- Errors from GHL surface as a `GHLError` with the HTTP status and body; a 4xx
  usually means a scope is missing or the request schema changed.

## Limits / gotchas
- It only handles **on-demand** tool calls during a session. Proactive updates
  ("tell me every morning about new leads") need a separate scheduled job — not
  part of this server yet.
- If a tool call returns a 4xx, first suspect a missing Private Integration
  scope, then check GHL's API docs for a changed schema.
- The token is a live credential — never commit it; it lives only in env vars.
