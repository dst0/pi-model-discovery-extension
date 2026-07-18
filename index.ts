import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

interface ExtensionContext {
  ui: {
    setStatus(key: string, text: string | undefined): void;
  };
}

interface ProviderModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
}

interface ProviderConfig {
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  compat?: ServerConfig["compat"];
  models: ProviderModel[];
}

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => void;

interface ExtensionAPI {
  registerProvider(name: string, config: ProviderConfig): void;
  unregisterProvider(name: string): void;
  on(event: "session_start" | "session_shutdown", handler: ExtensionHandler): void;
}

/**
 * Auto-discover models from OpenAI-compatible server endpoints (llama-server, vLLM, Ollama, etc.)
 *
 * Config:
 * - Set SERVERS env var: "localhost:11450,localhost:11451,localhost:11452"
 * - Or set SERVERS_JSON env var for JSON config:
 *   [{"host":"localhost","port":11450,"name":"server-1","api":"openai-completions"}]
 * - Or place config in ~/.p/agent/server.json:
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

interface DiscoveredModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: Partial<ProviderModel["cost"]>;
  context_window?: number;
  max_tokens?: number;
}

interface DiscoveryStatus {
  configuredServers: number;
  providersRegistered: number;
  totalModels: number;
  error?: string;
}

interface DiscoveryResult {
  server: ServerConfig;
  models?: DiscoveredModel[];
  error?: string;
}

interface DiscoveryCacheEntry {
  models: DiscoveredModel[];
  updatedAt: number;
}

interface DiscoveryCache {
  version: 1;
  servers: Record<string, DiscoveryCacheEntry>;
}

const STATUS_KEY = "llm-orc";
const CACHE_FILE_NAME = "model-discovery-cache.json";
const DEFAULT_INITIAL_TIMEOUT_MS = 500;
const DEFAULT_RETRY_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 5;
let cacheWriteQueue = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseServerConfig(value: unknown): ServerConfig | undefined {
  if (!isRecord(value) || typeof value.host !== "string" || typeof value.port !== "number") return undefined;
  if (!Number.isSafeInteger(value.port) || value.port <= 0 || value.port > 65_535) return undefined;

  const compat = isRecord(value.compat)
    ? {
        ...(typeof value.compat.supportsDeveloperRole === "boolean"
          ? { supportsDeveloperRole: value.compat.supportsDeveloperRole }
          : {}),
        ...(typeof value.compat.supportsReasoningEffort === "boolean"
          ? { supportsReasoningEffort: value.compat.supportsReasoningEffort }
          : {}),
      }
    : undefined;

  return {
    host: value.host,
    port: value.port,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.api === "string" ? { api: value.api } : {}),
    ...(typeof value.apiKey === "string" ? { apiKey: value.apiKey } : {}),
    ...(compat ? { compat } : {}),
  };
}

function normalizeServersConfig(config: unknown): ServerConfig[] {
  const values = Array.isArray(config) ? config : isRecord(config) && Array.isArray(config.servers) ? config.servers : [];
  return values.map(parseServerConfig).filter((server): server is ServerConfig => server !== undefined);
}

function parseDiscoveredModel(value: unknown): DiscoveredModel | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;

  const cost = isRecord(value.cost)
    ? {
        ...(typeof value.cost.input === "number" ? { input: value.cost.input } : {}),
        ...(typeof value.cost.output === "number" ? { output: value.cost.output } : {}),
        ...(typeof value.cost.cacheRead === "number" ? { cacheRead: value.cost.cacheRead } : {}),
        ...(typeof value.cost.cacheWrite === "number" ? { cacheWrite: value.cost.cacheWrite } : {}),
      }
    : undefined;

  return {
    id: value.id,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
    ...(Array.isArray(value.input) && value.input.every((item) => typeof item === "string")
      ? { input: value.input }
      : {}),
    ...(cost ? { cost } : {}),
    ...(typeof value.context_window === "number" ? { context_window: value.context_window } : {}),
    ...(typeof value.max_tokens === "number" ? { max_tokens: value.max_tokens } : {}),
  };
}

function normalizeModelsResponse(value: unknown): DiscoveredModel[] {
  if (!isRecord(value) || !Array.isArray(value.data)) return [];
  return value.data.map(parseDiscoveredModel).filter((model): model is DiscoveredModel => model !== undefined);
}

async function readServersConfigFile(configPath: string): Promise<ServerConfig[] | undefined> {
  try {
    return normalizeServersConfig(JSON.parse(await readFile(configPath, "utf8")));
  } catch {
    return undefined;
  }
}

async function loadServersConfig(): Promise<ServerConfig[]> {
  const serversJson = process.env.SERVERS_JSON;
  if (serversJson) {
    try {
      return normalizeServersConfig(JSON.parse(serversJson));
    } catch {
      return [];
    }
  }

  const serversEnv = process.env.SERVERS;
  if (serversEnv) {
    const servers: ServerConfig[] = [];
    for (const entry of serversEnv.split(",").map((item) => item.trim()).filter(Boolean)) {
      const separator = entry.lastIndexOf(":");
      const host = entry.slice(0, separator);
      const port = Number.parseInt(entry.slice(separator + 1), 10);
      const server = parseServerConfig({ host, port, name: `${host}-${port}`, api: "openai-completions" });
      if (server) servers.push(server);
    }
    if (servers.length > 0) return servers;
  }

  const agentDir = process.env.P_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".p/agent");
  const configPaths = [
    resolve(agentDir, "server.json"),
    resolve(agentDir, "servers.json"),
    resolve(homedir(), ".pi/agent/server.json"),
    resolve(homedir(), ".pi/agent/servers.json"),
  ];

  for (const configPath of configPaths) {
    const servers = await readServersConfigFile(configPath);
    if (servers) return servers;
  }

  return [];
}

function getCachePath(): string {
  const agentDir = process.env.P_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".p/agent");
  return resolve(agentDir, CACHE_FILE_NAME);
}

function getServerCacheKey(server: ServerConfig): string {
  return `${server.host}:${server.port}`;
}

async function readDiscoveryCache(cachePath: string): Promise<DiscoveryCache> {
  try {
    const value: unknown = JSON.parse(await readFile(cachePath, "utf8"));
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.servers)) throw new Error("invalid cache");

    const servers: Record<string, DiscoveryCacheEntry> = {};
    for (const [key, entry] of Object.entries(value.servers)) {
      if (!isRecord(entry) || !Array.isArray(entry.models) || typeof entry.updatedAt !== "number") continue;
      const models = entry.models
        .map(parseDiscoveredModel)
        .filter((model): model is DiscoveredModel => model !== undefined);
      if (models.length > 0) servers[key] = { models, updatedAt: entry.updatedAt };
    }
    return { version: 1, servers };
  } catch {
    return { version: 1, servers: {} };
  }
}

function queueDiscoveryCacheWrite(cachePath: string, cache: DiscoveryCache): void {
  const serialized = `${JSON.stringify(cache, null, 2)}\n`;
  cacheWriteQueue = cacheWriteQueue
    .catch(() => undefined)
    .then(async () => {
      await mkdir(dirname(cachePath), { recursive: true });
      const temporaryPath = `${cachePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, serialized, "utf8");
      await rename(temporaryPath, cachePath);
    });
  void cacheWriteQueue.catch(() => undefined);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref?.();
  });
}

async function discoverModelsOnce(server: ServerConfig, timeoutMs: number): Promise<DiscoveryResult> {
  const modelsUrl = `http://${server.host}:${server.port}/v1/models`;
  try {
    const response = await fetch(modelsUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${server.apiKey || "ollama"}`,
      },
    });
    if (!response.ok) {
      return { server, error: `HTTP ${response.status}` };
    }
    return { server, models: normalizeModelsResponse(await response.json()) };
  } catch (error) {
    return { server, error: error instanceof Error ? error.message : String(error) };
  }
}

function toProviderModel(model: DiscoveredModel): ProviderModel {
  return {
    id: model.id,
    name: model.name || model.id,
    reasoning: model.reasoning ?? false,
    input: model.input ?? ["text"],
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cacheRead: model.cost?.cacheRead ?? 0,
      cacheWrite: model.cost?.cacheWrite ?? 0,
    },
    contextWindow: model.context_window ?? 128_000,
    maxTokens: model.max_tokens ?? 16_384,
  };
}

function getProviderName(server: ServerConfig): string {
  return server.name || `${server.host}:${server.port}`;
}

function registerServerModels(pi: ExtensionAPI, server: ServerConfig, models: DiscoveredModel[]): void {
  const providerName = getProviderName(server);
  pi.registerProvider(providerName, {
    name: `Local Server ${providerName}`,
    baseUrl: `http://${server.host}:${server.port}/v1`,
    api: server.api || "openai-completions",
    apiKey: server.apiKey || "ollama",
    compat: server.compat,
    models: models.map(toProviderModel),
  });
}

function formatStatus(status: DiscoveryStatus): string | undefined {
  if (status.configuredServers === 0) return "llm-orc: no discovery servers";
  if (status.providersRegistered > 0) {
    return `llm-orc: ${status.providersRegistered}/${status.configuredServers} providers, ${status.totalModels} models`;
  }
  if (status.error) return `llm-orc: ${status.error}`;
  return `llm-orc: 0/${status.configuredServers} providers, 0 models`;
}

export default async function modelDiscoveryExtension(pi: ExtensionAPI): Promise<void> {
  const status: DiscoveryStatus = {
    configuredServers: 0,
    providersRegistered: 0,
    totalModels: 0,
  };
  const providerModelCounts = new Map<string, number>();
  let activeContext: ExtensionContext | undefined;
  let stopped = false;

  const publishStatus = (): void => {
    status.providersRegistered = providerModelCounts.size;
    status.totalModels = [...providerModelCounts.values()].reduce((total, count) => total + count, 0);
    activeContext?.ui.setStatus(STATUS_KEY, formatStatus(status));
  };
  const applyModels = (server: ServerConfig, models: DiscoveredModel[]): void => {
    const providerName = getProviderName(server);
    if (models.length > 0) {
      registerServerModels(pi, server, models);
      providerModelCounts.set(providerName, models.length);
    } else if (providerModelCounts.delete(providerName)) {
      pi.unregisterProvider(providerName);
    }
    publishStatus();
  };

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    publishStatus();
  });
  pi.on("session_shutdown", () => {
    stopped = true;
    activeContext = undefined;
  });

  try {
    const cachePath = getCachePath();
    const [servers, cache] = await Promise.all([loadServersConfig(), readDiscoveryCache(cachePath)]);
    status.configuredServers = servers.length;

    for (const server of servers) {
      const cached = cache.servers[getServerCacheKey(server)];
      if (cached) applyModels(server, cached.models);
    }

    if (isTruthyEnvFlag(process.env.P_OFFLINE)) {
      status.error = providerModelCounts.size === 0 ? "offline; no cached models" : undefined;
      publishStatus();
      return;
    }

    const initialTimeoutMs = parsePositiveInteger(
      process.env.P_MODEL_DISCOVERY_INITIAL_TIMEOUT_MS,
      DEFAULT_INITIAL_TIMEOUT_MS,
    );
    const initialResults = await Promise.all(servers.map((server) => discoverModelsOnce(server, initialTimeoutMs)));
    const unavailableServers: ServerConfig[] = [];

    for (const result of initialResults) {
      if (result.models) {
        applyModels(result.server, result.models);
        const cacheKey = getServerCacheKey(result.server);
        if (result.models.length > 0) {
          cache.servers[cacheKey] = { models: result.models, updatedAt: Date.now() };
        } else {
          delete cache.servers[cacheKey];
        }
        queueDiscoveryCacheWrite(cachePath, cache);
      } else {
        unavailableServers.push(result.server);
      }
    }

    if (unavailableServers.length === 0) {
      status.error = undefined;
      publishStatus();
      return;
    }

    status.error = providerModelCounts.size === 0 ? "discovery retrying in background" : undefined;
    publishStatus();

    const retryTimeoutMs = parsePositiveInteger(
      process.env.P_MODEL_DISCOVERY_RETRY_TIMEOUT_MS,
      DEFAULT_RETRY_TIMEOUT_MS,
    );
    const retryBaseMs = parsePositiveInteger(process.env.P_MODEL_DISCOVERY_RETRY_BASE_MS, DEFAULT_RETRY_BASE_MS);
    const maxAttempts = parsePositiveInteger(process.env.P_MODEL_DISCOVERY_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS);

    void Promise.allSettled(
      unavailableServers.map(async (server) => {
        for (let attempt = 2; attempt <= maxAttempts && !stopped; attempt++) {
          await delay(retryBaseMs * 2 ** (attempt - 2));
          if (stopped) return;
          const result = await discoverModelsOnce(server, retryTimeoutMs);
          if (!result.models) continue;

          applyModels(server, result.models);
          const cacheKey = getServerCacheKey(server);
          if (result.models.length > 0) {
            cache.servers[cacheKey] = { models: result.models, updatedAt: Date.now() };
          } else {
            delete cache.servers[cacheKey];
          }
          queueDiscoveryCacheWrite(cachePath, cache);
          return;
        }
      }),
    ).then(() => {
      if (stopped) return;
      status.error = providerModelCounts.size === 0 ? "all discovery servers unreachable" : undefined;
      publishStatus();
    });
  } catch (error) {
    status.error = error instanceof Error ? error.message : String(error);
    publishStatus();
  }
}
