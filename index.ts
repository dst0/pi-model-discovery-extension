interface ExtensionContext {
  ui: {
    setStatus(key: string, text: string | undefined): void;
  };
}

interface ExtensionAPI {
  registerProvider(name: string, config: any): void;
  on(event: string, handler: (event: any, ctx: ExtensionContext) => void): void;
}

/**
 * Auto-discover models from OpenAI-compatible server endpoints (llama-server, vLLM, Ollama, etc.)
 *
 * Config:
 * - Set SERVERS env var: "localhost:11450,localhost:11451,localhost:11452"
 * - Or set SERVERS_JSON env var for JSON config:
 *   [{"host":"localhost","port":11450,"name":"server-1","api":"openai-completions"}]
 * - Or place config in ~/.pi/agent/servers.json:
 *   {"servers":[{"host":"localhost","port":11450,"name":"server-1"}]}
 */

interface ServerConfig {
  host: string;
  port: number;
  name?: string;
  api?: string;
  apiKey?: string;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
  };
}

interface ServersConfig {
  servers: ServerConfig[];
}

interface DiscoveryStatus {
  configuredServers: number;
  providersRegistered: number;
  totalModels: number;
  error?: string;
}

const STATUS_KEY = "llm-orc";

async function loadServersConfig(): Promise<ServerConfig[]> {
  // Check env var first
  const serversJson = process.env.SERVERS_JSON;
  if (serversJson) {
    try {
      return JSON.parse(serversJson);
    } catch (e) {
      void e;
      return [];
    }
  }

  // Check SERVERS env var (simple host:port format)
  const serversEnv = process.env.SERVERS;
  if (serversEnv) {
    const servers: ServerConfig[] = [];
    for (const entry of serversEnv.split(",").map((s) => s.trim()).filter((s) => s)) {
      const [host, port] = entry.split(":");
      if (host && port) {
        servers.push({
          host,
          port: parseInt(port, 10),
          name: `${host}-${port}`,
          api: "openai-completions",
        });
      }
    }
    if (servers.length > 0) return servers;
  }

  // Load from config file
  const homedir = require("node:os").homedir();
  const configPath = require("node:path").resolve(homedir, ".pi/agent/servers.json");
  try {
    const fs = require("node:fs/promises");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    return config.servers || [];
  } catch {
    return [];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discoverModelsFromServer(
  server: ServerConfig,
  maxRetries = 5,
): Promise<any[]> {
  const baseUrl = `http://${server.host}:${server.port}`;
  const modelsUrl = `${baseUrl}/v1/models`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(modelsUrl, {
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: `Bearer ${server.apiKey || "ollama"}`,
        },
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      return data.data || [];
    } catch (error) {
      void error;
      if (attempt < maxRetries) {
        await delay(Math.pow(2, attempt - 1) * 1000);
      }
    }
  }

  return [];
}

function formatStatus(status: DiscoveryStatus): string | undefined {
  if (status.configuredServers === 0) {
    return "llm-orc: no discovery servers";
  }
  if (status.providersRegistered > 0) {
    return `llm-orc: ${status.providersRegistered}/${status.configuredServers} providers, ${status.totalModels} models`;
  }
  if (status.error) {
    return `llm-orc: ${status.error}`;
  }
  return `llm-orc: 0/${status.configuredServers} providers, 0 models`;
}

function publishStatus(ctx: ExtensionContext, status: DiscoveryStatus): void {
  ctx.ui.setStatus(STATUS_KEY, formatStatus(status));
}

export default async function (pi: ExtensionAPI) {
  const status: DiscoveryStatus = {
    configuredServers: 0,
    providersRegistered: 0,
    totalModels: 0,
  };

  pi.on("session_start", (_event: any, ctx: ExtensionContext) => {
    publishStatus(ctx, status);
  });

  try {
    const servers = await loadServersConfig();
    status.configuredServers = servers.length;

    for (const server of servers) {
      const models = await discoverModelsFromServer(server);

      if (models.length === 0) {
        continue;
      }

      const providerName = server.name || `${server.host}:${server.port}`;
      const baseUrl = `http://${server.host}:${server.port}/v1`;

      pi.registerProvider(providerName, {
        name: `Local Server ${providerName}`,
        baseUrl,
        api: (server.api as any) || "openai-completions",
        apiKey: server.apiKey || "ollama",
        compat: server.compat,
        models: models.map((model: any) => ({
          id: model.id,
          name: model.name || model.id,
          reasoning: !!model.reasoning,
          input: model.input || ["text"],
          cost: model.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: model.context_window || 128000,
          maxTokens: model.max_tokens || 16384,
        })),
      });
      status.providersRegistered += 1;
      status.totalModels += models.length;
    }

    if (servers.length > 0 && status.providersRegistered === 0) {
      status.error = "all discovery servers unreachable";
    }
  } catch (error) {
    status.error = error instanceof Error ? error.message : String(error);
  }
}
