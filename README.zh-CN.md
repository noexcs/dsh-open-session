# dsh-open-session

> [English](README.md) | 中文

给 **DeepSeek Harness** 的一个面向模型的工具：`open_session` 在同一个宿主上打开一个新会话 —— 走的正是宿主自己
「新建会话」的那条路径。它打开的是 **root** 会话：出现在宿主的会话列表里、独立工作、活得比创建它的那次调用更久 ——
不是子 agent。

单独看，它只是一个小插件、只做一件事。它的价值主要体现在与
[`ace-dsh`](https://github.com/noexcs/ace-protocol/tree/main/packages/ace-dsh) 一起用时：**造出同类 + 给它们地址**，
这才把一个会话变成一支你能建立、也能指挥的队伍 —— 见下文「与 ace-dsh：团队的另一半」一节。

它是纯宿主插件：没有客户端半，除了宿主自身的 `@deepseek-ai/*` 包（声明为 npm peer 依赖）之外没有依赖，也没有别的要跑的东西。

## 安装

插件是一个 Cordis **bundle**（`dsh.bundle` 清单 + `cordis.patch.yml`），从它的 release tarball 装进 profile 的一个条目即可。
安装机器上什么都不用构建。它需要 0.2.x 系列的 DeepSeek Harness（声明的 peer 范围是 `>=0.1.7-rc.2 <0.3.0`），除此之外没有别的要求。

```sh
# 任何由 CLI 管理的 profile
dsh plugin --profile <profile> add \
  https://github.com/noexcs/dsh-open-session/releases/download/v0.1.0/dsh-open-session-0.1.0.tgz

# 桌面应用自己的 profile 由应用独占管理（`dsh plugin --profile desktop` 会被拒），
# 所以那边的安装走应用内的插件管理 —— 或者手工：把同一个 URL 加到该 profile 的
# package.json `dependencies`，把包名加到 `dsh.profile.bundles`，然后重启。
```

然后重启宿主。想在什么都不启动的情况下确认这一层装上了：

```sh
dsh --profile <profile> --dump-config | grep -A3 dsh-open-session
```

此后创建的每个会话都会在自己的作用域里拿到这个工具。

## 怎么用它

你不是"调用"这个工具，而是**让你的会话去用**。你说的话很普通：

```text
> 在 /path/to/proj 开一个 worker，把挂掉的 CI 修好，让它自己干
```

会话会去调 `open_session(cwd="/path/to/proj", title="…", message="…")`，并回报：

```text
session=session-5c563a5f…   title=ace-worker-1   workspace=/path/to/proj
```

然后你的**会话列表里就出现一条带标题的会话**。从那一刻起它和别的会话没有区别：你能打开它、在里面打字，而且
（装了 [`ace-dsh`](https://github.com/noexcs/ace-protocol/tree/main/packages/ace-dsh) 之后）别的 agent 也能触达它。

该用它的时候：当你想要一个**同类** —— 在这轮之后继续存在、出现在会话列表里、可以从别处被触达、并且能被交付常驻指令。
不该用的时候：如果你要的是一个有界任务、而且答案属于**当前这段对话** —— 宿主自带的子 agent 工具更合适：更便宜、自动回收、
结果直接回到这里。

|  | 子 agent | `open_session` |
|---|---|---|
| 出现在你的会话列表里 | 否 | **是** |
| 活过创建它的那一轮 | 否 | **是** |
| 能被别的 agent 寻址 | 否 | **是**（配 `ace-dsh`） |
| 自己还能再开同类 | 否 | **是** |

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

它会回报会话 id、最终得到的标题、以及记账所在的 workspace —— 一行一个 `字段=值`，这正是调用它的模型读到的东西。

## 你会注意到的

- **只给 `cwd`、不给 `message` 的会话是看不见的。** 宿主会从会话列表里隐藏 *blank*（还没有任何用户输入）的会话，
  除非你正在看它 —— 所以只带 `cwd` 开出来的会话是真实、可达的，但在有人对它说话之前不会出现在列表里。
  给 `message` 是一种方式，你自己在里面打字是另一种。
- **目录必须已经存在。** `cwd` 不存在会让调用失败；这个工具不会替你创建目录 —— 悄悄创建一个调用方没有要求的目录，
  正是会话跑到错误地方去的原因。
- **它只开会话，不能关会话。** 销毁一个会话是宿主（或用户）的决定。
- **每个 worker 都是真会话。** 它花真实的 token、进你的会话列表，而且没有任何东西限制你能开多少 ——
  这个工具也只能开、不能关。按需要开，剩下的自己收拾。
- **可用性跟随 agent。** 工具注册在 agent 作用域上：插件装载时就已经活着的会话通过 backfill 拿到它
  （重载、启用、profile 后来才插入），而一个被 dispose 之后又被 resume 的会话是一个新 agent，会重新注册。

## 与 ace-dsh：团队的另一半

[`ace-dsh`](https://github.com/noexcs/ace-protocol/tree/main/packages/ace-dsh) 是同一宿主上的 ACE 宿主插件。
两个插件彼此独立 —— 互不 import，各自都能单独安装 —— 但它们是一个能力的**两半**，装在一起就组合成一个**多 agent 团队**：

- 本插件负责**造同类**：root 会话，出现在宿主的会话列表里，独立于打开它的那个会话存活；
- `ace-dsh` 给每一个这样的会话一个**地址**：channel，在 Server 的 agent directory 里可被发现、任何对端都能投递 ——
  本宿主上的任何会话，或另一台说同一套协议的机器。

于是一个会话可以开若干 worker、用 `message` 把第一句指令交给各自（它同时也是**常驻授权**的载体 —— 被告知"直接处理某个对端事件"的
worker 不会逐条询问用户），之后用 `ace_publish` 与它们对话。worker 自己还能再开 worker：`open_session` 也在它的工具表里。
整个过程不牵涉宿主的委派机制，所以团队的形状不受委派预算限制。

## 它怎么工作，以及为什么顺序重要

插件执行的是宿主自己"新建会话"的配方：校验工作目录 → 组装 preset 的作用域世界 → 带上当前模型选择 → 创建并发布 agent →
投递第一句话 → 命名 → 在 workspace 里记账。其中两步是"容易做错且后果明显"的：

- **preset 与模型选择**必须是**创建请求的一部分** —— 这样作用域世界是在 agent 被发布时就装好的，早于它的第一个回合；
- **workspace 记账**决定了这个会话是否出现在宿主的列表里 —— 创建了却从未挂进去的会话虽然持久化、也照样可达，但**看不见**。

完整配方（每一步、顺序、以及它为什么在那个位置）写在源码里（[`src/index.ts`](src/index.ts)），
并且由单元测试与 bundle 验证逐条断言。

## 开发

```sh
npm install          # .npmrc 设置了 legacy-peer-deps：宿主包是 npm peer，由 profile 提供
npm run build        # tsc（类型）+ esbuild（单文件 lib/index.js 与 dist-package/）
npm run check        # biome（lint + 格式）+ tsc --noEmit
npm test             # vitest，对着 stub host（可选服务分别处于存在、缺失、失败三种状态）
npm run verify:bundle  # 同一套配方再对着**构建产物** lib/index.js 跑一遍
```

## 已知限制

- **标题派生只用第一行。** 按设计不调模型。第一句话很长时，请显式传 `title`。
- **宿主包版本范围。** 类型检查与测试都对着 `0.2.0-rc.2` 的宿主包；声明的 peer 范围
  （指 npm peer 依赖，与 agent 对端无关）对该系列其余版本放宽到 `>=0.1.7-rc.2 <0.3.0`。

## License

MIT —— 见 [LICENSE](./LICENSE)。
