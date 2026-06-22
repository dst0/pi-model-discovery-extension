# pi-model-discovery

Auto-discovers models from OpenAI-compatible server endpoints (llama-server, vLLM, Ollama, etc.) and registers them as providers in pi.

## Setup

### 1. Configure servers

Create `~/.pi/agent/servers.json`:

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
ln -s /path/to/pi-model-discovery-extension ~/.pi/agent/extensions/model-discovery

# Or use pi -e to load directly
pi -e /path/to/pi-model-discovery-extension
```

### 3. Use

Run `pi -c` to see discovered models, or use `/model` to select a discovered provider.

Discovery runs during startup. Unreachable servers are retried and skipped
silently so the terminal is not filled with transient network warnings;
interactive Pi sessions show a compact footer status such as
`llm-orc: 1/1 providers, 49 models`.

## Config options

| Field | Description | Default |
|-------|-------------|---------|
| host | Server hostname or IP | required |
| port | Server port number | required |
| name | Provider display name | `${host}-${port}` |
| api | API type | `openai-completions` |
| apiKey | API key for auth | `ollama` |
| compat | Compatibility overrides | `{}` |
