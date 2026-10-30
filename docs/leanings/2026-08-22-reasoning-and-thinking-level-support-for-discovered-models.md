# 2026-08-22 — Reasoning & Thinking Level Support for Discovered Models

- **Status:** Resolved
- **Task/context:** Enable supported thinking levels for models discovered dynamically via `pi-model-discovery-extension` in `p`.
- **Unexpected observation or failure:** Discovered models registered with `reasoning: false` by default, preventing `p` from exposing thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) and sending reasoning parameters to OpenAI-compatible endpoints like `llm-orchestrator`.
- **Evidence:** `ProviderModel` interface lacked `thinkingLevelMap` and `toProviderModel` defaulted `reasoning` to `false`.
- **Approaches tried:**
  - **Attempt:** Default `reasoning` to `model.reasoning ?? true` in `toProviderModel` and forward `thinkingLevelMap` / `thinking_level_map` from discovery `/v1/models` responses and cache.
    - **Outcome:** Worked
    - **Why:** Preserves explicit server reasoning flags (`true`/`false`), supports custom thinking level mappings, and provides seamless out-of-the-box thinking levels for local inference models.
- **Root cause:** Missing fields in `ProviderModel`/`DiscoveredModel` interfaces and defaulting `reasoning` to false in `toProviderModel`.
- **Resolution:** Updated `ProviderModel` and `DiscoveredModel` with `reasoning` and `thinkingLevelMap`/`thinking_level_map`, updated `parseDiscoveredModel` and `toProviderModel`, and added unit tests.
- **Verification:** `node --test index.test.ts` passed (7/7 tests). `p --list-models` and interactive TUI smoke test confirmed all discovered models report thinking enabled and active thinking levels.
- **Prevention/follow-up:** Test reasoning and thinking level map roundtrips from live and cached responses.
- **Reusable learning:** Discovered models targeting reasoning-capable local servers should default reasoning enabled unless explicitly marked `reasoning: false` by the backend.
- **References:** `index.ts`, `index.test.ts`.
