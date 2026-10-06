import { defineConfig } from "vitest/config";

// The plugin runs against the host packages it declares as peers — here as dev dependencies pinned to the
// host version — so a schema or a message source this plugin declares wrong fails here rather than in a
// profile.
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
});
