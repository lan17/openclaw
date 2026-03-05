import { beforeEach, describe, expect, it, vi } from "vitest";
import register from "./index.js";

const {
  clientInitMock,
  initAgentMock,
  evaluateMock,
  createOpenClawCodingToolsMock,
  toToolDefinitionsMock,
} = vi.hoisted(() => ({
  clientInitMock: vi.fn(),
  initAgentMock: vi.fn(),
  evaluateMock: vi.fn(),
  createOpenClawCodingToolsMock: vi.fn(),
  toToolDefinitionsMock: vi.fn(),
}));

vi.mock("agent-control", () => {
  class MockAgentControlClient {
    init = clientInitMock;
    agents = {
      init: initAgentMock,
    };
    evaluation = {
      evaluate: evaluateMock,
    };
  }

  return { AgentControlClient: MockAgentControlClient };
});

vi.mock("../../src/agents/pi-tools.js", () => ({
  createOpenClawCodingTools: createOpenClawCodingToolsMock,
}));

vi.mock("../../src/agents/pi-tool-definition-adapter.js", () => ({
  toToolDefinitions: toToolDefinitionsMock,
}));

type HookRegistration = {
  handler: (...args: any[]) => Promise<unknown> | unknown;
  opts?: { priority?: number };
};

function createApi(pluginConfig: Record<string, unknown>) {
  const hooks: Record<string, HookRegistration> = {};
  const api = {
    id: "agent-control",
    pluginConfig,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
    on: vi.fn(
      (name: string, handler: HookRegistration["handler"], opts?: HookRegistration["opts"]) => {
        hooks[name] = { handler, opts };
      },
    ),
  };
  return { api, hooks };
}

describe("agent-control plugin", () => {
  beforeEach(() => {
    clientInitMock.mockReset();
    initAgentMock.mockReset();
    evaluateMock.mockReset();
    createOpenClawCodingToolsMock.mockReset().mockReturnValue([]);
    toToolDefinitionsMock.mockReset().mockReturnValue([]);
  });

  it("registers hooks and initializes SDK client", () => {
    const { api, hooks } = createApi({ serverUrl: "http://localhost:8000" });
    register(api as any);

    expect(clientInitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "openclaw-agent",
        serverUrl: "http://localhost:8000",
      }),
    );
    expect(hooks.after_tools_resolved).toBeUndefined();
    expect(hooks.before_tool_call).toBeDefined();
    expect(hooks.before_tool_call.opts?.priority).toBe(100);
  });

  it("syncs agent and tool schemas before evaluating before_tool_call", async () => {
    initAgentMock.mockResolvedValue({ created: true, controls: [] });
    evaluateMock.mockResolvedValue({ isSafe: true, confidence: 1, reason: null });
    createOpenClawCodingToolsMock.mockReturnValue([
      {
        name: "exec",
        description: "Run shell command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
      {
        name: "read",
        label: "Read File",
      },
    ]);
    toToolDefinitionsMock.mockReturnValue([
      {
        name: "exec",
        label: "exec",
        description: "Run shell command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
      {
        name: "read",
        label: "Read File",
        description: "",
      },
    ]);

    const { api, hooks } = createApi({ serverUrl: "http://localhost:8000" });
    register(api as any);

    await hooks.before_tool_call.handler(
      {
        toolName: "exec",
        params: { command: "echo hi" },
      },
      {
        agentId: "main",
        sessionKey: "session-1",
        sessionId: "session-abc",
        runId: "run-abc",
      },
    );

    expect(createOpenClawCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionKey: "session-1",
        sessionId: "session-abc",
        runId: "run-abc",
        senderIsOwner: true,
      }),
    );
    expect(toToolDefinitionsMock).toHaveBeenCalledTimes(1);
    expect(initAgentMock).toHaveBeenCalledTimes(1);
    expect(initAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({
          agentName: "openclaw-agent:main",
        }),
        steps: expect.arrayContaining([
          expect.objectContaining({
            type: "tool",
            name: "exec",
            description: "Run shell command",
            inputSchema: expect.objectContaining({
              type: "object",
            }),
          }),
          expect.objectContaining({
            type: "tool",
            name: "read",
            description: "Read File",
            metadata: { label: "Read File" },
          }),
        ]),
      }),
    );
  });

  it("blocks tool execution when evaluation is unsafe", async () => {
    initAgentMock.mockResolvedValue({ created: true, controls: [] });
    evaluateMock.mockResolvedValue({
      isSafe: false,
      confidence: 1,
      reason: "destructive command",
      matches: [{ action: "deny", controlName: "deny-destructive-cmd" }],
    });

    const { api, hooks } = createApi({ serverUrl: "http://localhost:8000" });
    register(api as any);

    const result = await hooks.before_tool_call.handler(
      {
        toolName: "exec",
        params: { command: "rm -rf /" },
      },
      {
        agentId: "main",
        sessionKey: "session-1",
        toolName: "exec",
      },
    );

    expect(evaluateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          agentName: "openclaw-agent:main",
          stage: "pre",
          step: expect.objectContaining({
            type: "tool",
            name: "exec",
            input: { command: "rm -rf /" },
          }),
        }),
      }),
    );
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        'before_tool_call entered agent=main tool=exec args={"command":"rm -rf /"}',
      ),
    );
    expect(result).toEqual(
      expect.objectContaining({
        block: true,
      }),
    );
  });

  it("fails open by default when evaluation request errors", async () => {
    initAgentMock.mockResolvedValue({ created: true, controls: [] });
    evaluateMock.mockRejectedValue(new Error("network down"));

    const { api, hooks } = createApi({ serverUrl: "http://localhost:8000" });
    register(api as any);

    const result = await hooks.before_tool_call.handler(
      { toolName: "exec", params: { command: "ls" } },
      { agentId: "main", sessionKey: "session-1", toolName: "exec" },
    );

    expect(result).toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("evaluation failed"));
  });

  it("blocks when failClosed=true and evaluation request errors", async () => {
    initAgentMock.mockResolvedValue({ created: true, controls: [] });
    evaluateMock.mockRejectedValue(new Error("network down"));

    const { api, hooks } = createApi({
      serverUrl: "http://localhost:8000",
      failClosed: true,
    });
    register(api as any);

    const result = await hooks.before_tool_call.handler(
      { toolName: "exec", params: { command: "ls" } },
      { agentId: "main", sessionKey: "session-1", toolName: "exec" },
    );

    expect(result).toEqual({
      block: true,
      blockReason: "[agent-control] blocked: guardrail service unavailable (evaluation failed)",
    });
  });
});
