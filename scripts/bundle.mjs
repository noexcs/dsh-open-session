#!/usr/bin/env node

/**
 * Build the installable artifact: one ESM file with everything in it, plus the slim install directory.
 *
 * The plugin is installed into a profile as a linked local directory, and pnpm does not install a linked
 * package's dependencies. This plugin has no dependencies of its own to bundle — it only calls into the
 * host's own `@deepseek-ai/*` packages, which stay external so the installed plugin uses the copies the
 * running application provides (a second copy would be a different module instance and a version the host
 * does not have).
 *
 * Output: `lib/index.js` (what `main` points at) and `dist-package/` (the slim directory to install).
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

const result = await build({
	entryPoints: [join(root, "src", "index.ts")],
	outfile: join(root, "lib", "index.js"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	sourcemap: true,
	logLevel: "warning",
	// The host's own packages: never bundled, never duplicated. Node built-ins stay external too.
	external: ["@deepseek-ai/*", "node:*"],
});

if (result.warnings.length > 0) {
	for (const warning of result.warnings) console.warn(`[bundle] warning: ${warning.text}`);
}

// The install directory is deliberately minimal: a manifest with no dependencies, the Cordis patch that
// inserts the entry, and the bundle. Nothing here can drift from the profile's own resolution.
const out = join(root, "dist-package");
await rm(out, { recursive: true, force: true });
await mkdir(join(out, "lib"), { recursive: true });
await cp(join(root, "lib", "index.js"), join(out, "lib", "index.js"));
await cp(join(root, "cordis.patch.yml"), join(out, "cordis.patch.yml"));
await writeFile(
	join(out, "package.json"),
	`${JSON.stringify(
		{
			name: manifest.name,
			version: manifest.version,
			description: manifest.description,
			type: "module",
			main: "lib/index.js",
			exports: {
				".": "./lib/index.js",
				"./package.json": "./package.json",
				"./cordis.patch.yml": "./cordis.patch.yml",
			},
			dsh: manifest.dsh,
			peerDependencies: manifest.peerDependencies,
			files: ["lib", "cordis.patch.yml", "README.md", "LICENSE"],
			license: manifest.license,
		},
		null,
		"\t",
	)}\n`,
);
await cp(join(root, "README.md"), join(out, "README.md"));
await cp(join(root, "LICENSE"), join(out, "LICENSE"));

const bundleBytes = Buffer.byteLength(await readFile(join(root, "lib", "index.js"), "utf8"), "utf8");
console.log(`[bundle] ${manifest.name}@${manifest.version} → lib/index.js (${bundleBytes} bytes) + dist-package/`);
