# dsh-open-session

> English | [中文](README.zh-CN.md)

One model-facing tool for **DeepSeek Harness**: `open_session` opens a new session on the same host, the way the
host's own "new session" path does. The session it opens is a **root** session — it appears in the host's session
list, works on its own, and outlives the call that created it — not a subagent.

On its own it is a small plugin with one job. Its value shows up next to
[`ace-dsh`](https://github.com/noexcs/ace-protocol/tree/main/packages/ace-dsh): creating peers and giving them an
address is what turns a session into a team you can build and talk to — see
[the other half of a team](#with-ace-dsh-the-other-half-of-a-team).

It is host-only: no client half, no dependencies beyond the host's own `@deepseek-ai/*` packages (declared as npm
peer dependencies), nothing else to run.

## Install

The plugin is a Cordis **bundle** (`dsh.bundle` manifest + `cordis.patch.yml`), and it installs from its release
tarball as one profile entry. Nothing is built on the installing machine. It needs a DeepSeek Harness of the
0.2.x series (its declared peer range is `>=0.1.7-rc.2 <0.3.0`) and nothing else.

```sh
# any profile the CLI manages
dsh plugin --profile <profile> add \
  https://github.com/noexcs/dsh-open-session/releases/download/v0.1.0/dsh-open-session-0.1.0.tgz

# the desktop application's profile is managed by the app (`dsh plugin --profile desktop` is refused),
# so install there through its plugin manager — or by hand: add the same URL to the profile's
# package.json `dependencies` plus the package name to `dsh.profile.bundles`, then restart.
```

Then restart the host. To confirm the layer landed, without starting anything:

```sh
dsh --profile <profile> --dump-config | grep -A3 dsh-open-session
```

Every session created afterwards gets the tool on its own scope.

## Using it

You do not call the tool — you ask your session to. What you say is ordinary:

```text
> open a worker in /path/to/proj to fix the failing CI, and let it work on its own
```

The session calls `open_session(cwd="/path/to/proj", title="…", message="…")` and reports back:

```text
session=session-5c563a5f…   title=ace-worker-1   workspace=/path/to/proj
```

A **titled session appears in your session list**. From then on it is a session like any other: you can open it,
type in it, and (with [`ace-dsh`](#with-ace-dsh-the-other-half-of-a-team)) another agent can reach it.

Use it when you want a **peer**: something that keeps existing after this turn, appears in the session list, can be
reached from elsewhere, and can be handed standing instructions. Do not use it for a bounded task whose answer
belongs in *this* conversation — the host's own subagent tooling is better for that: cheaper, self-cleaning, and
its result comes straight back.

|  | a subagent | `open_session` |
|---|---|---|
| appears in your session list | no | **yes** |
| lives past the turn that made it | no | **yes** |
| can be addressed by another agent | no | **yes** (with `ace-dsh`) |
| can open peers of its own | no | **yes** |

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

It reports the session id, the title it ended up with, and the workspace it was accounted in — one `field=value`
line each, which is what the calling model reads.

## What you will notice

- **A session opened without a `message` is invisible.** The host hides *blank* sessions (no prompt yet) from the
  session list unless they are the one being viewed — so a session opened with only a `cwd` is real and reachable,
  but not listed until someone speaks to it. A `message` is one way; typing in it is another.
- **The directory must already exist.** A missing `cwd` fails the call; this tool does not create directories for
  you — silently creating a directory a caller did not ask for is how sessions end up in the wrong place.
- **It opens sessions; it cannot close one.** Disposing a session is the host's (or the user's) decision.
- **Every worker is a real session.** It costs real tokens, appears in your list, and nothing enforces a limit —
  and this tool cannot close what it opens. Open the ones you need, and tidy up the rest yourself.
- **Availability follows the agent.** The tool is registered per agent scope, so a session that was already live
  when the plugin loaded gets it through the backfill (a reload, an enable, a profile inserted late), and a
  session that is disposed and later resumed is a new agent that registers again.

## With ace-dsh: the other half of a team

[`ace-dsh`](https://github.com/noexcs/ace-protocol/tree/main/packages/ace-dsh) is the ACE host plugin for the
same host. The two plugins are independent — neither imports the other, and either installs alone — but they are
the two halves of one capability, and installed together they compose into a **multi-agent team**:

- this plugin **creates** peers: root sessions that appear in the host's session list and live independently of
  whoever opened them;
- `ace-dsh` gives each of them an **address**: a channel, discoverable in the Server's agent directory and
  reachable by any peer — any session on this host, or on another machine that speaks the same protocol.

So a session can open workers, hand each one its first instruction through `message` (which is also where standing
authorization travels — a worker told to act on a peer's events does so without asking its user about each one),
and then talk to them over `ace_publish`. Workers can open workers of their own: `open_session` is in their tool
set too. None of the host's delegation machinery is involved, so no delegation budget constrains the shape of the
team.

## How it works, and why the order matters

The plugin runs the host's own new-session recipe: validate the working directory, compose the agent preset's
scoped world, carry the current model selection, create and publish the agent, deliver the first prompt, name the
session, and account it in its workspace. Two of those are load-bearing in ways that are easy to get wrong:

- the **preset and the model selection** have to be part of the *creation request*, so the scoped world is mounted
  while the agent is being published, before its first turn;
- the **workspace accounting** is what makes the session appear in the host's list at all — a session that is
  created but never attached is persisted and reachable, yet invisible.

The full recipe — every step, in order, with the reason it sits where it does — is documented in the source
([`src/index.ts`](src/index.ts)), and asserted step by step by the tests and the bundle verification.

## Development

```sh
npm install          # .npmrc sets legacy-peer-deps: host packages are npm peers, provided by the profile
npm run build        # tsc (types) + esbuild (the single-file lib/index.js + dist-package/)
npm run check        # biome (lint + format) + tsc --noEmit
npm test             # vitest, against a stub host (optional services present, absent, or failing)
npm run verify:bundle  # the same recipe against the *built* lib/index.js
```

## Known limitations

- **Title derivation is first-line only.** No model call, by design. For long first prompts, pass a `title`.
- **Host package range.** Type-checked and tested against the `0.2.0-rc.2` host packages; the declared peer ranges
  (npm peer dependencies — nothing to do with agent peers) admit `>=0.1.7-rc.2 <0.3.0` for the rest of the series.

## License

MIT — see [LICENSE](./LICENSE).
