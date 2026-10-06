#!/usr/bin/env node
/**
 * Verify the **built artifact**: `lib/index.js` as `npm run build` produced it, driven through the
 * host's own `defineTool` against a stub host.
 *
 * The vitest suite proves the source; this proves the thing that actually gets installed. It catches
 * what a source-level test cannot: an `@deepseek-ai/*` import that stopped resolving, a tool schema the
 * host's compiler rejects, or a recipe step that only works in TypeScript.
 *
 * Needs no host and no model: a stub host plays back the factory's handle, and every assertion is on
 * what the plugin asked of it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WAIT_MS = 10_000;

const plugin = await import("../lib/index.js");
if (plugin.name !== "dsh-open-session" || typeof plugin.apply !== "function") {
	throw new Error(`unexpected plugin exports: ${Object.keys(plugin).join(", ")}`);
}

const results = [];
async function scenario(name, body) {
	try {
		results.push({ name, ok: true, detail: await body() });
		console.log(`  ok    ${name} — ${results.at(-1).detail}`);
	} catch (error) {
		results.push({ name, ok: false, detail: String(error) });
		console.log(`  FAIL  ${name} — ${String(error)}`);
	}
}

/** A stub host: it records what the plugin registers and what it asks of the host, and lets the test fire the lifecycle events. */
function stubHost(options = {}) {
	const recorded = {
		tools: [],
		events: new Map(),
		effects: [],
		/** Every `agents.create()` the plugin asked the host for: the sessions it opened. */
		opened: [],
		/** Preset ids the plugin mounted into a new session's scoped world. */
		mounted: [],
		/** Sessions the plugin accounted in a workspace: `{path, sessionId}`. */
		attached: [],
		/** First prompts delivered to a newly opened session. */
		prompts: [],
		/** Titles the plugin set on a newly opened session: `{session, title}`. */
		renamed: [],
	};
	const scoped = {
		tools: {
			register: (definition) => {
				recorded.tools.push(definition);
				return () => {};
			},
		},
		on: (event, handler) => {
			recorded.events.set(event, [...(recorded.events.get(event) ?? []), handler]);
			return () => {};
		},
	};
	const ctx = {
		logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
		tools: scoped.tools,
		agents: {
			list: () => [],
			// The created session is *not* really created here: the stub only records the request and plays
			// back the handle, which is the whole of what the recipe does with it.
			create: async (options) => {
				recorded.opened.push(options);
				return {
					agent: {
						// The created session's first prompt lands here, exactly as the host would deliver it.
						followup: (message) => recorded.prompts.push(message),
					},
					dispose: async () => {},
				};
			},
		},
		// Cordis runs an effect's initializer immediately and treats its return value as the disposer.
		effect: (callback, label) => {
			recorded.effects.push({ label: label ?? "", disposer: callback() });
			return () => {};
		},
		on: scoped.on,
		// The optional host services `open_session` composes a session from. A headless host returns
		// undefined for all of them, which is the other half of what these scenarios cover.
		get: (name) => {
			if (options.hostServices === false) return undefined;
			if (name === "agentPresets") {
				return {
					resolve: async (id) => ({ id: id ?? "preset-standard" }),
					mount: async (_agentCtx, id) => {
						recorded.mounted.push(id ?? "preset-standard");
					},
				};
			}
			if (name === "agentDefaultModel") {
				return { currentSelection: () => ({ provider: "stub-provider", model: "stub-model" }) };
			}
			if (name === "sessions") return { get: (id) => ({ id }) };
			if (name === "sessionTitle") {
				return {
					rename: (_session, title) => {
						recorded.renamed.push({ session: _session, title });
						return { title };
					},
				};
			}
			if (name === "workspaceRegistry") {
				return {
					resolveByPath: async () => undefined,
					create: async (path) => ({
						attachSession: async (sessionId) => {
							recorded.attached.push({ path, sessionId });
						},
					}),
				};
			}
			return undefined;
		},
	};
	return { ctx, recorded, scoped };
}

/** A live agent that records what it was handed instead of running a turn. */
function fakeAgent(sessionId, cwd, scoped) {
	return {
		status: "running",
		session: { id: sessionId, header: { cwd } },
		ctx: scoped,
		followup: () => {},
		steer: () => {},
		whenIdle: async () => {},
	};
}

const workspace = await mkdtemp(join(tmpdir(), "dsh-open-session-bundle-"));
const missing = join(tmpdir(), `dsh-open-session-bundle-missing-${process.pid}`);

/** Bring one session up through the bundled plugin, exactly as the host would. */
async function open(sessionId, options) {
	const host = stubHost(options);
	plugin.apply(host.ctx);
	const agent = fakeAgent(sessionId, workspace, host.scoped);
	for (const handler of host.recorded.events.get("agent/created") ?? []) {
		await handler({ agent });
	}
	return { host, agent, sessionId };
}

const call = (agent, callId) => ({
	signal: AbortSignal.timeout(WAIT_MS),
	agent,
	callId,
	name: "open_session",
	arguments: {},
	deferContext: () => {},
	concludeTurn: () => {},
});

try {
	console.log(`bundled-artifact verification · ${plugin.name}`);

	const alice = await open("s-a");

	await scenario("the bundled entry registers the one tool on the agent's own scope", async () => {
		const names = alice.host.recorded.tools.map((tool) => tool.name);
		if (names.join(",") !== "open_session") throw new Error(`tools: ${names.join(", ")}`);
		const tool = alice.host.recorded.tools[0];
		if (typeof tool?.description !== "string" || tool.description.length <= 200) {
			throw new Error("the tool carries no real description");
		}
		return `${names.length} tool, description ${tool.description.length} chars`;
	});

	await scenario(
		"open_session asks the host for one session with the model selection, the preset and the first prompt",
		async () => {
			const tool = alice.host.recorded.tools.find((candidate) => candidate.name === "open_session");
			if (tool === undefined) throw new Error("open_session is not registered");

			const text = String(
				await tool.execute(
					{ cwd: workspace, message: "你是这个工作区的 worker。", title: "worker-1" },
					call(alice.agent, "call-open-session"),
				),
			);

			const opened = alice.host.recorded.opened;
			if (opened.length !== 1) throw new Error(`the host was asked for ${opened.length} sessions`);
			const request = opened[0];
			if (!/^session-[0-9a-f-]{36}$/.test(request.sessionId)) throw new Error(`session id: ${request.sessionId}`);
			if (request.meta.cwd !== workspace) throw new Error(`cwd: ${JSON.stringify(request.meta)}`);
			// The model selection a fresh session would log, and the preset's scoped world: what makes the
			// result an ordinary session rather than a half-built one.
			if (request.agentOptions?.provider !== "stub-provider" || request.agentOptions?.model !== "stub-model") {
				throw new Error(`agentOptions: ${JSON.stringify(request.agentOptions)}`);
			}
			if (request.meta.agentPreset !== "preset-standard") {
				throw new Error(`meta: ${JSON.stringify(request.meta)}`);
			}
			if (typeof request.setup !== "function") throw new Error("no setup was passed to the factory");
			await request.setup({}, {});
			if (alice.host.recorded.mounted.join(",") !== "preset-standard") {
				throw new Error(`mounted: ${JSON.stringify(alice.host.recorded.mounted)}`);
			}
			const attached = alice.host.recorded.attached;
			if (attached.length !== 1 || attached[0].sessionId !== request.sessionId || attached[0].path !== workspace) {
				throw new Error(`attached: ${JSON.stringify(attached)}`);
			}
			if (!text.includes(`workspace=${workspace}`)) throw new Error(`report without workspace: ${text}`);
			if (!text.includes("preset=preset-standard")) throw new Error(`report without preset: ${text}`);
			if (!text.includes("title=worker-1")) throw new Error(`report without the title: ${text}`);
			if (!text.includes("firstMessage=sent")) throw new Error(`report without the first prompt: ${text}`);
			if (!text.includes(`session=${request.sessionId}`)) throw new Error(`report without the session id: ${text}`);

			// The first prompt: delivered to the created session's agent, and labelled as a relay from the
			// calling session — the plugin's own source variant, minted by the host's own createUserMessage.
			const prompt = alice.host.recorded.prompts[0];
			if (alice.host.recorded.prompts.length !== 1) throw new Error("the first prompt was not delivered once");
			if (prompt?.content?.[0]?.text !== "你是这个工作区的 worker。") {
				throw new Error(`prompt text: ${JSON.stringify(prompt?.content)}`);
			}
			if (prompt?.source?.kind !== "open-session" || prompt?.source?.form !== "relay") {
				throw new Error(`prompt source: ${JSON.stringify(prompt?.source)}`);
			}
			if (prompt?.source?.openedBy !== alice.sessionId)
				throw new Error(`openedBy: ${JSON.stringify(prompt?.source)}`);
			if (typeof prompt?.source?.summary !== "string" || prompt.source.summary.length === 0) {
				throw new Error(`summary: ${JSON.stringify(prompt?.source)}`);
			}
			if (alice.host.recorded.renamed[0]?.title !== "worker-1") {
				throw new Error(`renamed: ${JSON.stringify(alice.host.recorded.renamed)}`);
			}
			return `opened ${request.sessionId}, first prompt relayed, title worker-1`;
		},
	);

	await scenario("a message without a title gets a title derived from its first line", async () => {
		const tool = alice.host.recorded.tools.find((candidate) => candidate.name === "open_session");
		if (tool === undefined) throw new Error("open_session is not registered");

		const text = String(
			await tool.execute(
				{ cwd: workspace, message: "Fix the flaky test in ci\n(and nothing else)" },
				call(alice.agent, "call-open-title"),
			),
		);

		const renamed = alice.host.recorded.renamed.at(-1);
		if (renamed?.title !== "Fix the flaky test in ci") throw new Error(`title: ${JSON.stringify(renamed)}`);
		if (!text.includes("title=Fix the flaky test in ci")) throw new Error(`report: ${text}`);
		return "derived from the first line, deterministically";
	});

	await scenario("open_session still opens a session on a host with none of the optional services", async () => {
		// A headless or SDK profile: no preset registry, no default model, no workspace registry.
		const dave = await open("s-d", { hostServices: false });
		const tool = dave.host.recorded.tools.find((candidate) => candidate.name === "open_session");
		if (tool === undefined) throw new Error("open_session is not registered");

		const text = String(await tool.execute({ cwd: workspace }, call(dave.agent, "call-open-headless")));

		const request = dave.host.recorded.opened[0];
		if (dave.host.recorded.opened.length !== 1) throw new Error("the host was not asked exactly once");
		if (request.agentOptions !== undefined) throw new Error("a model selection appeared from nowhere");
		if (request.meta.agentPreset !== undefined) throw new Error("a preset appeared from nowhere");
		if (request.setup !== undefined) throw new Error("a setup appeared from nowhere");
		// And the report says the list entry is missing rather than pretending it is accounted.
		if (!text.includes("not accounted")) throw new Error(`report: ${text}`);
		return "opened without any optional service, and said so";
	});

	await scenario("open_session refuses a working directory it cannot use, without opening anything", async () => {
		const tool = alice.host.recorded.tools.find((candidate) => candidate.name === "open_session");
		if (tool === undefined) throw new Error("open_session is not registered");
		const before = alice.host.recorded.opened.length;

		for (const cwd of ["relative/dir", missing, ""]) {
			let refused = false;
			try {
				await tool.execute({ cwd }, call(alice.agent, "call-open-session-bad"));
			} catch {
				refused = true;
			}
			if (!refused) throw new Error(`cwd ${JSON.stringify(cwd)} was accepted`);
		}
		// An empty `message`/`title` is a caller mistake too: a first prompt of nothing would flip the session
		// out of `blank` while telling it nothing.
		for (const args of [
			{ cwd: workspace, message: "   " },
			{ cwd: workspace, title: "" },
		]) {
			let refused = false;
			try {
				await tool.execute(args, call(alice.agent, "call-open-session-bad"));
			} catch {
				refused = true;
			}
			if (!refused) throw new Error(`${JSON.stringify(args)} was accepted`);
		}
		if (alice.host.recorded.opened.length !== before) throw new Error("a session was created anyway");
		return "three bad cwds and two empty strings refused before the host was asked";
	});
} catch (error) {
	console.error(`fatal: ${error instanceof Error ? error.message : String(error)}`);
	results.push({ name: "setup", ok: false, detail: String(error) });
} finally {
	await rm(workspace, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
// Explicit: a handle the host leaves behind must not hang a verification run.
process.exit(failed.length === 0 ? 0 : 1);
