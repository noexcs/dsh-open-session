/** The tool name, as the model sees it. A host capability, so no plugin prefix. */
export declare const OPEN_SESSION_TOOL = "open_session";
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
export declare function mintSessionId(): string;
/**
 * Validate the arguments, or throw the reason the call cannot be made.
 *
 * Validation happens here, before anything is created: a session is durable state, and a bad `cwd` must fail
 * the call rather than produce a session in the wrong place.
 */
export declare function planOpenSession(args: Record<string, unknown>, sessionId?: string): OpenSessionPlan;
/**
 * A short, deterministic title from a first prompt: its first non-empty line, collapsed, capped.
 *
 * No model call, and no guessing at meaning: this only exists so a session opened with a `message` is not left
 * untitled in the host's session list. A caller that wants a real name passes `title` — which is worth doing
 * whenever the message is long, since a title taken from a paragraph reads poorly.
 */
export declare function deriveTitle(message?: string): string | undefined;
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
export declare function formatOpenSession(report: OpenSessionReport): string;
//# sourceMappingURL=open-session.d.ts.map