/**
 * The one merge point this plugin declares into the host's message vocabulary: the provenance a first
 * prompt carries when this plugin opens a session for another session.
 *
 * `MessageSourceMap` is the documented merge point for exactly this — a package that admits programmatic
 * input declares its own source variant — so a first prompt in the session record is labelled as an
 * open-session relay from the caller, not as anonymous plugin input.
 */

import type {} from "@deepseek-ai/dsh-llm";

declare module "@deepseek-ai/dsh-llm" {
	interface MessageSourceMap {
		/**
		 * The first prompt of a session this host opened for another session: `open_session`'s `message`.
		 *
		 * Its form is `relay` — a message one agent addressed to another — because that is exactly what it is:
		 * the calling session's instruction to a session it just started. `openedBy` names the caller's
		 * session id; a name, never an authorization.
		 */
		"open-session": {
			readonly kind: "open-session";
			readonly openedBy: string;
			readonly form: "relay";
			readonly summary: string;
		};
	}
}
