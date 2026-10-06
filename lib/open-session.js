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
/** Mint a session id in the host's own shape: `session-<uuid>`. */
export function mintSessionId() {
    return `session-${randomUUID()}`;
}
/**
 * Validate the arguments, or throw the reason the call cannot be made.
 *
 * Validation happens here, before anything is created: a session is durable state, and a bad `cwd` must fail
 * the call rather than produce a session in the wrong place.
 */
export function planOpenSession(args, sessionId = mintSessionId()) {
    const cwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
    if (cwd === "")
        throw new Error("cwd is required: the absolute path the new session should work in");
    if (!isAbsolute(cwd))
        throw new Error(`cwd must be an absolute path, got "${cwd}"`);
    let isDirectory = false;
    try {
        isDirectory = statSync(cwd).isDirectory();
    }
    catch {
        isDirectory = false;
    }
    if (!isDirectory)
        throw new Error(`cwd is not an existing directory: ${cwd}`);
    const preset = args.preset;
    if (preset !== undefined && typeof preset !== "string")
        throw new Error("preset must be a preset name");
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
export function deriveTitle(message) {
    if (message === undefined)
        return undefined;
    const line = message
        .split("\n")
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate !== "");
    if (line === undefined)
        return undefined;
    const collapsed = line.replace(/\s+/g, " ").replace(/^[#>*\-\s]+/, "");
    if (collapsed === "")
        return undefined;
    return collapsed.length <= 60 ? collapsed : `${collapsed.slice(0, 57)}…`;
}
/** One optional free-text argument: absent, or non-empty after trimming; anything else is a caller mistake. */
function textArgument(value, name) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string")
        throw new Error(`${name} must be a string`);
    const trimmed = value.trim();
    if (trimmed === "")
        throw new Error(`${name} was given but is empty`);
    return trimmed;
}
/** The model-facing result: field lines, one fact per line. */
export function formatOpenSession(report) {
    const lines = [`session=${report.plan.sessionId}`, `cwd=${report.plan.cwd}`];
    const preset = report.agentPreset ?? report.plan.agentPreset;
    if (preset !== undefined)
        lines.push(`preset=${preset}`);
    const title = report.title ?? report.plan.title;
    if (title !== undefined)
        lines.push(`title=${title}`);
    if (report.plan.message !== undefined)
        lines.push("firstMessage=sent (the session is no longer blank)");
    lines.push(report.workspace === undefined
        ? "workspace=(not accounted: this host has no workspace registry, so the session has no list entry)"
        : `workspace=${report.workspace}`);
    return lines.join("\n");
}
//# sourceMappingURL=open-session.js.map