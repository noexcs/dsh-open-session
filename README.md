# dsh-open-session

> English | [中文](README.zh-CN.md)

One model-facing tool for **DeepSeek Harness**: `open_session` opens a new session on the same host, the way the
host's own "new session" path does. The session it opens is a **root** session — it appears in the host's session
list, works on its own, and outlives the call that created it — not a subagent.

It is a host-only plugin: no client half, no dependencies beyond the host's own `@deepseek-ai/*` packages
(declared as npm peer dependencies), nothing else to run.

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

The plugin is a Cordis **bundle** (`dsh.bundle` manifest + `cordis.patch.yml`), and it installs from its release
tarball as one profile entry. Nothing is built on the installing machine.

```sh
# any profile the CLI manages
dsh plugin --profile <profile> add \
  https://github.com/noexcs/dsh-open-session/releases/download/v0.1.0/dsh-open-session-0.1.0.tgz

# the desktop application's profile is managed by the app (`dsh plugin --profile desktop` is refused),
# so install there through its plugin manager — or by hand: add the same URL to the profile's
# package.json `dependencies` plus the package name to `dsh.profile.bundles`, then restart.
```

Then restart the host. Every session created afterwards gets the tool on its own scope.

## When to use it — and when not to

Use it when you want a **peer**: something that keeps existing after this turn, appears in the session list, can
be reached from anywhere (see [the other half of a team](#related--the-other-half-of-a-team)), and can be handed
standing instructions. Give it a `message` and the session starts working immediately, with no one watching.

Do not use it for a bounded task whose answer belongs in *this* conversation: the host's own subagent tooling is
better for that — cheaper, self-cleaning, and its result comes straight back.

## What you will notice

- **A session opened without a `message` is invisible.** The host hides *blank* sessions (no prompt yet) from the
  session list unless they are the one being viewed — so a session opened with only a `cwd` is real and reachable,
  but not listed until someone speaks to it. A `message` is one way; typing in it is another.
- **The directory must already exist.** A missing `cwd` fails the call; this tool does not create directories for
  you — silently creating a directory a caller did not ask for is how sessions end up in the wrong place.
- **It opens sessions; it cannot close one.** Disposing a session is the host's (or the user's) decision.
- **Availability follows the agent.** The tool is registered per agent scope, so a session that was already live
  when the plugin loaded gets it through the backfill (a reload, an enable, a profile inserted late), and a
  session that is disposed and later resumed is a new agent that registers again.

## Related — the other half of a team

[`ace-dsh`](https://github.com/noexcs/ace-protocol/tree/main/packages/ace-dsh) is the ACE host plugin for the
same host. The two plugins are independent — neither imports the other, and either installs alone — but they are
the two halves of one capability, and installed together they compose into a **multi-agent team**:

- this plugin **creates** peers: root sessions that appear in the host's session list and live independently of
  whoever opened them;
- `ace-dsh` gives each of them an **address**: a channel, discoverable in the broker's agent directory and
  reachable by any peer — any session on this host, or on another one that speaks the same protocol.

So a session can open workers, hand each one its first instruction through `message` (which is also where standing
authorization travels — a worker told to act on a peer's events does so without asking its user about each one),
and then talk to them over `ace_publish`. Workers can open workers of their own: `open_session` is in their tool
set too. None of the host's delegation machinery is involved, so no delegation budget constrains the shape of the
team.

## How it works — the seven steps, and their order

*This section is for anyone changing the plugin: what the recipe is, and why the order is what it is.*

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
npm install          # .npmrc sets legacy-peer-deps: host packages are npm peers, provided by the profile
npm run build        # tsc (types) + esbuild (the single-file lib/index.js + dist-package/)
npm run check        # biome (lint + format) + tsc --noEmit
npm test             # vitest: the binding and the recipe, driven through the host's own defineTool
                     # against a stub host (optional services present, absent, or failing)
npm run verify:bundle  # the same recipe re-run against the *built* lib/index.js: proof the installed
                     # artifact resolves, compiles and behaves
```

The vitest suite and the bundle verification assert the same steps: the model selection and the resolved preset
reach the factory, the preset's `setup` mounts, the first prompt lands as a relay from the calling session, an
explicit title goes through the host's rename, a message-only call gets a derived title, the workspace attach is
recorded, bad arguments are refused before creation, and a host with none of the optional services still opens a
session.

## Known limitations

- **Title derivation is first-line only.** No model call, by design. For long first prompts, pass a `title`.
- **Host package range.** Type-checked and tested against the `0.2.0-rc.2` host packages; the declared peer ranges
  (npm peer dependencies — nothing to do with agent peers) admit `>=0.1.7-rc.2 <0.3.0` for the rest of the series.

## License

MIT — see [LICENSE](./LICENSE).
