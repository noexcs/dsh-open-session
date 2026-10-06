/**
 * dsh-open-session — a DeepSeek Harness host plugin.
 *
 * One host capability as a model-facing tool: `open_session` opens a new root session on this host the way
 * the host's own new-session path does — the working directory is ensured, the agent preset's scoped world
 * is composed, the model selection a fresh session would log is carried along, and the session is accounted
 * in its workspace so the host's session list shows it. Optionally it is given a first prompt, which takes
 * it out of the host's "blank" state and is how standing instructions travel to a session that has no one
 * watching it.
 *
 * The plugin registers nothing globally: the tool lands on each agent's own scope when that agent is
 * created (`agent/created`), and every host service the recipe may use is optional and read **at call
 * time** — a headless or SDK host without a preset registry, a default model, or a workspace registry
 * still gets a working tool, and an accounting failure costs the list entry, never the session.
 */

import { mkdir } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-tools";
import { defineTool, type ParameterSchemaSpec } from "@deepseek-ai/dsh-tools";

import type {} from "./dsh.ts";
import {
	deriveTitle,
	formatOpenSession,
	OPEN_SESSION_TOOL,
	type OpenSessionOutcome,
	type OpenSessionPlan,
	planOpenSession,
	type SessionOpener,
} from "./open-session.ts";

/** Cordis plugin name: what a profile's patch layer inserts. */
export const name = "dsh-open-session";

/** The host services this plugin needs before it can register anything. */
export const inject = ["agents", "tools"];

/**
 * The parts of a live DeepSeek Harness agent this plugin uses.
 *
 * Structural on purpose: the host's `Agent` class is assigned into it, and this plugin then depends on two
 * fields rather than on an import that could drift.
 */
interface HostAgent {
	readonly session: { readonly id: unknown };
	readonly ctx: Context;
}

/** A stable, human reason from an unknown thrown value. */
function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The slice of the host's agent registry `open_session` uses, declared structurally.
 *
 * The registered method is `agents.create(options)`, which the host's factory turns into a published session:
 * the session is created and the agent is announced on top of it. Announcement is awaited and runs the
 * creation listeners, so a session created here is a first-class session before the call resolves.
 */
interface AgentRegistryPort {
	create(options: {
		readonly sessionId: string;
		readonly agentOptions?: unknown;
		readonly meta: { readonly cwd: string; readonly agentPreset?: string };
		readonly setup?: unknown;
	}): Promise<AgentHandlePort>;
}

/** The handle a created session is driven through: its first prompt goes in here. */
interface AgentHandlePort {
	readonly agent?: { followup(message: unknown): void };
}

/** The session store, used only to hand the title service the session object it titles. */
interface SessionsPort {
	get(id: string): unknown;
}

/** The title service: `rename` sets a title outright. */
interface SessionTitlePort {
	rename(session: unknown, title: string): { readonly title?: string } | undefined;
}

/** The agent-preset registry: `resolve` names the preset, `mount` composes its scoped world. */
interface AgentPresetsPort {
	resolve(id?: string): Promise<{ id: string }>;
	mount(agentCtx: unknown, id?: string): Promise<unknown>;
}

/** The default model selection a fresh session logs when the user has not chosen one for it. */
interface AgentDefaultModelPort {
	currentSelection(): unknown;
}

/** One workspace's member list — the durable state a host's own session list is built from. */
interface WorkspacePort {
	attachSession?(sessionId: string): Promise<void>;
}

/** The workspace registry. `resolveByPath`/`create` are its public halves; `attachSession` is on the workspace. */
interface WorkspaceRegistryPort {
	resolveByPath(path: string): Promise<WorkspacePort | undefined>;
	create(path: string, title?: string): Promise<WorkspacePort>;
}

/** The model-facing text of the one tool this plugin contributes. */
const OPEN_SESSION_TEXT = [
	"Open a new root session on this host, in an absolute working directory, and report its session id.",
	"",
	"Opening a session is a real, durable side effect, not a transient task: it starts a new live agent with its own conversation, and its entry in the host's session list lives exactly as long as that agent does. The session appears in the host's session list and stays there until the host disposes or stops it.",
	"",
	"The session is created the way this host creates one — the directory is ensured, the agent preset's scoped world (tools, prompt, model selection) is composed, and the session is accounted in its workspace so the host's session list shows it.",
	"",
	"Give it a `message` and that message is the new session's first prompt: it is sent as soon as the session exists, it is what takes the session out of the host's *blank* state (blank sessions are hidden from the host's session list unless they are the one being viewed), and it is how standing instructions travel to a session that has no one watching it — for example telling a session opened to serve another agent to act on that agent's work without asking its user about each step.",
	"",
	"Guidelines:",
	"- Pass the working directory you actually mean. It must be an existing directory — an absolute path the host can stat — or the call is refused.",
	"- Prefer one session for one piece of work. Do not open sessions in a loop, and do not open one to run a single command — this session can do that itself, and a subagent is the tool for a bounded side task.",
	"- A `message` starts a turn in the new session, which costs model tokens; a session opened without one stays blank and will not appear in the list until someone speaks to it.",
	"- Pass `title` when `message` is long: the derived title is only the message's first line, and is never a substitute for a real name.",
	"- This tool only opens sessions; it cannot close one. Closing is the host's (or the user's) decision.",
	"- A fresh session is idle right after it is opened: open it in the host's session list and type there.",
].join("\n");

/**
 * Build the `open_session` tool for one session, from the one host operation it needs.
 *
 * The caller's session id is not an argument of this function: it is bound into the `open` closure by the
 * registration, and it is where the first prompt's `openedBy` provenance comes from.
 */
function dshOpenSessionTool(deps: { readonly open: SessionOpener["open"] }) {
	const parameters: ParameterSchemaSpec = {
		cwd: {
			type: "string",
			required: true,
			description: "Absolute path the new session works in. The directory must already exist.",
		},
		preset: {
			type: "string",
			description: "Optional host agent-preset name; omitted means the host's default preset.",
		},
		message: {
			type: "string",
			description:
				"First prompt for the new session, sent as soon as it exists. Also what makes it visible in the host's session list.",
		},
		title: {
			type: "string",
			description:
				"Optional title. Omitted, one is derived from the first line of `message`; pass it when the message is long.",
		},
	};
	return defineTool({
		name: OPEN_SESSION_TOOL,
		description: OPEN_SESSION_TEXT,
		parameters,
		output: {
			schema: { type: "string" as const },
			render: (_args: unknown, value: string) => [{ type: "text" as const, text: value }],
		},
		async execute(args: Record<string, unknown>) {
			const plan = planOpenSession(args);
			const outcome = await deps.open(plan);
			return formatOpenSession({
				plan,
				...(outcome.agentPreset === undefined ? {} : { agentPreset: outcome.agentPreset }),
				...(outcome.title === undefined ? {} : { title: outcome.title }),
				...(outcome.workspace === undefined ? {} : { workspace: outcome.workspace }),
			});
		},
	});
}

/**
 * Register the plugin: the tool on each agent's own scope, as each agent is created.
 *
 * The registration point is the host's own lifecycle: `agent/created` is awaited by the host's factory, so a
 * session that fails to publish cannot leave a registration behind, and the agent's own scope is where the
 * tool lands — a session that does not want it never sees it.
 */
export function apply(ctx: Context): void {
	/** A problem that must be visible but must never take a session down. */
	const report = (message: string, error?: unknown): void => {
		const line = error === undefined ? message : `${message}: ${describeError(error)}`;
		ctx.logger.warn(line);
	};

	/**
	 * The host's own recipe for a session — the one its "new session" path uses.
	 *
	 * Seven steps, and every one of them matters for the result to be an ordinary session rather than a
	 * half-built one: validate the working directory (the recursive `mkdir` here is a race safety net, not the
	 * creation path), compose the preset's scoped world, carry the model selection a
	 * fresh session would log, create the agent, deliver the first prompt, set the title, and account the
	 * session in its workspace. Skipping the last step is the subtle one: a session's workspace membership
	 * is explicit durable state, not something derived from its working directory, so a session that is
	 * created but never attached is persisted — and absent from the host's session list.
	 *
	 * Every service here is optional and read **at call time**: a headless or SDK host has no preset
	 * registry, no workspace registry, and possibly no default model, and this plugin must still work there.
	 */
	async function openHostSession(callerSessionId: string, plan: OpenSessionPlan): Promise<OpenSessionOutcome> {
		await mkdir(plan.cwd, { recursive: true });

		const presets = ctx.get("agentPresets") as AgentPresetsPort | undefined;
		let agentPreset: string | undefined;
		let setup: ((agentCtx: unknown, agent: unknown) => Promise<void>) | undefined;
		if (presets !== undefined) {
			const resolved = await presets.resolve(plan.agentPreset);
			agentPreset = resolved.id;
			setup = async (agentCtx: unknown) => {
				await presets.mount(agentCtx, resolved.id);
			};
		}

		const defaultModel = ctx.get("agentDefaultModel") as AgentDefaultModelPort | undefined;
		const selection = defaultModel?.currentSelection();

		const registry = ctx.agents as unknown as AgentRegistryPort;
		const handle = await registry.create({
			sessionId: plan.sessionId,
			...(selection === undefined ? {} : { agentOptions: selection }),
			meta: agentPreset === undefined ? { cwd: plan.cwd } : { cwd: plan.cwd, agentPreset },
			...(setup === undefined ? {} : { setup }),
		});

		// The first prompt. Two things depend on it: the session leaves the host's `blank` state (and blank
		// sessions are hidden from the host's session list unless they are the one being viewed), and it is
		// where a caller states standing instructions for a session that has no one watching it.
		if (plan.message !== undefined && handle.agent !== undefined) {
			handle.agent.followup(
				createUserMessage({
					content: [{ type: "text", text: plan.message }],
					source: {
						kind: "open-session",
						openedBy: callerSessionId,
						form: "relay",
						summary: boundContextSummary(plan.message),
					},
				}),
			);
		}
		const titled = titleFor(plan);

		const base: OpenSessionOutcome = agentPreset === undefined ? {} : { agentPreset };
		const titledBase: OpenSessionOutcome = titled === undefined ? base : { ...base, title: titled };

		const workspaces = ctx.get("workspaceRegistry") as WorkspaceRegistryPort | undefined;
		if (workspaces === undefined) return titledBase;
		try {
			const workspace = (await workspaces.resolveByPath(plan.cwd)) ?? (await workspaces.create(plan.cwd));
			await workspace.attachSession?.(plan.sessionId);
			return { ...titledBase, workspace: plan.cwd };
		} catch (error) {
			// Creation succeeded; only the list entry is missing. Report that rather than failing a live session.
			report(`[dsh-open-session] the session ${plan.sessionId} could not be accounted in a workspace`, error);
			return titledBase;
		}
	}

	/**
	 * Name the new session.
	 *
	 * An explicit `title` is set verbatim; otherwise one is derived from the first line of `message`, which is
	 * deterministic and free. With neither, nothing is set: the host's own first-prompt titler may fill it in
	 * later, and this tool does not second-guess it.
	 */
	function titleFor(plan: OpenSessionPlan): string | undefined {
		const title = plan.title ?? deriveTitle(plan.message);
		if (title === undefined) return undefined;
		const sessions = ctx.get("sessions") as SessionsPort | undefined;
		const titles = ctx.get("sessionTitle") as SessionTitlePort | undefined;
		const target = sessions?.get(plan.sessionId);
		if (target === undefined || titles === undefined) return undefined;
		try {
			return titles.rename(target, title)?.title ?? title;
		} catch (error) {
			report(`[dsh-open-session] the session ${plan.sessionId} could not be titled`, error);
			return undefined;
		}
	}

	/**
	 * Live sessions that already carry the tool.
	 *
	 * Two edges can register the same agent — the `agent/created` edge and the backfill below — and this guard is
	 * what keeps one agent from ending up with two tools of the same name. It is cleared when an agent is
	 * disposed, on purpose: a resumed session is a *new* agent with a new scope, and it has to register again.
	 */
	const registered = new Set<string>();

	/** Register the per-agent surface. Everything here unwinds with the agent's own scope. */
	function bind(agent: HostAgent): void {
		const scoped = agent.ctx;
		const sessionId = String(agent.session.id);
		if (registered.has(sessionId)) return;
		registered.add(sessionId);
		// The caller's own session id, bound into the opener: it is where the first prompt's `openedBy`
		// provenance comes from, and it is read here, once per agent, not at plugin load.
		const callerSessionId = String(agent.session.id);
		scoped.tools.register(
			dshOpenSessionTool({
				open: (plan) => openHostSession(callerSessionId, plan),
			}),
		);
	}

	ctx.on("agent/created", async (payload) => {
		try {
			bind(payload.agent as unknown as HostAgent);
		} catch (error) {
			report("[dsh-open-session] could not register open_session in a new session", error);
		}
	});

	ctx.on("agent/disposed", (payload) => {
		registered.delete(String((payload.agent as unknown as HostAgent).session.id));
	});

	// Backfill. An agent that was already live when this plugin loaded never sees an `agent/created` edge of its
	// own — a reload, an enable, or a profile that inserted this row after the session had started — so without
	// this the tool would exist only in sessions created after a host restart.
	for (const agent of ctx.agents.list()) {
		try {
			bind(agent as unknown as HostAgent);
		} catch (error) {
			report("[dsh-open-session] could not register open_session in an already-live session", error);
		}
	}
}
