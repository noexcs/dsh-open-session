/**
 * The plugin entry itself: what `apply()` registers, on which lifecycle event, and what the tool does
 * when it is called.
 *
 * This file covers the binding — the only code that touches the host — against a stub host context (a
 * real Cordis host is not available here), but through the host's *own* `defineTool` and
 * `createUserMessage`, so a schema or a message source this plugin declares wrong fails here rather than
 * in a profile. Every optional host service is present in the stub by default and switchable off, which
 * is what the headless-host case needs.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";

import { apply, inject, name } from "../src/index.ts";
import { OPEN_SESSION_TOOL } from "../src/open-session.ts";

const workspaces: string[] = [];

async function freshWorkspace(): Promise<string> {
	const workspace = await mkdtemp(join(tmpdir(), "dsh-open-session-test-"));
	workspaces.push(workspace);
	return workspace;
}

afterEach(async () => {
	for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true });
});

/** One recorded registration or host call, so an assertion can name what `apply()` did rather than what it logged. */
interface Recorded {
	/** Tools registered on an agent's own scope. */
	tools: Array<{ name: string; description: string; parameters: unknown }>;
	/** Lifecycle handlers by event name. */
	events: Map<string, Array<(payload: unknown) => unknown>>;
	/** The live agents the host would report: what the backfill reads. */
	liveAgents: unknown[];
	/** Effects as Cordis runs them: the initializer ran, and its returned disposer is kept under its label. */
	effects: Array<{ label: string; disposer: unknown }>;
	/** Every `agents.create()` the plugin asked the host for: the sessions it opened. */
	opened: Array<Record<string, unknown>>;
	/** Preset ids the plugin mounted into a new session's scoped world. */
	mounted: string[];
	/** Sessions the plugin accounted in a workspace: `{path, sessionId}`. */
	attached: Array<{ path: string; sessionId: string }>;
	/** First prompts delivered to a newly opened session. */
	prompts: Array<{ readonly content: ReadonlyArray<{ readonly text?: string }>; readonly source?: unknown }>;
	/** Titles the plugin set on a newly opened session: `{session, title}`. */
	renamed: Array<{ session: unknown; title: string }>;
}

function newRecorded(): Recorded {
	return {
		tools: [],
		events: new Map(),
		liveAgents: [],
		effects: [],
		opened: [],
		mounted: [],
		attached: [],
		prompts: [],
		renamed: [],
	};
}

/** A stub host: only what this plugin calls, and every call recorded. */
function stubHost(recorded: Recorded, options: { hostServices?: boolean; workspaceFails?: boolean } = {}) {
	const scoped = {
		tools: {
			register: (definition: { name: string; description: string; parameters: unknown }) => {
				recorded.tools.push(definition);
				return () => {};
			},
		},
		on: (event: string, handler: (payload: unknown) => unknown) => {
			recorded.events.set(event, [...(recorded.events.get(event) ?? []), handler]);
			return () => {};
		},
	};
	const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
	const ctx = {
		logger,
		// The plugin-level registration surface: this plugin registers nothing there — the tool lands on
		// the agent's own scope, and a stub that answered it would hide that.
		tools: scoped.tools,
		agents: {
			list: () => recorded.liveAgents,
			// The created session is *not* really created here: the stub only records the request and plays
			// back the handle, which is the whole of what the recipe does with it.
			create: async (options: Record<string, unknown>) => {
				recorded.opened.push(options);
				return {
					agent: {
						// The created session's first prompt lands here, exactly as the host would deliver it.
						followup: (message: unknown) => recorded.prompts.push(message as Recorded["prompts"][number]),
					},
					dispose: async () => {},
				};
			},
		},
		// Cordis runs the initializer immediately and treats its return value as the disposer; the stub does
		// the same, because a plugin that registers inside `effect` is only correct if that is true.
		effect: (callback: () => unknown, label?: string) => {
			const disposer = callback();
			recorded.effects.push({ label: label ?? "", disposer });
			return () => {};
		},
		on: scoped.on,
		// The optional host services `open_session` composes a session from. A headless host returns
		// undefined for all of them, which is the other half of what these cases cover.
		get: (name: string): unknown => {
			if (options.hostServices === false) return undefined;
			if (name === "agentPresets") {
				return {
					resolve: async (id?: string) => ({ id: id ?? "preset-standard" }),
					mount: async (_agentCtx: unknown, id?: string) => {
						recorded.mounted.push(id ?? "preset-standard");
					},
				};
			}
			if (name === "agentDefaultModel") {
				return { currentSelection: () => ({ provider: "stub-provider", model: "stub-model" }) };
			}
			if (name === "sessions") return { get: (id: string) => ({ id }) };
			if (name === "sessionTitle") {
				return {
					rename: (_session: unknown, title: string) => {
						recorded.renamed.push({ session: _session, title });
						return { title };
					},
				};
			}
			if (name === "workspaceRegistry") {
				return {
					resolveByPath: async () => undefined,
					create: async (path: string) => {
						if (options.workspaceFails === true) throw new Error("workspace storage is unavailable");
						return {
							attachSession: async (sessionId: string) => {
								recorded.attached.push({ path, sessionId });
							},
						};
					},
				};
			}
			return undefined;
		},
	};
	return { ctx, recorded, scoped };
}

/** A live agent as the host presents it, bound to the stub's scoped context. */
function agentFor(sessionId: string, scoped: unknown) {
	return {
		status: "idle" as const,
		session: { id: sessionId, header: { cwd: "/" } },
		ctx: scoped,
		followup: () => {},
		steer: () => {},
		whenIdle: async () => {},
	};
}

/** Drive the plugin's `agent/created` listener with one agent, as the host's factory would. */
async function fireCreated(host: ReturnType<typeof stubHost>, sessionId: string): Promise<void> {
	for (const handler of host.recorded.events.get("agent/created") ?? []) {
		await handler({ agent: agentFor(sessionId, host.scoped) });
	}
}

/** Run the registered `open_session` tool with one argument object, as the host would after validation. */
async function runOpen(host: ReturnType<typeof stubHost>, args: Record<string, unknown>): Promise<string> {
	const tool = host.recorded.tools.find((candidate) => candidate.name === OPEN_SESSION_TOOL) as
		| { execute: (args: unknown, exec: unknown) => Promise<unknown> }
		| undefined;
	if (tool === undefined) throw new Error("open_session is not registered");
	const exec = {
		signal: AbortSignal.timeout(10_000),
		agent: undefined,
		callId: "call-open-session",
		name: OPEN_SESSION_TOOL,
		arguments: args,
		deferContext: () => {},
		concludeTurn: () => {},
	};
	return String(await tool.execute(args, exec));
}

describe("the dsh-open-session plugin entry", () => {
	it("declares its name, services, and one lifecycle handler", () => {
		expect(name).toBe("dsh-open-session");
		expect(inject).toEqual(["agents", "tools"]);

		const recorded = newRecorded();
		const host = stubHost(recorded);
		apply(host.ctx as unknown as Context);

		expect([...recorded.events.keys()]).toEqual(["agent/created", "agent/disposed"]);
		// Nothing global and nothing per-session yet: the tool is registered when an agent exists.
		expect(recorded.tools).toEqual([]);
	});

	it("registers into sessions that were already live when the plugin loaded", async () => {
		const recorded = newRecorded();
		const host = stubHost(recorded);
		// An agent that existed before this plugin loaded never sees an `agent/created` edge of its own.
		recorded.liveAgents.push(agentFor("s-live", host.scoped));

		apply(host.ctx as unknown as Context);

		expect(recorded.tools.map((tool) => tool.name)).toEqual([OPEN_SESSION_TOOL]);
	});

	it("registers an already-live session once, even when both edges see it", () => {
		const recorded = newRecorded();
		const host = stubHost(recorded);
		const live = agentFor("s-both", host.scoped);
		recorded.liveAgents.push(live);

		apply(host.ctx as unknown as Context);
		// The same agent also arrives as a creation edge: two registrations of one name would be one too many.
		for (const handler of host.recorded.events.get("agent/created") ?? []) handler({ agent: live });

		expect(recorded.tools).toHaveLength(1);
	});

	it("registers a session again after it was disposed and resumed", async () => {
		const recorded = newRecorded();
		const host = stubHost(recorded);
		apply(host.ctx as unknown as Context);
		await fireCreated(host, "s-again");
		expect(recorded.tools).toHaveLength(1);

		// Disposal ends the agent's scope; a resume mints a new one, so the tool has to be registered again.
		for (const handler of host.recorded.events.get("agent/disposed") ?? []) {
			handler({ agent: agentFor("s-again", host.scoped) });
		}
		await fireCreated(host, "s-again");

		expect(recorded.tools).toHaveLength(2);
	});

	it("registers exactly one tool on the agent's own scope, compiled through the host's own defineTool", async () => {
		const recorded = newRecorded();
		const host = stubHost(recorded);
		apply(host.ctx as unknown as Context);
		await fireCreated(host, "s-1");

		expect(recorded.tools.map((tool) => tool.name)).toEqual([OPEN_SESSION_TOOL]);
		const tool = recorded.tools[0];
		// Real text, not a placeholder: the description is what the model reads.
		expect(tool?.description.length ?? 0).toBeGreaterThan(200);
		// The host's own schema compiler normalized the parameters before the stub saw them.
		expect(tool?.parameters).toMatchObject({ type: "object" });
	});

	it("passes the model selection and the resolved preset to the factory, and mounts the preset", async () => {
		const recorded = newRecorded();
		const host = stubHost(recorded);
		apply(host.ctx as unknown as Context);
		const cwd = await freshWorkspace();
		await fireCreated(host, "s-1");

		await runOpen(host, { cwd, message: "Fix the flaky test in ci", title: "worker-1" });

		expect(recorded.opened).toHaveLength(1);
		const request = recorded.opened[0];
		expect(/^session-[0-9a-f-]{36}$/.test(String(request?.sessionId))).toBe(true);
		// The model selection a fresh session would log, taken from the host at call time.
		expect(request?.agentOptions).toEqual({ provider: "stub-provider", model: "stub-model" });
		// The resolved preset name, not the caller's spelling.
		expect(request?.meta).toEqual({ cwd, agentPreset: "preset-standard" });
		// The setup closure is what composes the preset's scoped world when the agent is published; the stub
		// plays back the host's call to it.
		expect(typeof request?.setup).toBe("function");
		await (request?.setup as (agentCtx: unknown, agent: unknown) => Promise<void>)({}, {});
		expect(recorded.mounted).toEqual(["preset-standard"]);
	});

	it("delivers the first prompt once, as a relay from the calling session", async () => {
		const recorded = newRecorded();
		const host = stubHost(recorded);
		apply(host.ctx as unknown as Context);
		const cwd = await freshWorkspace();
		await fireCreated(host, "s-1");

		await runOpen(host, { cwd, message: "你是这个工作区的 worker。", title: "worker-1" });

		expect(recorded.prompts).toHaveLength(1);
		const prompt = recorded.prompts[0];
		expect(prompt?.content.map((block) => block.text ?? "").join("")).toBe("你是这个工作区的 worker。");
		// The host minted a real user message: the source variant is this plugin's own, merged into the
		// host's MessageSourceMap, so the first prompt in the record is labelled as a relay from the caller.
		expect(prompt?.source).toMatchObject({ kind: "open-session", form: "relay", openedBy: "s-1" });
		const summary = (prompt?.source as { summary?: string } | undefined)?.summary;
		expect(typeof summary).toBe("string");
		expect((summary ?? "").length).toBeGreaterThan(0);
		expect((summary ?? "").length).toBeLessThanOrEqual(120);
	});

	it("sets an explicit title verbatim through the host's rename service", async () => {
		const recorded = newRecorded();
		const host = stubHost(recorded);
		apply(host.ctx as unknown as Context);
		const cwd = await freshWorkspace();
		await fireCreated(host, "s-1");

		const text = await runOpen(host, {
			cwd,
			message: "Fix the flaky test in ci",
			title: "worker-1",
		});

		// The explicit title wins over the one derivable from the message, and it is the rename call that
		// carries it — the session object is the one the session store handed back for the new session id.
		expect(recorded.renamed).toHaveLength(1);
		expect(recorded.renamed[0]?.title).toBe("worker-1");
		expect(recorded.renamed[0]?.session).toEqual({ id: recorded.opened[0]?.sessionId });
		expect(text).toContain("title=worker-1");
	});

	it("derives the title from the message's first line when no title is given", async () => {
		const recorded = newRecorded();
		const host = stubHost(recorded);
		apply(host.ctx as unknown as Context);
		const cwd = await freshWorkspace();
		await fireCreated(host, "s-1");

		const text = await runOpen(host, { cwd, message: "Fix the flaky test in ci\n(and nothing else)" });

		expect(recorded.renamed).toHaveLength(1);
		expect(recorded.renamed[0]?.title).toBe("Fix the flaky test in ci");
		expect(text).toContain("title=Fix the flaky test in ci");
	});

	it("sets nothing when there is no message and no title", async () => {
		const recorded = newRecorded();
		const host = stubHost(recorded);
		apply(host.ctx as unknown as Context);
		const cwd = await freshWorkspace();
		await fireCreated(host, "s-1");

		const text = await runOpen(host, { cwd });

		expect(recorded.renamed).toEqual([]);
		expect(recorded.prompts).toEqual([]);
		expect(text).not.toContain("title=");
		expect(text).not.toContain("firstMessage=");
	});

	it("accounts the session in its workspace, which is what the host's session list is built from", async () => {
		const recorded = newRecorded();
		const host = stubHost(recorded);
		apply(host.ctx as unknown as Context);
		const cwd = await freshWorkspace();
		await fireCreated(host, "s-1");

		const text = await runOpen(host, { cwd, message: "stand by", title: "worker-2" });

		expect(recorded.attached).toHaveLength(1);
		expect(recorded.attached[0]).toEqual({ path: cwd, sessionId: recorded.opened[0]?.sessionId });
		expect(text).toContain(`workspace=${cwd}`);
		// And the full report is field lines, one fact per line.
		expect(text.split("\n")[0]).toBe(`session=${recorded.opened[0]?.sessionId}`);
		expect(text).toContain(`cwd=${cwd}`);
		expect(text).toContain("preset=preset-standard");
		expect(text).toContain("firstMessage=sent");
	});

	it("opens a session on a host with none of the optional services, and says the list entry is missing", async () => {
		// A headless or SDK profile: no preset registry, no default model, no session store, no workspace
		// registry. The tool must still work.
		const recorded = newRecorded();
		const host = stubHost(recorded, { hostServices: false });
		apply(host.ctx as unknown as Context);
		const cwd = await freshWorkspace();
		await fireCreated(host, "s-d");

		const text = await runOpen(host, { cwd });

		expect(recorded.opened).toHaveLength(1);
		const request = recorded.opened[0];
		expect(request?.agentOptions).toBeUndefined();
		expect(request?.meta).toEqual({ cwd });
		expect(request?.setup).toBeUndefined();
		expect(recorded.attached).toEqual([]);
		expect(text).toContain("not accounted");
	});

	it("a failed workspace accounting does not fail the call", async () => {
		const recorded = newRecorded();
		const host = stubHost(recorded, { workspaceFails: true });
		apply(host.ctx as unknown as Context);
		const cwd = await freshWorkspace();
		await fireCreated(host, "s-1");

		const text = await runOpen(host, { cwd, message: "stand by", title: "worker-3" });

		// The session was created and titled; only the list entry is missing, and the report says so.
		expect(recorded.opened).toHaveLength(1);
		expect(recorded.renamed).toHaveLength(1);
		expect(text).toContain("not accounted");
	});

	it("refuses a bad cwd and empty strings before anything is created", async () => {
		const recorded = newRecorded();
		const host = stubHost(recorded);
		apply(host.ctx as unknown as Context);
		const cwd = await freshWorkspace();
		const missing = join(tmpdir(), `dsh-open-session-missing-${Date.now()}`);
		await fireCreated(host, "s-1");

		for (const badCwd of ["relative/dir", missing, ""]) {
			await expect(runOpen(host, { cwd: badCwd }), `cwd ${JSON.stringify(badCwd)}`).rejects.toThrow();
		}
		// An empty `message`/`title` is a caller mistake too: a first prompt of nothing would flip the session
		// out of `blank` while telling it nothing.
		for (const args of [
			{ cwd, message: "   " },
			{ cwd, title: "" },
			{ cwd, preset: 42 },
		]) {
			await expect(runOpen(host, args), JSON.stringify(args)).rejects.toThrow();
		}
		// Nothing was created: every rejection happened before the host was asked for a session.
		expect(recorded.opened).toEqual([]);
		expect(recorded.prompts).toEqual([]);
	});
});
