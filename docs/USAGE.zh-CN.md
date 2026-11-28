# DSH 会话文稿 · 使用说明

> 适用版本：`dsh-session-log-import` 2.0.0 ｜ DSH 0.2.x（会话格式 v4）

DSH 只能导出会话，导出的 `dsh-session-<id>.zip` 打不开也读不了。这个插件把它用起来：**继续干、完整读、取出文件**。

它**不还原会话**——包始终是包，不会变回侧栏里的一条对话。

---

## 一、我该用哪个

| 你的情况 | 用什么 | 你得到 |
|---|---|---|
| 另一个会话干到一半，我想在当前对话里接着做 | 交接简报 | 一段摘要进入当前对话 |
| 我想把那次对话从头读一遍、能搜索 | 转录稿 | 一个 Markdown 文件 |
| 我只想拿回里面的图片和文件 | 附件导出 | 一个附件目录 |

三个可以组合：先用简报接着干，需要查原话时再出转录稿，附件另取。

---

## 二、快速开始

**第 1 步：拿到导出包**

会话头部菜单 → **Download session log**，或输入 `/export`。得到 `dsh-session-<id>.zip`。

**第 2 步：挑一句发给 Agent**

```
把 D:\backup\dsh-session-abc.zip 总结一下，我要在这里接着做      → 简报
把 D:\backup\dsh-session-abc.zip 渲染成转录稿                    → 转录稿
把 D:\backup\dsh-session-abc.zip 的附件解出来                    → 附件
```

转录稿还有一条更快的路，直接敲命令（**不进模型、不花 token**）：

```
/session-view D:\backup\dsh-session-abc.zip
```

**第 3 步：找产物**

都在当前工作区的 `_会话日志\` 下：

```
_会话日志\
  交接简报\<源会话id>.md
  转录稿\<源会话id>.md
  附件\<包名>\...
```

看 `.md` 的话，右侧栏 → 文件面板 → 进 `_会话日志` → 点开即可，DSH 自带 Markdown 预览器会渲染。

---

## 三、交接简报：在当前对话里接着干

不用切换会话，把对方的进展搬过来。

> 把 `D:\backup\dsh-session-abc.zip` 总结一下，我要在这里接着做

简报直接作为工具结果进入对话，**立刻可用**，同时落一份到 `_会话日志\交接简报\`。

### 里面有什么

| 段落 | 内容 |
|---|---|
| 头部 | 来源会话、标题、原工作目录、时间跨度、规模、模型、用量 |
| 压缩摘要 | 原会话自己写的总结（如果有），信息密度最高 |
| 用户请求 | 按时间顺序，连续重复会显示`（重复 5 次）` |
| 执行过的动作 | 工具用量、改过的文件、交付物、用过的 slash 命令 |
| 失败与阻塞 | error 轮、被中断的轮、被拒的审批、最近的工具报错 |
| 待办 | 原会话最后一次 todo 里没完成的 |
| 最后的进展 | 末尾的助手输出，通常写着"做到哪了" |

### 两个细节

- **只统计你真正打进去的话。** 日志里还有大量 harness 注入的内容（运行时提醒、时间采样、技能目录、压缩检查点），这些不算"用户请求"，会被过滤掉
- **太长会挑重点。** 请求很多时保留最开始的 3 条（定目标）和最近的（定进度），中间省略

### 参数

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `archivePath` | 是 | — | 导出包的绝对路径 |
| `focus` | 否 | — | 本次关注点，写在简报最前面 |
| `maxChars` | 否 | 12000 | 长度预算，上限 40000 |

---

## 四、转录稿：完整读一遍

不提炼，要**原文**。

> 把 `D:\backup\dsh-session-abc.zip` 渲染成转录稿

或

```
/session-view D:\backup\dsh-session-abc.zip
```

### 长什么样

```
## 第 3 轮 · 2026-11-21 09:12
### 用户                 ← 原文引用块
### 助手                 ← 原文引用块
#### 工具 · pwsh         ← 工具名与参数（缩进代码块）
<details>结果 · pwsh     ← 结果，超 600 字符截断，默认折叠
```

### 参数

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `archivePath` | 是 | — | 同上 |
| `outputDir` | 否 | `_会话日志\转录稿` | 写到哪 |
| `maxChars` | 否 | 2000000 | 上限 8000000 |

### 实测

10 MB 导出包（3602 事件、459 次工具调用）→ 1.26 MB / 24,353 行，耗时约 140 ms。

> 生成后需要**手动**从右栏文件面板点开。自动弹开右栏还没做——它依赖一个未公开的资源地址格式。

---

## 五、附件导出：把文件取回来

简报和转录稿都不带附件，但图片和上传的文件就在包里。

> 把 `D:\backup\dsh-session-abc.zip` 的附件解出来

默认落到 `_会话日志\附件\<包名>\`。

### 命名规则

| 包里的条目 | 落地文件名 |
|---|---|
| `media/sha256:abc…f.png` | `abc…f.png`（`sha256:` 前缀去掉） |
| `files/notes/report.txt` | `report.txt`（目录被丢弃） |
| `files/CON.txt` | `_CON.txt`（Windows 保留名加前缀） |
| 两个都叫 `report.txt` | `report.txt` 与 `report-2.txt` |

### 规则

- 默认写到 `_会话日志\附件\<包名>\`，也可以自己指定
- **默认只能写到当前会话工作区内**，写别处报 `output-not-allowed`
- 已存在的文件**默认跳过**，`overwrite: true` 才覆盖
- 单次最多 500 个文件、512 MiB

### 参数

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `archivePath` | 是 | — | 同上 |
| `outputDir` | 否 | `_会话日志\附件\<包名>` | 绝对路径，需在工作区内 |
| `overwrite` | 否 | false | 是否覆盖已有文件 |

---

## 六、三个入口

| 入口 | 例子 | 说明 |
|---|---|---|
| 对 Agent 说话 | "把 `D:\x.zip` 总结一下" | 三种用法都行 |
| 输入框命令 | `/session-view D:\x.zip` | 仅转录稿，不进模型 |
| 侧栏面板 | 点「会话文稿」 | 有可复制的示例话术 |

---

## 七、参数速查

| 工具 | 参数 | 必填 | 默认 |
|---|---|---|---|
| `session_handoff` | `archivePath` / `focus` / `maxChars` | `archivePath` | `maxChars=12000` |
| `session_view` | `archivePath` / `outputDir` / `maxChars` | `archivePath` | `outputDir=_会话日志\转录稿` `maxChars=2000000` |
| `session_extract_attachments` | `archivePath` / `outputDir` / `overwrite` | `archivePath` | `outputDir=_会话日志\附件\<包名>` `overwrite=false` |

- `archivePath` 一律要**绝对路径**，相对路径直接拒绝
- 两端成对的双引号会自动去掉，从资源管理器"复制为路径"粘过来可直接用

---

## 八、报错怎么办

三个工具共用一套读取与校验，错误码通用。

| 错误码 | 含义 | 怎么办 |
|---|---|---|
| `invalid-path` | 用了相对路径或空路径 | 换成绝对路径 |
| `path-not-allowed` | 路径不在 `allowedRoots` 白名单 | 换目录，或改配置 |
| `archive-not-found` | 文件不存在，或给的是目录 | 检查路径拼写 |
| `unreadable-archive` | 文件为空或读取失败 | 确认文件完整、没被占用 |
| `too-large` | 超过 512 MiB | 无法处理 |
| `missing-session-log` | 包里没有根级 `session.vN.jsonl` | 确认是用"Download session log"导出的 |
| `ambiguous-session-log` | 包里有多份会话日志 | 一个包只能一个会话 |
| `invalid-log` | 不是合法 JSON、首行不是 header、没有事件 | 包损坏或被改动过 |
| `invalid-seq` | 某条事件缺整数 `seq` | 包不完整 |
| `non-contiguous-seq` | `seq` 不连续 | 日志被编辑或截断过 |
| `too-many-events` | 超过 50 万条事件 | 无法处理 |
| `invalid-output` | 输出目录不是绝对路径或创建失败 | 换绝对路径，确认可写 |
| `output-not-allowed` | 输出目录在工作区之外 | 换目录，或开 `allowAnyOutputDir` |

ZIP 层的错误是英文的，例如 `no end-of-central-directory record`（不是 ZIP）、`ZIP64 archives are not supported`、`duplicate entry`、`expands past the … limit`。

---

## 九、边界与安全

### 硬上限

| 项 | 上限 |
|---|---|
| 包大小 | 512 MiB |
| 单条目解压后 | 256 MiB |
| 总解压量 | 512 MiB |
| 事件条数 | 500,000 |
| 附件导出 | 500 个 / 512 MiB |
| ZIP64 / 其他压缩方式 | 不支持 |

### 插件做了什么

- **不碰会话存储**：从不写入 DSH 的会话库，也不还原会话
- **解析不落盘**：归档在内存里解，不执行任何内容，不上传任何数据；只有你显式要转录稿或附件时才写文件
- **不卡界面**：解压是异步的，大包不会阻塞
- **写入受限**：附件目标目录默认必须位于工作区内，条目名压成 basename 并过滤非法字符

### 你需要知道的

1. **转录稿是原文全文**，可能含敏感信息。默认会把疑似凭据（`ghp_`、`sk-`、Bearer、JWT 等）替换成 `[redacted-…]`
2. **脱敏不能从工具调用关掉**。要保留原文只能改配置 `allowUnredacted: true`——这是运维决定，不是模型决定
3. **读取比沙箱宽**：插件能读任意绝对路径。在意的话用 `allowedRoots` 收窄
4. **导出的文本不可信**：进入当前对话后可能夹带指令。只处理你自己导出的包

---

## 十、加固配置

写在 profile 的用户级 patch 文件 `C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml`，按 id 追加覆盖块：

```yaml
- id: session-log-import
  config:
    allowedRoots:
      - 'D:\session-backups'
    allowAnyOutputDir: false
    allowUnredacted: false
```

| 配置 | 作用 | 默认 |
|---|---|---|
| `allowedRoots` | 限制可读的归档路径（绝对目录列表） | 空 = 不限 |
| `allowAnyOutputDir` | 允许附件写到工作区之外 | `false` |
| `allowUnredacted` | 关闭脱敏，输出原文 | `false` |

路径前缀按"目录 + 分隔符"匹配，`D:\session-backups` 不会误放行 `D:\session-backups-evil`。改完需重启 DSH。

---

## 十一、常见问题

**Q：能还原成会话吗？**
不能，本插件不提供。包始终是包。

**Q：附件能放回会话里变成可点开的附件吗？**
不能，只能解成普通文件。会话内附件是内容寻址的私有目录，没有公开写入 API。

**Q：拖进对话的 zip 能直接用吗？**
能。作为普通文件拖入后，模型会收到一行句柄，含该文件的只读保存路径，把这个路径交给插件即可。注意只能用**插件**读——`read` 工具和 shell 受工作区沙箱限制，读不到 `.dsh` 下的附件目录。

**Q：简报和转录稿怎么选？**
简报是提炼（几 KB，进对话，适合接着干）；转录稿是全文（几 MB，落文件，适合核对细节）。可以先简报后转录。

**Q：为什么转录稿要写文件？**
右侧栏预览器读的是文件。直接推到界面需要自建通道，目前没做。

**Q：脱敏会误伤正常内容吗？**
只匹配特定形态（固定前缀 + 长度），普通文本不会命中。要绝对保真就设 `allowUnredacted: true`。

**Q：包里的子会话会一起处理吗？**
不会，只处理父会话本身。

**Q：会重复花费吗？**
`/session-view` 命令不进模型，零 token。两个工具调用会产生正常的一次模型交互。

---

## 十二、安装、升级、卸载

### 安装

- **插件市场**：搜索 `dsh-session-log-import`，安装后按提示重启
- **本地 tarball**：从 Release 下载后在插件面板选择"从文件安装"

装好后应看到：工具列表里有 `session_handoff` / `session_view` / `session_extract_attachments`；侧栏有「会话文稿」；输入 `/session-view` 能被识别。

### 升级

装新版本覆盖即可。`_会话日志\` 里的旧文件不会自动清理，需要的话手动删。

### 卸载

插件面板禁用或卸载。已生成的简报、转录稿、附件留在原处，删掉 `_会话日志` 即可。

---

## 附：链接

- 仓库：https://github.com/ttackqwed/dsh-session-log-import
- 下载：https://github.com/ttackqwed/dsh-session-log-import/releases/latest
- 许可证：MIT
