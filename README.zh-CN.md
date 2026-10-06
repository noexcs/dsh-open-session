# dsh-open-session

> [English](README.md) | 中文

一个 **DeepSeek Harness（DSH）宿主插件**：给每个会话加一个面向模型的工具 `open_session`，它**在同一个宿主上**
打开一个新的 root 会话 —— 走的正是宿主自己「新建会话」的那条路径。

它是纯宿主插件：没有客户端半、除了宿主自身的 `@deepseek-ai/*` 包（声明为 npm peer 依赖）之外没有依赖，也没有别的东西要跑。

## 这个工具做什么

```text
open_session(cwd, preset?, message?, title?)
```

| 参数 | 含义 |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| `cwd`     | 新会话工作的绝对路径。必须是已存在的目录；否则调用会在创建任何东西**之前**被拒。 |
| `preset`  | 可选的宿主 agent preset 名；省略则用宿主的默认 preset。 |
| `message` | 可选的第一句话，在会话存在后立刻发送。它让会话脱离宿主的 *blank* 状态，也是常驻指令传达给无人值守会话的方式。 |
| `title`   | 可选标题。省略时从 message 的第一行派生 —— 确定性、不调模型。 |

返回值是逐行的字段报告，一行一个事实：

```text
session=session-<uuid>
cwd=/abs/path
preset=<宿主解析出的 preset，当宿主有 preset 注册表时>
title=<显式给出的或派生的，当确实设置了标题时>
firstMessage=sent (the session is no longer blank)      ← 仅在给了 message 时出现
workspace=<path>   或   workspace=(not accounted: …)
```

## 安装

插件是一个 Cordis **bundle**（`dsh.bundle` 清单 + `cordis.patch.yml`），所以用 `dsh plugin` 安装：

```sh
# 任何由 CLI 管理的 profile：用 release tarball
dsh plugin --profile <profile> add \
  https://github.com/noexcs/dsh-open-session/releases/download/v0.1.0/dsh-open-session-0.1.0.tgz

# 桌面应用自己的 profile 由应用独占管理（`dsh plugin --profile desktop` 会被拒），
# 所以那边的安装走应用内的插件管理 —— 或者手工：把同一个 URL 加到该 profile 的
# package.json `dependencies`，把包名加到 `dsh.profile.bundles`，然后重启。
```

同样有效的其它来源：GitHub 上的这个包（`dsh plugin --profile <profile> add github:noexcs/dsh-open-session`
—— `lib/` 是提交进仓库的，所以不需要构建），或者本地检出
（`npm ci && npm run build && dsh plugin --profile <profile> add /abs/path/to/dsh-open-session/dist-package`）。

然后重启宿主，并且可以在不启动任何会话的情况下确认这一层已经装上：

```sh
dsh --profile <profile> --dump-config | grep -A3 dsh-open-session
```

此后创建的每个会话都会在自己的作用域里拿到这个工具。`lib/` 作为构建产物已提交，所以上面任何安装方式都不需要构建；
如果你改了 `src/`，安装前先跑 `npm run build`。

## 工作原理 —— 七步，以及它们的顺序

工具被调用时，插件按下面的顺序执行宿主自己的新建会话配方：

1. **确保目录** —— `mkdir(cwd, { recursive: true })`。此时校验（见下）已经拒绝了不存在或非绝对的 `cwd`，
   所以这一步是「双保险」里的那根皮带：绝不会创建一个工作目录无法保证的会话。
2. **组装 preset** —— 可选的 `agentPresets` 服务在**此刻**读取，`resolve(preset)` 定出 preset
   （名字缺失时回落到宿主默认），并把一个 `setup` 闭包挂到创建请求上，好让 preset 的作用域世界
   （工具、提示、模型选择）在**agent 正在被发布时**、它的第一个回合之前就装配完毕。
3. **带上模型选择** —— 可选的 `agentDefaultModel` 服务在**此刻**读取，它的 `currentSelection()`
   作为 `agentOptions` 传入，这样新会话记录的 provider/model 就是用户当前选中的那个，而不是一个静默的默认值。
4. **创建 agent** —— `agents.create({ sessionId, agentOptions, meta: { cwd, agentPreset }, setup })`，
   sessionId 是自己铸的 `session-<uuid>`。factory 会发布会话与 agent，并且**等待**这次发布完成，
   所以这次调用返回时，新会话已经是一个一等会话。这一步必须在 2–3 之后：preset 与模型选择是创建请求的一部分，
   而 sessionId 必须在任何东西被记录到它名下之前就存在。
5. **投递第一句话** —— 给了 `message` 时，它经由创建出来的 handle 的 `followup` 进入，是一条真实的宿主用户消息。
   它的来源标记是插件自己的 source 变体（`kind: "open-session"`，通过官方声明的 `declare module` 扩展点
   合并进宿主的 `MessageSourceMap`），`form: "relay"` —— 这是宿主词表里「一个 agent 发给另一个 agent 的消息」
   那一档 —— 而 `openedBy` 指出调用方会话。有两件事依赖这一步排在 4 之后：会话必须存在才能接收它；
   而发送它正是把会话推出宿主 *blank* 状态的动作（blank 会话在会话列表里被隐藏，除非正在被查看）。
6. **命名** —— 显式给了 `title` 就照原样设置；只给了 `message` 时，标题从它第一个非空行派生
   （去首尾空白、去开头标记、截断到 60 字符 —— 不调模型、不做猜测）。会话对象来自宿主的 session store，
   标题来自宿主的 title 服务，两者都是可选的：两者都没有时，标题就留给宿主自己的首句标题器，
   这个工具不去猜。
7. **workspace 记账** —— 可选的 `workspaceRegistry` 服务为 `cwd` 解析（或创建）workspace，
   并把会话 id 挂进去。**宿主的会话列表依赖的正是这一步**：workspace 的成员是显式持久状态，
   不是从会话的工作目录推导出来的，所以一个被创建却从未挂进去的会话虽然已经持久化 —— 却不在列表里。
   它排在最后，也是因为它可以失败：记账失败只损失列表项、绝不损失会话，报告会改写为
   `workspace=(not accounted: …)`。

两条贯穿全局的规则：

- **先校验、后创建。** `cwd` 必须是非空的绝对路径且指向一个已存在的目录；`message`/`title` 一旦给出，
  去空白后必须非空；`preset` 一旦给出必须是字符串。任何其它情况都会在向宿主请求会话**之前**抛错 ——
  会话是持久状态，一个坏参数必须让调用失败，而不是造出一个待在错误地方的会话。
- **可选服务，调用时读取。** 第 2、3、6、7 步里的每个服务都在工具被调用时读取，绝不在插件装载时读一次。
  一个没有任何这些服务的 headless 或 SDK 宿主，同样得到一个能开普通会话的工具，并在报告里如实说明。

工具本身注册在 `agent/created` 上、注册到 agent 自己的作用域上下文里（`agent.ctx.tools.register(…)`），
所以不想要它的会话根本看不到它，而插件注册的一切都随 agent 自己的作用域一起撤销。

## 开发

```sh
npm install          # .npmrc 设置了 legacy-peer-deps：宿主包是 npm peer，由 profile 提供
npm run build        # tsc（类型）+ esbuild（单文件 lib/index.js 与 dist-package/）
npm run check        # biome（lint + 格式）+ tsc --noEmit
npm test             # vitest：绑定与配方，通过宿主自己的 defineTool 驱动，
                     # 对着一个 stub host（可选服务分别处于存在、缺失、失败三种状态）
npm run verify:bundle  # 同一套配方再对着**构建产物** lib/index.js 跑一遍：证明装上去的
                     # 产物能解析、能编译、行为正确
```

vitest 套件与 bundle 验证断言的是同一批步骤：模型选择与解析出的 preset 抵达 factory、preset 的 `setup`
确实 mount、第一句话以调用方会话的 relay 形式落地、显式标题走宿主的 rename、只给 message 时得到派生标题、
workspace attach 被记录、坏参数在创建前被拒、以及一个没有任何可选服务的宿主仍然能打开会话。

## 已知限制

- **工作目录必须已存在。** 校验会拒绝不存在的 `cwd`（第 1 步里的递归 `mkdir` 是防竞态的安全网，不是创建路径）。
  这是刻意的：悄悄创建调用方没有要求的目录，正是会话跑到错误地方去的原因。
- **工具注册在 agent 作用域上，而不是会话上。** 这里说的"注册"只有一件事：宿主把这个工具放进该 agent
  自己的工具表里（`agent.ctx.tools.register(…)`）。新的 agent 走 `agent/created`；插件装载时就已经活着的
  （重载、启用、profile 后来才插入）走 backfill。被 dispose 之后又被 resume 的会话是一个拥有**新**作用域的
  新 agent，所以工具会为它重新注册。
- **标题派生只用第一行。** 按设计不调模型。第一句话很长时，请显式传 `title`。
- **只开，不关。** 工具无法 dispose 它打开的会话；那是宿主（或用户）的决定。
- **宿主包版本范围。** 类型检查与测试都对着 `0.2.0-rc.2` 的宿主包；声明的 peer 范围
  （指 npm peer 依赖，与 agent 对端无关）对该系列其余版本放宽到 `>=0.1.7-rc.2 <0.3.0`。

## 相关

[`ace-dsh`](https://github.com/noexcs/ace-protocol/tree/main/packages/ace-dsh) —— 同一宿主上的 ACE 宿主插件。
两个插件彼此独立：各自安装，互不 import。

## License

MIT —— 见 [LICENSE](./LICENSE)。
