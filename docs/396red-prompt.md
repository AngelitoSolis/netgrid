# Paste this into 396red

You are adding one source, Netgrid, to an internal operator console called 396red. Netgrid keeps its own database, its own login, and its own customer-facing portal. 396red does not replace any of that. It reads leads and writes replies back through a small API. The customer never sees 396red.

## What Netgrid actually has

There is no public contact form and no public live chat. Do not invent those.

Leads exist in exactly two places:

1. `registration_leads` — the mini form (name, location, email) injected into published posts. POST `/api/register/{blogId}` stores the row, then redirects the visitor to the client's own site. That visitor is not a Netgrid user. There is no thread to reply in. 396red displays the lead. It does not message them inside Netgrid.
2. `messages` — the client portal thread. `sender_role` is `admin`, `client`, or `system`. `is_internal = true` is an operator note. The client never sees it. A reply the client should see must be inserted here as `sender_role = admin`, `is_internal = false`.

Traffic: Netgrid's own pageview pixel was retired on 2026-09-08. `link_events` is historic and must be labeled historic. Current visitors are not in Netgrid. Current search demand is in `search_performance` (Search Console clicks, impressions, position), already synced by a cron. 396red reads that. It does not call Google.

Do not read WordPress passwords, Shopify tokens, custom prompts, or cost fields. The existing marketing API already refuses those. Keep that rule.

## Auth

Server to server only. Header `Authorization: Bearer <key>` or `X-API-Key: <key>`.

- One key: `OPS_API_KEY`, set on the Netgrid web service. It is not the marketing key. `MARKETING_API_KEY` cannot read these routes and cannot post a reply.
- Header: `Authorization: Bearer <OPS_API_KEY>` or `X-API-Key: <OPS_API_KEY>`.

No CORS. 396red calls Netgrid from its own backend. Never put either key in a browser.

Base URL: `https://netgrid-16f6.onrender.com` (or the real host).

## Endpoints 396red calls

Netgrid implements these four routes on branch `396red`. They are not on `main` until that branch is merged and `OPS_API_KEY` is set. Migration `0055_ops_reply_keys.sql` must be applied or the reply endpoint cannot remember an idempotency key.

### `GET /api/v1/ops/leads?since=<ISO>&limit=100`

New rows in `registration_leads` with `created_at > since`, oldest first.

```json
{
  "leads": [
    {
      "source": "netgrid",
      "kind": "registration",
      "id": "uuid",
      "clientId": "uuid",
      "clientName": "string",
      "blogId": "uuid",
      "domain": "string",
      "postId": "uuid or null",
      "name": "string or null",
      "location": "string or null",
      "email": "string or null",
      "referrer": "string or null",
      "createdAt": "ISO"
    }
  ],
  "nextSince": "ISO of the last row, or the since you sent if empty"
}
```

Store `nextSince`. Do not re-import an `id` you already have. There is no reply action on this kind.

### `GET /api/v1/ops/threads?since=<ISO>`

Client threads with a message newer than `since`. One object per `clientId`.

```json
{
  "threads": [
    {
      "source": "netgrid",
      "kind": "portal_thread",
      "clientId": "uuid",
      "clientName": "string",
      "contactEmail": "string or null",
      "unreadByAdmin": 3,
      "lastMessageAt": "ISO",
      "messages": [
        {
          "id": "uuid",
          "senderRole": "admin",
          "isInternal": false,
          "content": "string",
          "createdAt": "ISO"
        }
      ]
    }
  ]
}
```

Include internal notes in the payload but render them as operator-only. Never send an internal note to a customer, and never echo one back as a reply.

### `POST /api/v1/ops/threads/{clientId}/reply`

Body: `{ "content": "string", "isInternal": false }`

Netgrid inserts one `messages` row: `sender_role = admin`, `sender_id = null`, `is_internal` from the body, `read_by_client = false` when it is not internal. Then it returns the new row.

396red must not write to the Netgrid database itself. This endpoint is the only way a reply exists. The client portal already polls its own messages, so the customer sees the reply in the same thread, from the same admin side, with no mention of 396red.

Reject empty content. Cap content at 8000 characters. Idempotency: send header `Idempotency-Key`. If Netgrid has already stored that key, return the original row instead of inserting a second one.

### `GET /api/v1/ops/traffic?days=28`

Per active blog, from `search_performance` only.

```json
{
  "windowDays": 28,
  "sites": [
    {
      "blogId": "uuid",
      "domain": "string",
      "clientId": "uuid",
      "clientName": "string",
      "clicks": 12,
      "impressions": 340,
      "position": 14.2,
      "syncedAt": "ISO or null"
    }
  ],
  "note": "Search Console, not live visitors. link_events is historic and is not in this payload."
}
```

`position` is null when impressions are 0. Do not coerce that to 0.

Daily and monthly charts in 396red are sums of this window, not a live counter. Label the chart "Search clicks", never "visitors online".

## How 396red stores it

One table, all sources, Netgrid is `source = "netgrid"`.

- Unique key: `(source, kind, external_id)`.
- `kind` is `registration` or `portal_thread`.
- A registration lead has no reply button.
- A portal thread reply calls the POST above, then appends the returned message to the local copy so the operator sees it immediately.
- Poll leads and threads every 60 seconds. Poll traffic every 6 hours. Back off on 429 or 5xx. Do not scrape the portal HTML.

## What you must not build

- A second customer login. Customers stay on Netgrid.
- A chatbot that answers leads by itself.
- A live-visitor pixel. That was retired on purpose.
- Any write except the reply endpoint.
- Any field that is a credential, a prompt, or a cost.

When a screen in 396red would need a lead type Netgrid does not have, show nothing. Do not synthesize a contact form, a chat widget, or a visitor count.
