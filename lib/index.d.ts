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
import type { Context } from "@deepseek-ai/cordis";
/** Cordis plugin name: what a profile's patch layer inserts. */
export declare const name = "dsh-open-session";
/** The host services this plugin needs before it can register anything. */
export declare const inject: string[];
/**
 * Register the plugin: the tool on each agent's own scope, as each agent is created.
 *
 * The registration point is the host's own lifecycle: `agent/created` is awaited by the host's factory, so a
 * session that fails to publish cannot leave a registration behind, and the agent's own scope is where the
 * tool lands — a session that does not want it never sees it.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map