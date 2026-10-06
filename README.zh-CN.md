# dsh-open-session

> [English](README.md) | 中文

给 **DeepSeek Harness** 的一个面向模型的工具：`open_session` 在同一个宿主上打开一个新会话 —— 走的正是宿主自己
「新建会话」的那条路径。它打开的是 **root** 会话：出现在宿主的会话列表里、独立工作、活得比创建它的那次调用更久 ——
不是子 agent。

它是纯宿主插件：没有客户端半，除了宿主自身的 `@deepseek-ai/*` 包（声明为 npm peer 依赖）之外没有依赖，也没有别的要跑的东西。

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

插件是一个 Cordis **bundle**（`dsh.bundle` 清单 + `cordis.patch.yml`），从它的 release tarball 装进 profile 的一个条目即可。
安装机器上什么都不用构建。

```sh
# 任何由 CLI 管理的 profile
dsh plugin --profile <profile> add \
  https://github.com/noexcs/dsh-open-session/releases/download/v0.1.0/dsh-open-session-0.1.0.tgz

# 桌面应用自己的 profile 由应用独占管理（`dsh plugin --profile desktop` 会被拒），
# 所以那边的安装走应用内的插件管理 —— 或者手工：把同一个 URL 加到该 profile 的
# package.json `dependencies`，把包名加到 `dsh.profile.bundles`，然后重启。
```

然后重启宿主。此后创建的每个会话都会在自己的作用域里拿到这个工具。

## 什么时候该用它 —— 以及不该用

该用：当你想要一个**同类**的时候 —— 它在这轮之后继续存在、出现在会话列表里、可以从任何地方被触达
（见[团队的另一半](#相关--一个团队的另一半)）、并且能被交付常驻指令。给它一个 `message`，它立刻开始干活，不用有人盯着。

不该用：如果你要的是一个有界任务、而且答案属于**当前这段对话** —— 宿主自带的子 agent 工具更合适：更便宜、自动回收、
结果直接回到这里。

## 你会注意到的

- **只给 `cwd`、不给 `message` 的会话是看不见的。** 宿主会从会话列表里隐藏 *blank*（还没有任何用户输入）的会话，
  除非你正在看它 —— 所以只带 `cwd` 开出来的会话是真实、可达的，但在有人对它说话之前不会出现在列表里。
  给 `message` 是一种方式，你自己在里面打字是另一种。
- **目录必须已经存在。** `cwd` 不存在会让调用失败；这个工具不会替你创建目录 —— 悄悄创建一个调用方没有要求的目录，
  正是会话跑到错误地方去的原因。
- **它只开会话，不能关会话。** 销毁一个会话是宿主（或用户）的决定。
- **可用性跟随 agent。** 工具注册在 agent 作用域上：插件装载时就已经活着的会话通过 backfill 拿到它
  （重载、启用、profile 后来才插入），而一个被 dispose 之后又被 resume 的会话是一个新 agent，会重新注册。

## 相关 —— 一个团队的另一半

[`ace-dsh`](https://github.com/noexcs/ace-protocol/tree/main/packages/ace-dsh) 是同一宿主上的 ACE 宿主插件。
两个插件彼此独立 —— 互不 import，各自都能单独安装 —— 但它们是一个能力的**两半**，装在一起就组合成一个**多 agent 团队**：

- 本插件负责**造同类**：root 会话，出现在宿主的会话列表里，独立于打开它的那个会话存活；
- `ace-dsh` 给每一个这样的会话一个**地址**：channel，在 broker 的 agent directory 里可被发现、任何对端都能投递 ——
  本宿主上的任何会话，或另一个说同一套协议的主机。

于是一个会话可以开若干 worker、用 `message` 把第一句指令交给各自（它同时也是**常驻授权**的载体 —— 被告知"直接处理某个对端事件"的
worker 不会逐条询问用户），之后用 `ace_publish` 与它们对话。worker 自己还能再开 worker：`open_session` 也在它的工具表里。
整个过程不牵涉宿主的委派机制，所以团队的形状不受委派预算限制。

## 工作原理 —— 七步，以及它们的顺序

*这一节是给要改这个插件的人看的：配方是什么，以及为什么顺序是这样。*

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

- **标题派生只用第一行。** 按设计不调模型。第一句话很长时，请显式传 `title`。
- **宿主包版本范围。** 类型检查与测试都对着 `0.2.0-rc.2` 的宿主包；声明的 peer 范围
  （指 npm peer 依赖，与 agent 对端无关）对该系列其余版本放宽到 `>=0.1.7-rc.2 <0.3.0`。

## License

MIT —— 见 [LICENSE](./LICENSE)。
