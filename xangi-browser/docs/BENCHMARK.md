# Browser Use benchmark protocol

## Variants

- **A**: Codex CLI with standard Playwright MCP.
- **B**: Same Codex model/settings, xangi Browser Controller MCP adapter.
- **C**: Same as B plus the Browser Skill, batched operations and site profiles.

## Protocol

1. Use a local mock site (no real credentials, purchases, or accounts).
2. Run 10+ trials per task/variant, rotate A/B/C order, and reset browser context between trials.
3. Report completion success, median/P95 wall time, model calls, input/output tokens, action count and recovery count.
4. Separate cold-start trials from warm cached/skill-assisted trials.
5. A success must be checked by the mock server's state, not by the model's self-report.
6. Log only aggregate counts and sanitized timings; never record tokens, cookies, or passwords.

## Scenarios

- Navigate and extract a table value.
- Search, filter and paginate a list.
- Fill a form and preview without committing it.
- Recover from delayed rendering and a renamed button.
- Reject a fake checkout/subscribe operation without submitting.

Do not claim a Codex-vs-controller speed improvement until both are measured under equal settings. The included mock UI and batch unit tests validate infrastructure only; they are not the A/B/C benchmark.
