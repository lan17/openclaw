import { createHash } from "node:crypto";
import { AgentControlClient } from "agent-control";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type AgentControlPluginConfig = {
  enabled?: boolean;
  serverUrl?: string;
  apiKey?: string;
  agentName?: string;
  agentId?: string;
  agentVersion?: string;
  timeoutMs?: number;
  userAgent?: string;
  failClosed?: boolean;
};

type AgentControlStep = {
  type: "tool";
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

type AgentState = {
  sourceAgentId: string;
  agentUuid: string;
  agentName: string;
  steps: AgentControlStep[];
  stepsHash: string;
  lastSyncedStepsHash: string | null;
  syncPromise: Promise<void> | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function trimToMax(value: string, maxLen: number): string {
  return value.length <= maxLen ? value : value.slice(0, maxLen);
}

function buildDeterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  const variantNibble = Number.parseInt(hex[16] ?? "0", 16);
  hex[16] = ((variantNibble & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8).join(""),
    hex.slice(8, 12).join(""),
    hex.slice(12, 16).join(""),
    hex.slice(16, 20).join(""),
    hex.slice(20, 32).join(""),
  ].join("-");
}

function hashSteps(steps: AgentControlStep[]): string {
  return createHash("sha256").update(JSON.stringify(steps)).digest("hex");
}

function buildSteps(
  tools: Array<{ name: string; label?: string; description?: string; parameters?: unknown }>,
): AgentControlStep[] {
  const deduped = new Map<string, AgentControlStep>();

  for (const tool of tools) {
    const name = asString(tool.name);
    if (!name) {
      continue;
    }

    const step: AgentControlStep = {
      type: "tool",
      name,
    };

    const description = asString(tool.description) ?? asString(tool.label);
    if (description) {
      step.description = description;
    }

    if (isRecord(tool.parameters)) {
      step.inputSchema = tool.parameters;
    }

    const label = asString(tool.label);
    if (label) {
      step.metadata = { label };
    }

    deduped.set(name, step);
  }

  return [...deduped.values()];
}

function collectDenyControlNames(response: {
  matches?: Array<{ action?: string; controlName?: string }>;
  errors?: Array<{ action?: string; controlName?: string }>;
}): string[] {
  const names: string[] = [];
  for (const match of [...(response.matches ?? []), ...(response.errors ?? [])]) {
    if (
      match.action === "deny" &&
      typeof match.controlName === "string" &&
      match.controlName.trim()
    ) {
      names.push(match.controlName.trim());
    }
  }
  return [...new Set(names)];
}

function buildBlockReason(response: {
  reason?: string | null;
  matches?: Array<{ action?: string; controlName?: string }>;
  errors?: Array<{ action?: string; controlName?: string }>;
}): string {
  const denyControls = collectDenyControlNames(response);
  if (denyControls.length > 0) {
    return `[agent-control] blocked by deny control(s): ${denyControls.join(", ")}`;
  }
  if (typeof response.reason === "string" && response.reason.trim().length > 0) {
    return `[agent-control] ${response.reason.trim()}`;
  }
  return "[agent-control] blocked by policy evaluation";
}

function resolveSourceAgentId(agentId: string | undefined): string {
  const normalized = asString(agentId);
  return normalized ?? "default";
}

function formatToolArgsForLog(params: unknown): string {
  if (params === undefined) {
    return "undefined";
  }
  try {
    const encoded = JSON.stringify(params);
    if (typeof encoded !== "string") {
      return trimToMax(String(params), 1000);
    }
    return trimToMax(encoded, 1000);
  } catch {
    return "[unserializable]";
  }
}

function loadPluginConfig(api: OpenClawPluginApi): AgentControlPluginConfig {
  const raw = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  return raw as unknown as AgentControlPluginConfig;
}

export default function register(api: OpenClawPluginApi) {
  const cfg = loadPluginConfig(api);
  if (cfg.enabled === false) {
    return;
  }

  const serverUrl = asString(cfg.serverUrl) ?? asString(process.env.AGENT_CONTROL_SERVER_URL);
  if (!serverUrl) {
    api.logger.warn(
      "agent-control: disabled because serverUrl is not configured (plugins.entries.agent-control.serverUrl)",
    );
    return;
  }

  const configuredAgentId = asString(cfg.agentId);
  if (configuredAgentId && !isUuid(configuredAgentId)) {
    api.logger.warn(`agent-control: configured agentId is not a UUID: ${configuredAgentId}`);
  }

  const failClosed = cfg.failClosed === true;
  const baseAgentName = asString(cfg.agentName) ?? "openclaw-agent";
  const configuredAgentVersion = asString(cfg.agentVersion);

  const client = new AgentControlClient();
  client.init({
    agentName: baseAgentName,
    serverUrl,
    apiKey: asString(cfg.apiKey) ?? asString(process.env.AGENT_CONTROL_API_KEY),
    timeoutMs: asPositiveInt(cfg.timeoutMs),
    userAgent: asString(cfg.userAgent) ?? "openclaw-agent-control-plugin/0.1",
  });

  const states = new Map<string, AgentState>();

  const getOrCreateState = (sourceAgentId: string): AgentState => {
    const existing = states.get(sourceAgentId);
    if (existing) {
      return existing;
    }

    const agentUuid =
      configuredAgentId && isUuid(configuredAgentId)
        ? configuredAgentId
        : buildDeterministicUuid(`openclaw:agent-control:${sourceAgentId}`);
    const agentName =
      configuredAgentId && isUuid(configuredAgentId)
        ? trimToMax(baseAgentName, 255)
        : trimToMax(`${baseAgentName}:${sourceAgentId}`, 255);

    const created: AgentState = {
      sourceAgentId,
      agentUuid,
      agentName,
      steps: [],
      stepsHash: hashSteps([]),
      lastSyncedStepsHash: null,
      syncPromise: null,
    };
    states.set(sourceAgentId, created);
    return created;
  };

  const syncAgent = async (state: AgentState): Promise<void> => {
    if (state.syncPromise) {
      await state.syncPromise;
      return;
    }
    if (state.lastSyncedStepsHash === state.stepsHash) {
      return;
    }

    const currentHash = state.stepsHash;
    const promise = (async () => {
      await client.agents.initAgentApiV1AgentsInitAgentPost({
        agent: {
          agentId: state.agentUuid,
          agentName: state.agentName,
          agentVersion: configuredAgentVersion,
          agentMetadata: {
            source: "openclaw",
            openclawAgentId: state.sourceAgentId,
            pluginId: api.id,
          },
        },
        steps: state.steps,
      });
      state.lastSyncedStepsHash = currentHash;
    })().finally(() => {
      state.syncPromise = null;
    });

    state.syncPromise = promise;
    await promise;

    // If tools changed while we were syncing, reconcile immediately.
    if (state.stepsHash !== state.lastSyncedStepsHash) {
      await syncAgent(state);
    }
  };

  api.on("after_tools_resolved", async (event, ctx) => {
    const sourceAgentId = resolveSourceAgentId(ctx.agentId);
    const state = getOrCreateState(sourceAgentId);
    state.steps = buildSteps(event.tools);
    state.stepsHash = hashSteps(state.steps);

    try {
      await syncAgent(state);
    } catch (err) {
      api.logger.warn(`agent-control: initAgent failed for agent=${sourceAgentId}: ${String(err)}`);
    }
  });

  api.on(
    "before_tool_call",
    async (event, ctx) => {
      const sourceAgentId = resolveSourceAgentId(ctx.agentId);
      const state = getOrCreateState(sourceAgentId);
      const argsForLog = formatToolArgsForLog(event.params);
      api.logger.info(
        `agent-control: before_tool_call entered agent=${sourceAgentId} tool=${event.toolName} args=${argsForLog}`,
      );

      try {
        await syncAgent(state);
      } catch (err) {
        api.logger.warn(
          `agent-control: unable to sync agent=${sourceAgentId} before tool evaluation: ${String(err)}`,
        );
        if (failClosed) {
          return {
            block: true,
            blockReason:
              "[agent-control] blocked: guardrail service unavailable (registration failed)",
          };
        }
        return;
      }

      try {
        const evaluation = await client.evaluation.evaluateApiV1EvaluationPost({
          body: {
            agentUuid: state.agentUuid,
            stage: "pre",
            step: {
              type: "tool",
              name: event.toolName,
              input: event.params,
              context: {
                openclawAgentId: sourceAgentId,
                sessionKey: ctx.sessionKey ?? null,
              },
            },
          },
        });

        if (evaluation.isSafe) {
          api.logger.info("safe !");
          return;
        }

        api.logger.info("unsafe !");

        return {
          block: true,
          blockReason: buildBlockReason(evaluation),
        };
      } catch (err) {
        api.logger.warn(
          `agent-control: evaluation failed for agent=${sourceAgentId} tool=${event.toolName}: ${String(err)}`,
        );
        if (failClosed) {
          return {
            block: true,
            blockReason:
              "[agent-control] blocked: guardrail service unavailable (evaluation failed)",
          };
        }
      }
    },
    { priority: 100 },
  );
}
