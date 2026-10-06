/* dsh-open-session — src/open-session.ts
 *
 * `open_session`: open a new root session on this host and report it.
 *
 * This file is the host-free half of the tool: validation, title derivation, and the model-facing
 * report. The one thing only the host can do — actually opening the session — is the `SessionOpener`
 * port, which the host binding (`src/index.ts`) fills with the host's own new-session recipe. That
 * split keeps every decision in this file testable without a host.
 *
 * Opening a session has real cost and real side effects, so the tool says so plainly: a new live
 * agent with its own conversation, and a session-list entry that lives exactly as long as that
 * agent does.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** The tool name, as the model sees it. A host capability, so no plugin prefix. */
export const OPEN_SESSION_TOOL = "open_session";

/**
 * The one host operation this tool needs, injected so the decisions above stay testable.
 *
 * It is deliberately one call rather than a sequence of ports: the steps that make a session a *session* —
 * ensuring the directory, composing the preset's scoped world, creating and publishing the agent, and
 * accounting the session in its workspace — are the host's own recipe and belong in the host binding, not here.
 */
export interface SessionOpener {
	open(plan: OpenSessionPlan): Promise<OpenSessionOutcome>;
}

/**
 * What the host reports back about a session it opened.
 *
 * `workspace` is the workspace path the session was accounted in, when the host has a workspace registry: that
 * accounting is what puts the session in the host's own session list, because a workspace's members are explicit
 * durable state rather than something derived from the sessions' working directories.
 */
export interface OpenSessionOutcome {
	readonly workspace?: string;
	/** The preset the host actually composed with, which is not always the one the caller named. */
	readonly agentPreset?: string;
	/** The title the session ended up with, when the host set or derived one. */
	readonly title?: string;
}

/** A validated request: where the new session starts, how it is composed, and what it is told first. */
export interface OpenSessionPlan {
	readonly sessionId: string;
	readonly cwd: string;
	readonly agentPreset?: string;
	/** The first prompt, sent once the session exists. Also what takes it out of the host's "blank" state. */
	readonly message?: string;
	/** The session's title. Derived from `message` when only a message was given. */
	readonly title?: string;
}

/** Mint a session id in the host's own shape: `session-<uuid>`. */
export function mintSessionId(): string {
	return `session-${randomUUID()}`;
}

/**
 * Validate the arguments, or throw the reason the call cannot be made.
 *
 * Validation happens here, before anything is created: a session is durable state, and a bad `cwd` must fail
 * the call rather than produce a session in the wrong place.
 */
export function planOpenSession(args: Record<string, unknown>, sessionId = mintSessionId()): OpenSessionPlan {
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
	if (preset !== undefined && typeof preset !== "string") throw new Error("preset must be a preset name");
	const agentPreset = typeof preset === "string" && preset.trim() !== "" ? preset.trim() : undefined;

	const message = textArgument(args.message, "message");
	const title = textArgument(args.title, "title");
	return {
		sessionId,
		cwd,
		...(agentPreset === undefined ? {} : { agentPreset }),
		...(message === undefined ? {} : { message }),
		...(title === undefined ? {} : { title }),
	};
}

/**
 * A short, deterministic title from a first prompt: its first non-empty line, collapsed, capped.
 *
 * No model call, and no guessing at meaning: this only exists so a session opened with a `message` is not left
 * untitled in the host's session list. A caller that wants a real name passes `title` — which is worth doing
 * whenever the message is long, since a title taken from a paragraph reads poorly.
 */
export function deriveTitle(message?: string): string | undefined {
	if (message === undefined) return undefined;
	const line = message
		.split("\n")
		.map((candidate) => candidate.trim())
		.find((candidate) => candidate !== "");
	if (line === undefined) return undefined;
	const collapsed = line.replace(/\s+/g, " ").replace(/^[#>*\-\s]+/, "");
	if (collapsed === "") return undefined;
	return collapsed.length <= 60 ? collapsed : `${collapsed.slice(0, 57)}…`;
}

/** One optional free-text argument: absent, or non-empty after trimming; anything else is a caller mistake. */
function textArgument(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	const trimmed = value.trim();
	if (trimmed === "") throw new Error(`${name} was given but is empty`);
	return trimmed;
}

/** Everything the report needs, so the formatting is testable on its own. */
export interface OpenSessionReport {
	readonly plan: OpenSessionPlan;
	/** The preset the session was composed with: what the caller named, or what the host resolved for it. */
	readonly agentPreset?: string;
	/** The title the session ended up with, when the host set or derived one. */
	readonly title?: string;
	/** The workspace the session was accounted in, when the host reported one. */
	readonly workspace?: string;
}

/** The model-facing result: field lines, one fact per line. */
export function formatOpenSession(report: OpenSessionReport): string {
	const lines = [`session=${report.plan.sessionId}`, `cwd=${report.plan.cwd}`];
	const preset = report.agentPreset ?? report.plan.agentPreset;
	if (preset !== undefined) lines.push(`preset=${preset}`);
	const title = report.title ?? report.plan.title;
	if (title !== undefined) lines.push(`title=${title}`);
	if (report.plan.message !== undefined) lines.push("firstMessage=sent (the session is no longer blank)");
	lines.push(
		report.workspace === undefined
			? "workspace=(not accounted: this host has no workspace registry, so the session has no list entry)"
			: `workspace=${report.workspace}`,
	);
	return lines.join("\n");
}
