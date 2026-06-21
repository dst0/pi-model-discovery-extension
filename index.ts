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

async function loadServersConfig(): Promise<ServerConfig[]> {
  // Check env var first
  const serversJson = process.env.SERVERS_JSON;
  if (serversJson) {
    try {
      return JSON.parse(serversJson);
    } catch (e) {
      console.error("Failed to parse SERVERS_JSON:", e);
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
    return (config.servers || []).filter((s: ServerConfig) => s.port === 11450);
  } catch {
    return [];
  }
}

async function discoverModelsFromServer(
  server: ServerConfig,
  maxRetries = 5,
): Promise<any[]> {
  const baseUrl = `http://${server.host}:${server.port}`;
  const modelsUrl = `${baseUrl}/v1/models`;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(modelsUrl, {
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: `Bearer ${server.apiKey || "ollama"}`,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      return data.data || [];
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        console.warn(`Attempt ${attempt}/${maxRetries} failed for ${baseUrl}: ${lastError.message} – retrying in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  console.error(`Failed to connect to ${baseUrl} after ${maxRetries} attempts:`, lastError);
  return [];
}

let discoveryError: string | undefined;

export default async function (pi: ExtensionAPI) {
  let providersRegistered = 0;
  let totalModels = 0;

  const maxRetries = 5;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const servers = await loadServersConfig();

      if (servers.length === 0) {
        console.log("No servers configured for auto-discovery");
        return;
      }

      let anySuccess = false;

      // Discover models from each server
      for (const server of servers) {
        const models = await discoverModelsFromServer(server);

        if (models.length > 0) {
          anySuccess = true;
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
          providersRegistered++;
          totalModels += models.length;
        }
      }

      // If at least one server responded, we're done
      if (anySuccess) return;

      // All servers failed — retry the whole batch
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        console.warn(`Discovery attempt ${attempt}/${maxRetries} — all servers offline, retrying in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      discoveryError = error instanceof Error ? error.message : String(error);
      console.error("llm-orc discovery error:", discoveryError);
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        console.warn(`Discovery attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // Exhausted all retries
  if (!discoveryError) {
    discoveryError = "All servers unreachable after " + maxRetries + " attempts";
    console.error("llm-orc discovery failed:", discoveryError);
  }

  pi.on("session_start", (_event: any, ctx: ExtensionContext) => {
    if (discoveryError) {
      ctx.ui.setStatus("llm-orc", `llm-orc \u274C ${discoveryError}`);
    } else if (providersRegistered > 0) {
      ctx.ui.setStatus("llm-orc", `llm-orc \u2705 (${providersRegistered}p ${totalModels}m)`);
    } else {
      ctx.ui.setStatus("llm-orc", undefined);
    }
  });
}
