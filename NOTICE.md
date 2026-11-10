# NOTICE — 第三方来源说明

`dsh-maobing-memory` 以 **GPL v3** 发布（见 [LICENSE](LICENSE)）。

## 为什么用 GPL v3

记忆模型与情绪四轴的设计参考了同样采用 GPL v3 的 angel_memory。本项目的代码**全部自行编写、未复制其实现**（两者是不同平台、不同语言、不同运行时的插件：它是 AstrBot 的 Python 插件，本项目是 DSH 的 TypeScript 插件）。即便如此，采用相同许可可以免除「是否存在衍生关系」的任何争议——这是选择 GPL v3 而非 MIT 的唯一原因。

以下项目仅作为设计与思路参考：

## 天使之魂（angel_memory）

- 仓库：<https://github.com/kawayiYokami/astrbot_plugin_angel_memory>
- 许可：**GPL v3**
- 参考内容：记忆模型（判断句 + 依据 + 标签、五类记忆、强度衰减、纯数字短 ID、面板信息架构）、情绪四轴的轴设计（喜↔悲 / 怒↔恐 / 意料中↔出乎意料 / 厌恶↔认可）
- **使用方式**：仅参考设计思路，未复制代码。实现层面的差异：弹性公式（它用 `exp(-4×距离)` 指数衰减，本项目用 `1/(1+3×距离)`）、回中机制（它随每次调整同步回中，本项目按时间回中）、存储（它纯内存，本项目落 SQLite）、被动共鸣（本项目未实现）、代码结构（它面向对象，本项目函数式）。

## meow-memory

- 仓库：<https://github.com/Phant0Meow/dsh-meow-memory>
- 许可：**MIT**
- 参考内容：DSH（DeepSeek Harness）插件的适配层写法、反思轮的骨架（让模型在轮末自己调工具查重并写入记忆）、`output.render` 返回 `ContentBlock[]` 的约定、前端按文字隐藏注入消息的做法
- **使用方式**：参考其公开的插件接口与做法，代码为自行实现。源码注释里以「同类记忆插件」泛指，不点名——避免把别人的插件名混进本项目的文档与示例；出处以本文件为准。

## DeepSeek Harness

- 本插件运行于 DSH，依赖宿主提供的 `ctx.tools` / `ctx.slots` / `agent/turn-stopping` 等扩展点，`peerDependencies` 仅 `@deepseek-ai/schemastery`（由宿主提供）。

---

如果你认为本项目某处与其作品的用法不符，请提 issue，我会调整。

