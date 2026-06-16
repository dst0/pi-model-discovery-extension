# Model Discovery Extension for pi

Auto-discovers available models from OpenAI-compatible inference servers and registers them as providers.

## What it does

- Reads server configuration from `~/.pi/agent/servers.json` or `SERVERS` env var
- Queries each server's `/v1/models` endpoint
- Registers discovered models as pi providers you can select with `/model`

## Usage

1. Create `~/.pi/agent/servers.json` with your server endpoints
2. Link or copy this extension to `~/.pi/agent/extensions/`
3. Run pi — models are auto-discovered on startup

## Config file format

```json
{
  "servers": [
    {
      "host": "localhost",
      "port": 11450,
      "name": "my-server",
      "api": "openai-completions",
      "apiKey": "ollama"
    }
  ]
}
```
