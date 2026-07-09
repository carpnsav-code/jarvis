# Knowledge: the GHL agent (GoHighLevel MCP server) — full reference

Background knowledge Jarvis has, taken directly from Danny's GHL repository. When
he asks about the GHL agent, GoHighLevel, his CRM, contacts, leads,
opportunities/pipelines, appointments, or messaging, answer from this
concretely and conversationally — you built and understand this system.

## What it is
A **Model Context Protocol (MCP) server** ("ghl-mcp-server", TypeScript/Node,
run over stdio) that connects Claude Code to a **GoHighLevel** sub-account via a
Private Integration token, exposing the CRM (contacts, pipelines/opportunities,
calendar, conversations) as callable tools.

## Setup
1. GoHighLevel → **Settings → Other Settings → Private Integrations → Create new
   Integration**. Enable read/write scopes for Contacts, Opportunities,
   Calendars/Calendar Events, and Conversations/Conversations Messages. Copy the
   token once (shown only once).
2. Note the **Location ID** (sub-account id) from Settings → Business Info.
3. Provide two env-var secrets: `GHL_API_TOKEN` and `GHL_LOCATION_ID`.
4. `npm install && npm run build`, then register with Claude Code (the repo
   commits a `.mcp.json` and a session-start hook that builds it automatically;
   on the web you just add the two secrets in Environment Variables). Then you
   can ask things like "list my open opportunities" or "text this contact".

## Architecture
- `src/index.ts` boots an McpServer and registers four tool groups.
- `src/client.ts` (`GHLClient`) calls the GHL API at
  `https://services.leadconnectorhq.com`, version header `2021-07-28`, auth
  `Bearer {GHL_API_TOKEN}`. The token is scoped to one sub-account, so
  `locationId` is read from `GHL_LOCATION_ID`, not passed per call. Non-2xx
  responses throw `GHLError(status, body)`.
- `src/util.ts` wraps responses as JSON text (`jsonResult`) or errors.

## Complete tool reference

### Contacts (src/tools/contacts.ts)
- **ghl_list_contacts** — GET /contacts/ — inputs: query (free-text name/email/
  phone, optional), limit (1–100, default 20), startAfterId (pagination cursor).
- **ghl_get_contact** — GET /contacts/{contactId} — inputs: contactId.
- **ghl_create_contact** — POST /contacts/ — inputs: firstName, lastName, email,
  phone, tags[], source (all optional).
- **ghl_update_contact** — PUT /contacts/{contactId} — inputs: contactId +
  firstName/lastName/email/phone.
- **ghl_add_contact_tags** — POST /contacts/{contactId}/tags — inputs: contactId,
  tags[] (≥1).
- **ghl_remove_contact_tags** — DELETE /contacts/{contactId}/tags — inputs:
  contactId, tags[] (≥1).

### Pipelines & Opportunities (src/tools/opportunities.ts)
- **ghl_list_pipelines** — GET /opportunities/pipelines — lists pipelines and
  their stages. No inputs.
- **ghl_list_opportunities** — GET /opportunities/search — inputs: pipelineId,
  status (open/won/lost/abandoned/all), query, limit (default 20).
- **ghl_get_opportunity** — GET /opportunities/{opportunityId} — inputs:
  opportunityId.
- **ghl_create_opportunity** — POST /opportunities/ — inputs: pipelineId,
  pipelineStageId, name (required); contactId, monetaryValue, status
  (default open).
- **ghl_update_opportunity** — PUT /opportunities/{opportunityId} — inputs:
  opportunityId + name/pipelineStageId/monetaryValue/status (e.g. move a deal to
  a new stage, mark won).

### Calendar & Appointments (src/tools/calendar.ts)
- **ghl_list_calendars** — GET /calendars/ — no inputs.
- **ghl_list_appointments** — GET /calendars/events — inputs: startTime, endTime
  (ISO or epoch millis), calendarId, userId (optional).
- **ghl_get_appointment** — GET /calendars/events/appointments/{appointmentId}.
- **ghl_get_free_slots** — GET /calendars/{calendarId}/free-slots — inputs:
  calendarId, startDate, endDate, timezone (optional). Checks bookable slots.
- **ghl_create_appointment** — POST /calendars/events/appointments — inputs:
  calendarId, contactId, startTime, endTime (ISO); title, appointmentStatus
  (default confirmed).
- **ghl_update_appointment** — PUT /calendars/events/appointments/{id} — reschedule
  or set status (confirmed/new/cancelled/showed/noshow).
- **ghl_cancel_appointment** — PUT the same endpoint with status cancelled.

### Conversations & Messaging (src/tools/conversations.ts)
- **ghl_list_conversations** — GET /conversations/search — inputs: contactId
  (optional), limit (default 20).
- **ghl_get_conversation_messages** — GET /conversations/{conversationId}/messages
  — inputs: conversationId, limit.
- **ghl_send_message** — POST /conversations/messages — inputs: contactId, type
  (SMS or Email), message; subject (required for Email). Sends an SMS or email to
  a contact, creating a conversation if needed.

## Limits / gotchas
- On-demand only (during a session). Proactive updates (e.g. daily new-lead
  alerts) need a separate scheduled job — not built yet.
- A 4xx from GHL usually means a missing Private Integration scope, or a changed
  API schema (check GHL's API docs).
- The token is a live credential — never commit it; it lives only in env vars.
