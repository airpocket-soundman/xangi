# Browser MCP contract — proposed v0.1

This document specifies an adapter contract, not a deployed MCP server. The current prototype exposes an HTTP `/action` endpoint with Bearer authentication.

| Tool | Input | Output |
|---|---|---|
| `browser_navigate` | `url` | `{url}` |
| `browser_snapshot` | `sessionId?, scope?` | `{tree,url}` |
| `browser_click` | `role,name` | `{url}` |
| `browser_fill` | `name,value` | `{ok}` |
| `browser_screenshot` | `scope?` | image |
| `browser_batch` (future) | steps, postconditions | step results/timings |
| `browser_request_approval` (future) | operation, domain, amount, currency, nonce | pending approval ID |
| `browser_handoff` (future) | sessionId, reason | human handoff ID |

## Trust boundaries
- A tool caller never receives raw credentials, cookies, token values, or browser profiles.
- Approved actions must be bound to exact origin, target, amount, expiration and single-use nonce. Approval is issued by an independent authenticated UI, never by the LLM.
- Tool servers run as non-root identities without Docker socket or access to the host's existing services.
- No generic `evaluateJavascript`, `fetch`, shell execution or unrestricted network tools are exposed by this adapter.
- Output snapshots must mask sensitive text. In production, use stronger DOM-level secret filtering and network egress protections, since text filtering alone is insufficient.
