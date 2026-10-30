# xangi Browser Extension — Development Prototype

## Current state

- DOM-first Playwright controller with a restricted HTTP operation subset.
- Safety-policy unit tests.
- Bounded action batching with fail-fast postcondition checking.
- Deterministic local mock site and benchmark protocol.
- Responsive standalone Agent Console prototype (`ui/index.html`).
- Browser Skill and proposed MCP contract.
- Isolated Docker Compose recipe.

**Not yet implemented:** real xangi integration, Credential Vault, durable approval service, authenticated console, X Bot gateway, benchmark automation. Do not connect this prototype to authenticated sites or real purchasing workflows. The keyword-based approval policy is deliberately incomplete and must not be considered a financial safety barrier.

Run `npm run mock` for the local mock catalog. The mock site exposes `/state` counters for independent task success verification. `batch` actions accept up to eight steps and stop at the first denied or failed step.

## Tests

`npm test` (built-in Node test runner). Browser launch requires `npm install` and Chromium or the provided Playwright container.

## Deployment safety

Use a separate Compose project and network. No existing Barrier-Free Map filesystem paths, PostgreSQL databases, Docker networks, secrets, or volumes may be mounted. No host ports are published in `compose.yaml`. The controller's default allowlist accepts only loopback sites. Any expansion of accessible sites or privileges requires a dedicated security review.

## Project ownership

Target repository: `airpocket-soundman/xangi` (`dev` branch when available). The browser extension is intentionally independent to ease upstream synchronization.
