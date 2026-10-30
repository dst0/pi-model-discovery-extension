import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { performance } from "node:perf_hooks";
import modelDiscoveryExtension from "./index.ts";

type ExtensionAPI = Parameters<typeof modelDiscoveryExtension>[0];
type ExtensionContext = {
  ui: {
    setStatus(key: string, text: string | undefined): void;
  };
};
type ExtensionHandler = (event: unknown, context: ExtensionContext) => void;

class FakeExtensionAPI {
  readonly providers = new Map<string, unknown>();
  readonly handlers = new Map<string, ExtensionHandler[]>();

  registerProvider(name: string, config: unknown): void {
    this.providers.set(name, config);
  }

  unregisterProvider(name: string): void {
    this.providers.delete(name);
  }

  on(event: string, handler: ExtensionHandler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  emit(event: string): void {
    const context: ExtensionContext = { ui: { setStatus: () => undefined } };
    for (const handler of this.handlers.get(event) ?? []) handler({}, context);
  }

  asExtensionAPI(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}

const originalFetch = globalThis.fetch;
const environmentKeys = [
  "P_CODING_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
  "P_OFFLINE",
  "SERVERS",
  "SERVERS_JSON",
  "P_MODEL_DISCOVERY_INITIAL_TIMEOUT_MS",
  "P_MODEL_DISCOVERY_RETRY_TIMEOUT_MS",
  "P_MODEL_DISCOVERY_RETRY_BASE_MS",
  "P_MODEL_DISCOVERY_MAX_ATTEMPTS",
] as const;
const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
const temporaryDirectories: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of environmentKeys) {
    const value = originalEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function createAgentDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p-model-discovery-"));
  temporaryDirectories.push(directory);
  process.env.P_CODING_AGENT_DIR = directory;
  return directory;
}

function setServers(servers: unknown[]): void {
  process.env.SERVERS_JSON = JSON.stringify(servers);
  process.env.P_MODEL_DISCOVERY_INITIAL_TIMEOUT_MS = "30";
  process.env.P_MODEL_DISCOVERY_RETRY_TIMEOUT_MS = "30";
  process.env.P_MODEL_DISCOVERY_RETRY_BASE_MS = "10000";
  process.env.P_MODEL_DISCOVERY_MAX_ATTEMPTS = "2";
}

function modelsResponse(id: string): Response {
  return Response.json({ data: [{ id }] });
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("probes servers concurrently and does not await retry backoff", async () => {
  createAgentDir();
  setServers([
    { host: "slow.test", port: 11450, name: "slow" },
    { host: "fast.test", port: 11451, name: "fast" },
  ]);
  let slowRequestAborted = false;
  let fastStartedBeforeSlowAbort = false;
  globalThis.fetch = ((_input, init) => {
    const input = String(_input);
    if (input.includes("fast.test")) {
      fastStartedBeforeSlowAbort = !slowRequestAborted;
      return Promise.resolve(modelsResponse("fast-model"));
    }
    return new Promise<Response>((_resolve, reject) => {
      const abort = (): void => {
        slowRequestAborted = true;
        reject(new Error("aborted"));
      };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;
  const api = new FakeExtensionAPI();

  const startedAt = performance.now();
  await modelDiscoveryExtension(api.asExtensionAPI());
  const elapsedMs = performance.now() - startedAt;

  assert.equal(fastStartedBeforeSlowAbort, true);
  assert.equal(api.providers.has("fast"), true);
  assert.equal(api.providers.has("slow"), false);
  assert.ok(elapsedMs < 250, `startup took ${elapsedMs.toFixed(1)}ms`);
  api.emit("session_shutdown");
});

test("registers a provider when a background retry recovers", async () => {
  createAgentDir();
  setServers([{ host: "recover.test", port: 11450, name: "recover" }]);
  process.env.P_MODEL_DISCOVERY_RETRY_BASE_MS = "1";
  let requests = 0;
  globalThis.fetch = (() => {
    requests += 1;
    return requests === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(modelsResponse("recovered-model"));
  }) as typeof fetch;
  const api = new FakeExtensionAPI();

  await modelDiscoveryExtension(api.asExtensionAPI());
  assert.equal(api.providers.has("recover"), false);
  await waitFor(() => api.providers.has("recover"));

  assert.equal(requests, 2);
  api.emit("session_shutdown");
});

test("registers cached models before a slow refresh completes", async () => {
  const agentDir = createAgentDir();
  setServers([{ host: "cached.test", port: 11450, name: "cached" }]);
  globalThis.fetch = (() => Promise.resolve(modelsResponse("cached-model"))) as typeof fetch;
  const firstApi = new FakeExtensionAPI();
  await modelDiscoveryExtension(firstApi.asExtensionAPI());
  await waitFor(() => fs.existsSync(path.join(agentDir, "model-discovery-cache.json")));
  firstApi.emit("session_shutdown");

  let finishRefresh: ((response: Response) => void) | undefined;
  globalThis.fetch = (() => new Promise<Response>((resolveResponse) => {
    finishRefresh = resolveResponse;
  })) as typeof fetch;
  const secondApi = new FakeExtensionAPI();
  let startupFinished = false;
  const startup = modelDiscoveryExtension(secondApi.asExtensionAPI()).then(() => {
    startupFinished = true;
  });

  await waitFor(() => secondApi.providers.has("cached"));
  assert.equal(startupFinished, false);
  finishRefresh?.(new Response(undefined, { status: 503 }));
  await startup;
  secondApi.emit("session_shutdown");
});

test("uses cached models without probing the network in offline mode", async () => {
  const agentDir = createAgentDir();
  setServers([{ host: "offline.test", port: 11450, name: "offline" }]);
  fs.writeFileSync(
    path.join(agentDir, "model-discovery-cache.json"),
    JSON.stringify({
      version: 1,
      servers: {
        "offline.test:11450": {
          models: [{ id: "offline-model" }],
          updatedAt: Date.now(),
        },
      },
    }),
  );
  process.env.P_OFFLINE = "1";
  let fetchCalled = false;
  globalThis.fetch = (() => {
    fetchCalled = true;
    return Promise.reject(new Error("network access in offline mode"));
  }) as typeof fetch;
  const api = new FakeExtensionAPI();

  await modelDiscoveryExtension(api.asExtensionAPI());

  assert.equal(api.providers.has("offline"), true);
  assert.equal(fetchCalled, false);
  api.emit("session_shutdown");
});

test("supports baseUrl in ServerConfig and probes resolved models URL", async () => {
  createAgentDir();
  setServers([
    {
      name: "custom-https",
      baseUrl: "https://192.168.8.167:11450/v1",
      api: "openai-completions",
    },
  ]);
  let requestedUrl: string | undefined;
  globalThis.fetch = ((input) => {
    requestedUrl = String(input);
    return Promise.resolve(modelsResponse("https-model"));
  }) as typeof fetch;
  const api = new FakeExtensionAPI();

  await modelDiscoveryExtension(api.asExtensionAPI());

  assert.equal(requestedUrl, "https://192.168.8.167:11450/v1/models");
  assert.equal(api.providers.has("custom-https"), true);
  const provider = api.providers.get("custom-https") as { baseUrl?: string; api?: string };
  assert.equal(provider?.baseUrl, "https://192.168.8.167:11450/v1");
  assert.equal(provider?.api, "openai-completions");
  api.emit("session_shutdown");
});

test("registers models with reasoning and thinkingLevelMap from /v1/models", async () => {
  createAgentDir();
  setServers([
    {
      name: "reasoning-server",
      host: "127.0.0.1",
      port: 11450,
    },
  ]);
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({
        data: [
          {
            id: "mini-pc/qwen3.6-27b",
            context_window: 65536,
            reasoning: true,
            thinking_level_map: {
              off: "none",
              low: "low",
              medium: "medium",
              high: "high",
            },
          },
          {
            id: "mini-pc/plain-model",
            context_window: 32768,
          },
        ],
      }),
    )) as typeof fetch;
  const api = new FakeExtensionAPI();

  await modelDiscoveryExtension(api.asExtensionAPI());

  assert.equal(api.providers.has("reasoning-server"), true);
  const provider = api.providers.get("reasoning-server") as {
    models: Array<{
      id: string;
      reasoning: boolean;
      thinkingLevelMap?: Record<string, string | null>;
    }>;
  };
  assert.equal(provider.models.length, 2);

  const qwen = provider.models.find((m) => m.id === "mini-pc/qwen3.6-27b");
  assert.ok(qwen);
  assert.equal(qwen?.reasoning, true);
  assert.deepEqual(qwen?.thinkingLevelMap, {
    off: "none",
    low: "low",
    medium: "medium",
    high: "high",
  });

  const plain = provider.models.find((m) => m.id === "mini-pc/plain-model");
  assert.ok(plain);
  assert.equal(plain?.reasoning, true); // defaults to true
  assert.equal(plain?.thinkingLevelMap, undefined);
  api.emit("session_shutdown");
});

test("restores reasoning and thinkingLevelMap from cached discovery entries", async () => {
  const agentDir = createAgentDir();
  setServers([{ host: "cached-reasoning.test", port: 11450, name: "cached-reasoning" }]);
  fs.writeFileSync(
    path.join(agentDir, "model-discovery-cache.json"),
    JSON.stringify({
      version: 1,
      servers: {
        "cached-reasoning.test:11450": {
          models: [
            {
              id: "cached-qwen",
              reasoning: true,
              thinking_level_map: {
                off: null,
                high: "max",
              },
            },
          ],
          updatedAt: Date.now(),
        },
      },
    }),
  );
  process.env.P_OFFLINE = "1";
  const api = new FakeExtensionAPI();

  await modelDiscoveryExtension(api.asExtensionAPI());

  assert.equal(api.providers.has("cached-reasoning"), true);
  const provider = api.providers.get("cached-reasoning") as {
    models: Array<{
      id: string;
      reasoning: boolean;
      thinkingLevelMap?: Record<string, string | null>;
    }>;
  };
  assert.equal(provider.models.length, 1);
  assert.equal(provider.models[0].id, "cached-qwen");
  assert.equal(provider.models[0].reasoning, true);
  assert.deepEqual(provider.models[0].thinkingLevelMap, {
    off: null,
    high: "max",
  });
  api.emit("session_shutdown");
});
