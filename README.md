# dsh-open-session

A **DeepSeek Harness (DSH) host plugin** that adds one model-facing tool, `open_session`, to every
session: it opens a new root session **on the same host**, the way the host's own new-session path does.

It is a host-only plugin: no client half, no dependencies beyond the host's own `@deepseek-ai/*`
packages (declared as peers), nothing else to run.

## What the tool does

```text
open_session(cwd, preset?, message?, title?)
```

| Argument  | Meaning                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| `cwd`     | Absolute path the new session works in. Must be an existing directory; the call is refused before anything is created otherwise. |
| `preset`  | Optional host agent-preset name; omitted means the host's default preset.                                     |
| `message` | Optional first prompt, sent as soon as the session exists. What takes the session out of the host's *blank* state, and how standing instructions travel to a session nobody is watching. |
| `title`   | Optional title. Omitted, one is derived from the message's first line — deterministic, no model call.         |

The result is a report of field lines, one fact per line:

```text
session=session-<uuid>
cwd=/abs/path
preset=<resolved preset, when the host has a preset registry>
title=<explicit or derived, when one was set>
firstMessage=sent (the session is no longer blank)      ← only when a message was given
workspace=<path>   or   workspace=(not accounted: …)
```

## Install

The plugin is a Cordis **bundle** (`dsh.bundle` manifest + `cordis.patch.yml`), so `dsh plugin` installs it:

```sh
# any profile the CLI manages: the release tarball
dsh plugin --profile <profile> add \
  https://github.com/noexcs/dsh-open-session/releases/download/v0.1.0/dsh-open-session-0.1.0.tgz

# the desktop application's profile is managed by the app (`dsh plugin --profile desktop` is refused),
# so install there through its plugin manager — or by hand: add the same URL to the profile's
# package.json `dependencies` plus the package name to `dsh.profile.bundles`, then restart.
```

Other equally valid sources: the package on GitHub (`dsh plugin --profile <profile> add github:noexcs/dsh-open-session`
— `lib/` is committed, so nothing builds), or a local checkout
(`npm ci && npm run build && dsh plugin --profile <profile> add /abs/path/to/dsh-open-session/dist-package`).

Then restart the host, and verify the layer landed without starting anything:

```sh
dsh --profile <profile> --dump-config | grep -A3 dsh-open-session
```

Every session created afterwards gets the tool on its own scope. `lib/` is committed as the built
artifact, so none of the install paths need to build anything; if you change `src/`, run
`npm run build` before installing.

## How it works — the seven steps, and their order

When the tool is called, the plugin runs the host's own new-session recipe, in this order:

1. **Ensure the directory** — `mkdir(cwd, { recursive: true })`. Validation has already rejected a
   missing or non-absolute `cwd` (below), so this is the belt to that suspenders: a session is never
   created whose working directory cannot be guaranteed.
2. **Compose the preset** — the optional `agentPresets` service is read *now*, `resolve(preset)` names
   the preset (a missing name falls back to the host's default), and a `setup` closure is attached to
   the creation request so the preset's scoped world (tools, prompt, model selection) is mounted **while
   the agent is being published**, before its first turn.
3. **Carry the model selection** — the optional `agentDefaultModel` service is read *now* and its
   `currentSelection()` is passed as `agentOptions`, so the fresh session logs the same provider/model
   the user has selected, not a silent default.
4. **Create the agent** — `agents.create({ sessionId, agentOptions, meta: { cwd, agentPreset }, setup })`
   with a self-minted `session-<uuid>` id. The factory publishes the session and the agent and
   **awaits** that publication, so the new session is a first-class session before this call resolves.
   This step must come after 2–3: the preset and the model selection are part of the creation request,
   and the session id must exist before anything can be recorded against it.
5. **Deliver the first prompt** — when a `message` was given, it goes in through the created handle's
   `followup`, as a real host user message. Its provenance is the plugin's own source variant
   (`kind: "open-session"`, merged into the host's `MessageSourceMap` through the documented
   `declare module` extension point) with `form: "relay"` — the vocabulary's name for a message one
   agent addressed to another — and `openedBy` naming the calling session. Two things depend on this
   step coming after 4: the session must exist to receive it, and sending it is what flips the session
   out of the host's *blank* state (blank sessions are hidden from the session list unless viewed).
6. **Name it** — an explicit `title` is set verbatim; with only a `message`, the title is derived from
   its first non-empty line (trimmed, leading markers stripped, capped at 60 characters — no model
   call, no guessing). The session object comes from the host's session store and the title from the
   host's title service, both optional: with neither a title is left for the host's own first-prompt
   titler, and this tool does not second-guess it.
7. **Account the workspace** — the optional `workspaceRegistry` service resolves (or creates) the
   workspace for `cwd` and attaches the session id to it. **This is the step the host's session list
   depends on**: a workspace's members are explicit durable state, not something derived from sessions'
   working directories, so a session that is created but never attached is persisted — and absent from
   the list. It is last because it is also the step allowed to fail: an accounting failure costs the
   list entry, never the session, and the report says `workspace=(not accounted: …)` instead.

Two cross-cutting rules:

- **Validation before creation.** `cwd` must be a non-empty absolute path naming an existing directory;
  `message`/`title`, once given, must be non-empty after trimming; `preset`, once given, must be a
  string. Anything else throws before the host is asked for a session — a session is durable state, and
  a bad argument must fail the call, not produce a session in the wrong place.
- **Optional services, read at call time.** Every service in steps 2, 3, 6 and 7 is read when the tool
  is called, never once at plugin load. A headless or SDK host without any of them still gets a working
  tool that opens plain sessions and says so in the report.

The tool itself is registered on `agent/created`, on the agent's own scoped context
(`agent.ctx.tools.register(…)`), so a session that does not want it never sees it, and everything the
plugin registers unwinds with the agent's own scope.

## Development

```sh
npm install          # .npmrc sets legacy-peer-deps: host packages are peers, provided by the profile
npm run build        # tsc (types) + esbuild (the single-file lib/index.js + dist-package/)
npm run check        # biome (lint + format) + tsc --noEmit
npm test             # vitest: the binding and the recipe, driven through the host's own defineTool
                     # against a stub host (optional services present, absent, or failing)
npm run verify:bundle  # the same recipe re-run against the *built* lib/index.js: proof the installed
                     # artifact resolves, compiles and behaves
```

The vitest suite and the bundle verification assert the same steps: the model selection and the
resolved preset reach the factory, the preset's `setup` mounts, the first prompt lands as a relay from
the calling session, an explicit title goes through the host's rename, a message-only call gets a
derived title, the workspace attach is recorded, bad arguments are refused before creation, and a host
with none of the optional services still opens a session.

## Known limitations

- **The working directory must already exist.** Validation rejects a missing `cwd` (the recursive
  `mkdir` in step 1 is a safety net against a race, not the creation path). This is deliberate:
  silently creating directories a caller did not ask for is how sessions end up in the wrong place.
- **Registration follows the agent, not the session.** The tool is registered for every live agent — new ones
  on `agent/created`, and ones that were already live when the plugin loaded (a reload, an enable, a profile
  inserted late) through the backfill. A session that is disposed and later resumed is a new agent with a new
  scope, and registers again.
- **Title derivation is first-line only.** No model call, by design. For long first prompts, pass a
  `title`.
- **Opens, never closes.** The tool cannot dispose a session it opened; that is the host's (or the
  user's) decision.
- **Peer range.** Type-checked and tested against the `0.2.0-rc.2` host packages; the peer ranges admit
  `>=0.1.7-rc.2 <0.3.0` for the rest of the series.

## License

MIT — see [LICENSE](./LICENSE).
