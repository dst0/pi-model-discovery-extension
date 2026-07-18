# pi-model-discovery

Auto-discovers models from OpenAI-compatible server endpoints (llama-server, vLLM, Ollama, etc.) and registers them as providers in P.

## Setup

### 1. Configure servers

Create `~/.p/agent/server.json`:

```json
{
  "servers": [
    {
      "host": "localhost",
      "port": 11450,
      "name": "server-1",
      "api": "openai-completions",
      "apiKey": "ollama"
    },
    {
      "host": "localhost",
      "port": 11451,
      "name": "server-2",
      "api": "openai-completions",
      "apiKey": "ollama"
    }
  ]
}
```

Or use the `SERVERS` environment variable:

```bash
export SERVERS="localhost:11450,localhost:11451"
```

### 2. Install the extension

```bash
# Link to global extensions directory
ln -s /path/to/pi-model-discovery-extension ~/.p/agent/extensions/model-discovery

# Or use p -e to load directly
p -e /path/to/pi-model-discovery-extension
```

### 3. Use

Run `p -c` to see discovered models, or use `/model` to select a discovered provider.

Configured servers receive one parallel, bounded startup probe so reachable
providers are available to P's initial model scope. Successful results are cached
in `~/.p/agent/model-discovery-cache.json`. Unreachable servers retry with
exponential backoff in the background and never hold the global startup barrier.
`P_OFFLINE=1` skips all probes and uses only the cached provider list.
Interactive P sessions show a compact footer status such as
`llm-orc: 1/1 providers, 49 models`.

## Config options

| Field | Description | Default |
| --- | --- | --- |
|-------|-------------|---------|
| host | Server hostname or IP | required |
| port | Server port number | required |
| name | Provider display name | `${host}-${port}` |
| api | API type | `openai-completions` |
| apiKey | API key for auth | `ollama` |
| compat | Compatibility overrides | `{}` |

The startup probe and background retries can be tuned with environment variables:

| Variable | Description | Default |
| --- | --- | --- |
| `P_MODEL_DISCOVERY_INITIAL_TIMEOUT_MS` | Timeout for the parallel startup probe | `500` |
| `P_MODEL_DISCOVERY_RETRY_TIMEOUT_MS` | Timeout for each background retry | `5000` |
| `P_MODEL_DISCOVERY_RETRY_BASE_MS` | Initial exponential-backoff delay | `1000` |
| `P_MODEL_DISCOVERY_MAX_ATTEMPTS` | Total attempts including the startup probe | `5` |
