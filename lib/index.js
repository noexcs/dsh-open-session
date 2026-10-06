// src/index.ts
import { mkdir } from "node:fs/promises";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/open-session.ts
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
var OPEN_SESSION_TOOL = "open_session";
function mintSessionId() {
  return `session-${randomUUID()}`;
}
function planOpenSession(args, sessionId = mintSessionId()) {
  const cwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
  if (cwd === "") throw new Error("cwd is required: the absolute path the new session should work in");
  if (!isAbsolute(cwd)) throw new Error(`cwd must be an absolute path, got "${cwd}"`);
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) throw new Error(`cwd is not an existing directory: ${cwd}`);
  const preset = args.preset;
  if (preset !== void 0 && typeof preset !== "string") throw new Error("preset must be a preset name");
  const agentPreset = typeof preset === "string" && preset.trim() !== "" ? preset.trim() : void 0;
  const message = textArgument(args.message, "message");
  const title = textArgument(args.title, "title");
  return {
    sessionId,
    cwd,
    ...agentPreset === void 0 ? {} : { agentPreset },
    ...message === void 0 ? {} : { message },
    ...title === void 0 ? {} : { title }
  };
}
function deriveTitle(message) {
  if (message === void 0) return void 0;
  const line = message.split("\n").map((candidate) => candidate.trim()).find((candidate) => candidate !== "");
  if (line === void 0) return void 0;
  const collapsed = line.replace(/\s+/g, " ").replace(/^[#>*\-\s]+/, "");
  if (collapsed === "") return void 0;
  return collapsed.length <= 60 ? collapsed : `${collapsed.slice(0, 57)}\u2026`;
}
function textArgument(value, name2) {
  if (value === void 0) return void 0;
  if (typeof value !== "string") throw new Error(`${name2} must be a string`);
  const trimmed = value.trim();
  if (trimmed === "") throw new Error(`${name2} was given but is empty`);
  return trimmed;
}
function formatOpenSession(report) {
  const lines = [`session=${report.plan.sessionId}`, `cwd=${report.plan.cwd}`];
  const preset = report.agentPreset ?? report.plan.agentPreset;
  if (preset !== void 0) lines.push(`preset=${preset}`);
  const title = report.title ?? report.plan.title;
  if (title !== void 0) lines.push(`title=${title}`);
  if (report.plan.message !== void 0) lines.push("firstMessage=sent (the session is no longer blank)");
  lines.push(
    report.workspace === void 0 ? "workspace=(not accounted: this host has no workspace registry, so the session has no list entry)" : `workspace=${report.workspace}`
  );
  return lines.join("\n");
}

// src/index.ts
var name = "dsh-open-session";
var inject = ["agents", "tools"];
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
var OPEN_SESSION_TEXT = [
  "Open a new root session on this host, in an absolute working directory, and report its session id.",
  "",
  "Opening a session is a real, durable side effect, not a transient task: it starts a new live agent with its own conversation, and its entry in the host's session list lives exactly as long as that agent does. The session appears in the host's session list and stays there until the host disposes or stops it.",
  "",
  "The session is created the way this host creates one \u2014 the directory is ensured, the agent preset's scoped world (tools, prompt, model selection) is composed, and the session is accounted in its workspace so the host's session list shows it.",
  "",
  "Give it a `message` and that message is the new session's first prompt: it is sent as soon as the session exists, it is what takes the session out of the host's *blank* state (blank sessions are hidden from the host's session list unless they are the one being viewed), and it is how standing instructions travel to a session that has no one watching it \u2014 for example telling a session opened to serve another agent to act on that agent's work without asking its user about each step.",
  "",
  "Guidelines:",
  "- Pass the working directory you actually mean. It must be an existing directory \u2014 an absolute path the host can stat \u2014 or the call is refused.",
  "- Prefer one session for one piece of work. Do not open sessions in a loop, and do not open one to run a single command \u2014 this session can do that itself, and a subagent is the tool for a bounded side task.",
  "- A `message` starts a turn in the new session, which costs model tokens; a session opened without one stays blank and will not appear in the list until someone speaks to it.",
  "- Pass `title` when `message` is long: the derived title is only the message's first line, and is never a substitute for a real name.",
  "- This tool only opens sessions; it cannot close one. Closing is the host's (or the user's) decision.",
  "- A fresh session is idle right after it is opened: open it in the host's session list and type there."
].join("\n");
function dshOpenSessionTool(deps) {
  const parameters = {
    cwd: {
      type: "string",
      required: true,
      description: "Absolute path the new session works in. The directory must already exist."
    },
    preset: {
      type: "string",
      description: "Optional host agent-preset name; omitted means the host's default preset."
    },
    message: {
      type: "string",
      description: "First prompt for the new session, sent as soon as it exists. Also what makes it visible in the host's session list."
    },
    title: {
      type: "string",
      description: "Optional title. Omitted, one is derived from the first line of `message`; pass it when the message is long."
    }
  };
  return defineTool({
    name: OPEN_SESSION_TOOL,
    description: OPEN_SESSION_TEXT,
    parameters,
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }]
    },
    async execute(args) {
      const plan = planOpenSession(args);
      const outcome = await deps.open(plan);
      return formatOpenSession({
        plan,
        ...outcome.agentPreset === void 0 ? {} : { agentPreset: outcome.agentPreset },
        ...outcome.title === void 0 ? {} : { title: outcome.title },
        ...outcome.workspace === void 0 ? {} : { workspace: outcome.workspace }
      });
    }
  });
}
function apply(ctx) {
  const report = (message, error) => {
    const line = error === void 0 ? message : `${message}: ${describeError(error)}`;
    ctx.logger.warn(line);
  };
  async function openHostSession(callerSessionId, plan) {
    await mkdir(plan.cwd, { recursive: true });
    const presets = ctx.get("agentPresets");
    let agentPreset;
    let setup;
    if (presets !== void 0) {
      const resolved = await presets.resolve(plan.agentPreset);
      agentPreset = resolved.id;
      setup = async (agentCtx) => {
        await presets.mount(agentCtx, resolved.id);
      };
    }
    const defaultModel = ctx.get("agentDefaultModel");
    const selection = defaultModel?.currentSelection();
    const registry = ctx.agents;
    const handle = await registry.create({
      sessionId: plan.sessionId,
      ...selection === void 0 ? {} : { agentOptions: selection },
      meta: agentPreset === void 0 ? { cwd: plan.cwd } : { cwd: plan.cwd, agentPreset },
      ...setup === void 0 ? {} : { setup }
    });
    if (plan.message !== void 0 && handle.agent !== void 0) {
      handle.agent.followup(
        createUserMessage({
          content: [{ type: "text", text: plan.message }],
          source: {
            kind: "open-session",
            openedBy: callerSessionId,
            form: "relay",
            summary: boundContextSummary(plan.message)
          }
        })
      );
    }
    const titled = titleFor(plan);
    const base = agentPreset === void 0 ? {} : { agentPreset };
    const titledBase = titled === void 0 ? base : { ...base, title: titled };
    const workspaces = ctx.get("workspaceRegistry");
    if (workspaces === void 0) return titledBase;
    try {
      const workspace = await workspaces.resolveByPath(plan.cwd) ?? await workspaces.create(plan.cwd);
      await workspace.attachSession?.(plan.sessionId);
      return { ...titledBase, workspace: plan.cwd };
    } catch (error) {
      report(`[dsh-open-session] the session ${plan.sessionId} could not be accounted in a workspace`, error);
      return titledBase;
    }
  }
  function titleFor(plan) {
    const title = plan.title ?? deriveTitle(plan.message);
    if (title === void 0) return void 0;
    const sessions = ctx.get("sessions");
    const titles = ctx.get("sessionTitle");
    const target = sessions?.get(plan.sessionId);
    if (target === void 0 || titles === void 0) return void 0;
    try {
      return titles.rename(target, title)?.title ?? title;
    } catch (error) {
      report(`[dsh-open-session] the session ${plan.sessionId} could not be titled`, error);
      return void 0;
    }
  }
  const registered = /* @__PURE__ */ new Set();
  function bind(agent) {
    const scoped = agent.ctx;
    const sessionId = String(agent.session.id);
    if (registered.has(sessionId)) return;
    registered.add(sessionId);
    const callerSessionId = String(agent.session.id);
    scoped.tools.register(
      dshOpenSessionTool({
        open: (plan) => openHostSession(callerSessionId, plan)
      })
    );
  }
  ctx.on("agent/created", async (payload) => {
    try {
      bind(payload.agent);
    } catch (error) {
      report("[dsh-open-session] could not register open_session in a new session", error);
    }
  });
  ctx.on("agent/disposed", (payload) => {
    registered.delete(String(payload.agent.session.id));
  });
  for (const agent of ctx.agents.list()) {
    try {
      bind(agent);
    } catch (error) {
      report("[dsh-open-session] could not register open_session in an already-live session", error);
    }
  }
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
