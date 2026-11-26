# DSH 会话日志导入 · 使用说明

> 适用版本：`dsh-session-log-import` 1.0.0 ｜ DSH 0.2.x（会话格式 v4）

---

## 一、这是什么

DSH 能**导出**会话日志，但没有**导入**功能——导出的 ZIP 只能当存档看，回不到侧栏。

这个插件补上缺失的一半：把 `dsh-session-<id>.zip` 还原成一个真实存储的会话，重新出现在侧栏，可以继续聊。

**它会做的事**：恢复会话标题、全部对话历史、思考过程、工具调用记录、轮次结构、token 与费用统计。

**它不会做的事**：不还原附件（图片/文件只统计数量）、不导入子会话、不合并会话、不改动原包。

---

## 二、安装

### 方式一：插件市场（推荐）

1. 打开 DSH 的插件面板（插件市场）
2. 搜索 `dsh-session-log-import`
3. 点击安装，按提示重启或等待热加载

市场会优先用 npm 预构建包，其次用 GitHub Release 的 tarball：
`https://github.com/ttackqwed/dsh-session-log-import/releases/download/v1.0.0/dsh-session-log-import-1.0.0.tgz`

### 方式二：本地 tarball

从上面的 Release 地址下载 `.tgz`，在插件面板选择"从文件安装"，或直接装进 profile。

### 装好了吗

装成功后，Agent 的工具列表里会出现 `session_import`。最直接的验证方式——对 Agent 说：

> 用 session_import 试一下不存在的路径 `C:\nope.zip`，看看工具在不在

预期：工具存在，返回"no file at …"这类错误。**如果 Agent 说没有这个工具**，说明插件没加载，检查插件是否启用、DSH 是否重启过。

---

## 三、三步用起来

### 第 1 步：拿到导出包

在会话头部菜单点 **Download session log**，或输入 `/export`，得到 `dsh-session-<id>.zip`。

> ⚠️ 只有这两种方式产出的包才认。自己手工压缩的目录、改过名的文件、其他工具生成的 ZIP 都可能被拒。

### 第 2 步：先预览（强烈建议）

对 Agent 说：

> 预览一下 `D:\backup\dsh-session-abc.zip`，先别导入

Agent 会以 `dryRun: true` 调用，**不写任何东西**，只报告包里的内容。

### 第 3 步：确认无误再导入

> 导入 `D:\backup\dsh-session-abc.zip`

成功后侧栏立刻出现该会话。点开即可继续。

---

## 四、参数说明

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `archivePath` | string | **是** | 导出包的**绝对路径**。相对路径会被拒绝。路径两端多余的双引号会被自动去掉（从资源管理器"复制为路径"粘贴过来可以直接用） |
| `dryRun` | boolean | 否 | `true` 只检查并报告，不写入。默认 `false` |
| `keepSourceId` | boolean | 否 | `true` 时沿用原会话 id。若该 id 已存在则**报错失败**，不会覆盖。默认新生成一个 id |
| `workspaceId` | string | 否 | 导入到哪个工作区。默认用发起这次调用的会话所在工作区 |

### 目标工作区是怎么选的

按顺序尝试，命中即停：

1. 传了 `workspaceId` → 用它（不存在则报 `workspace-not-found`）
2. 没传 → 取当前会话的工作目录，去找注册表里 **路径完全相同** 的工作区
3. 还找不到 → 若全局**只有一个**工作区，就用它
4. 有多个且无法确定 → 报 `workspace-ambiguous`，此时必须显式传 `workspaceId`

> 注意：导入后会话的 `cwd` 会被设成**目标工作区**的路径，而不是包里记录的原始路径。这是有意为之——否则会话会指向一个不存在或不匹配的目录。

---

## 五、结果怎么读

### 预览（dryRun）返回

| 字段 | 含义 |
|---|---|
| `sessionFile` | 包里的日志文件名，如 `session.v4.jsonl` |
| `formatVersion` | 会话格式版本 |
| `sourceId` | 原会话 id |
| `sourceCwd` | 原会话当时的工作目录 |
| `createdAt` | 原会话创建时间（毫秒时间戳） |
| `isSeeded` | 是否为 seeded 会话 |
| `eventCount` | 事件条数（粗略等于对话轮次的数倍） |
| `media` / `files` | 媒体附件数 / 普通附件数（**不会还原**） |
| `subSessions` | 子会话日志数（**不会导入**） |

### 导入返回

| 字段 | 含义 |
|---|---|
| `sessionId` | 新会话 id（`keepSourceId` 时等于原 id） |
| `workspaceId` | 实际落点工作区 |
| `eventCount` | 写入的事件条数 |
| `media` / `files` / `subSessions` | 同上，只做统计 |
| `skippedAttachments` | 未还原附件的文字说明，没有附件时为 `none` |

---

## 六、典型场景

### 1. 误删了会话，从备份恢复

导出包 = 完整备份。导入即恢复，历史全在。

### 2. 换电脑 / 换 profile 迁移

在新机器上装好插件，把旧机器的 `dsh-session-*.zip` 逐个导入即可。**注意**：工作区路径会变成新机器上选定的那个，原机器的路径不会带过来。

### 3. 同一份包放进另一个工作区

导入时指定 `workspaceId`，或先在目标工作区里发起对话再导入。原会话不受影响。

### 4. 想保留原会话 id（便于对照 / 避免重复）

传 `keepSourceId: true`。id 已存在就报 `session-exists`，**绝不覆盖**——这是刻意的保护。

### 5. 只想看看包里有什么

用 `dryRun: true`。全程只读，不产生任何会话。

---

## 七、导入之后会发生什么

- 会话出现在**侧栏**，标题、轮次大纲、token/费用统计一并恢复
- 历史消息、思考内容、工具调用记录都能看到
- **附件不会出现**：正文里若引用了图片或文件，那些引用还在，但内容缺失
- 原会话与本机其他会话**完全不受影响**
- 导入的会话计入正常的用量与费用统计——但**不会重复计费**（按会话 id 记账，新 id 独立）

---

## 八、版本兼容

插件只接受**当前这版 DSH 存储的会话格式**。版本号是运行时从你已存的会话里读出来的（当前为 **v4**），不是硬编码。

这意味着：

- 跨 DSH 大版本迁移时，如果格式从 v4 变成 v5，旧包会被**拒绝**（`unsupported-version`），而不是被错误地解析
- 包内 header 声明的版本与文件名不一致也会被拒（`version-mismatch`），这通常说明包被编辑过

> 降低风险的做法：**用哪个版本导出的，就用哪个版本导入**。

---

## 九、硬性限制

这些上限是编译进插件的，不可配置（导入是一次性的恢复动作，不值得为它开旋钮）：

| 限制 | 上限 |
|---|---|
| 导出包大小 | 512 MiB |
| 单个条目解压后 | 256 MiB |
| 全部解压总量 | 512 MiB |
| 事件条数 | 500,000 |
| ZIP64 格式 | **不支持**（会被明确拒绝） |
| 压缩方式 | 仅 stored + deflate |
| 一个包里的会话数 | 必须**恰好一个**根级 `session.vN.jsonl` |

---

## 十、错误对照表

看到错误时，这里是原因和处理办法。

| 错误码 | 含义 | 怎么办 |
|---|---|---|
| `invalid-path` | 路径是相对路径或空 | 用绝对路径，如 `D:\backup\x.zip` |
| `path-not-allowed` | 路径不在 `allowedRoots` 白名单内 | 换到允许的目录，或调整配置 |
| `archive-not-found` | 文件不存在，或不是普通文件（是目录） | 检查路径拼写 |
| `unreadable-archive` | 文件为空或读取失败 | 确认文件完整、未被占用 |
| `too-large` | 超过 512 MiB | 无法导入 |
| `missing-session-log` | 包里没有根级 `session.vN.jsonl` | 确认是用"Download session log"导出的 |
| `ambiguous-session-log` | 包里有**多个**会话日志 | 一个包只能有一个会话 |
| `invalid-log` | 日志不是合法 JSON、首行不是 header、或没有事件 | 包损坏或被改动过 |
| `invalid-seq` | 某条事件没有可用的整数 `seq` | 包不完整或经过编辑 |
| `non-contiguous-seq` | `seq` 不连续（不是从 0 开始递增） | 日志被编辑或截断，无法可靠恢复 |
| `too-many-events` | 超过 50 万条事件 | 无法导入 |
| `version-mismatch` | header 版本与文件名版本不一致 | 包被改过 |
| `unsupported-version` | 包是别的 DSH 版本的格式 | 用对应版本的 DSH 导入 |
| `workspace-not-found` | 指定的工作区未注册 | 检查 `workspaceId`，或省略它 |
| `workspace-ambiguous` | 有多个工作区，无法推断 | 显式传 `workspaceId` |
| `session-exists` | 目标 id 已存在（仅 `keepSourceId` 时） | 去掉 `keepSourceId`，或先删旧会话 |
| `attach-failed` | 会话已写入，但没能挂到工作区 | 一般重启 DSH 后会在侧栏出现；仍有问题则手动检查 |

ZIP 层面的错误（`ZipError`）以英文描述出现，如 "no end-of-central-directory record"（不是 ZIP）、"ZIP64 archives are not supported"、"duplicate entry"、"expands past the … limit"，对应上表的包损坏或超限情形。

---

## 十一、安全须知

### 插件本身做了什么防护

- **只读解析**：包在内存里解，**从不写到磁盘**，不执行包里任何内容，不上传任何数据
- **有界工作**：包大小、单条目大小、总解压量、事件数四重上限，构造的 ZIP 无法撑爆内存或无限循环
- **不碰会话文件**：写入全部走 DSH 的存储后端，编码、路径、单写者锁由后端负责
- **id 白名单**：只有形如 `[A-Za-z0-9][A-Za-z0-9._:-]{0,199}` 的 id 才会被沿用，避免恶意包构造路径形状的 id

### 你必须知道的三个风险

1. **导入的文本是不可信输入。**
   历史会被当作真实对话记录，恶意包可以把指令塞进历史里，诱导后续的 Agent 行为。**只导入你自己导出的包。**

2. **导入会原样复制原会话的全部历史，包括其中的敏感信息。**
   如果原会话里贴过密钥、密码、内部地址，导入后它们原封不动地存在于新会话里。插件**不做任何脱敏**。

3. **它可以读任意绝对路径。**
   这个工具的读文件能力比沙箱内的普通文件工具更宽——你给什么路径它就读什么（虽然内容从不回显，只返回计数和 id）。如果在意，用下面的白名单收窄。

---

## 十二、加固：限制可读目录

配置写在 **profile 的用户级 patch 文件** 里：

```
C:\Users\<你的用户名>\.dsh\profiles\desktop\cordis.patch.yml
```

插件本身已经由包自带的 patch 插入了 `session-log-import` 这一行，所以这里**只需按 id 追加一段覆盖块**（带 `id`、不带 `insert`，就是修改已有行）：

```yaml
- id: session-log-import
  config:
    allowedRoots:
      - 'D:\session-backups'
      - 'C:\Users\你\Downloads'
```

如果这个 profile 里还没有那一行（插件刚装、尚未加载过），则改用插入写法：

```yaml
- insert:
    - id: session-log-import
      name: dsh-session-log-import
      config:
        allowedRoots:
          - 'D:\session-backups'
```

效果：`archivePath` 必须落在这些目录**之内**才能读取，否则报 `path-not-allowed`。不配置则接受任意可读绝对路径。

几个细节：

- 路径必须写**绝对路径**，相对路径会被忽略
- 匹配方式是"解析后路径前缀 + 分隔符"，`D:\session-backups` 不会误放行 `D:\session-backups-evil`
- 比较是**字符串比较**，Windows 上建议与真实大小写保持一致
- 改完需要重启 DSH 生效

---

## 十三、常见问题

**Q：导入成功了，但侧栏没看到？**
先确认导入到了哪个工作区（结果的 `workspaceId`）。会话是挂在工作区下的，切到该工作区再看。仍然没有就重启 DSH。

**Q：附件能恢复吗？**
不能。这是当前版本明确的取舍：附件存放在 DSH 内部的内容寻址目录里，没有公开 API 可以安全写入，且其布局可能变化。强行按目录结构写文件属于依赖内部实现，插件选择不做。结果里会告诉你少了几个。

**Q：能把两个会话合并成一个吗？**
不能。一个包对应一个会话。

**Q：子会话会一起导入吗？**
不会。只导入父会话本身，子会话数量会在结果里报告（`subSessions`）。

**Q：同一份包导入两次会怎样？**
默认生成两个独立会话（各自新 id）。用 `keepSourceId: true` 时第二次会报 `session-exists` 失败。

**Q：会不会重复计费？**
不会。用量按会话 id 记账，新会话 id 独立，不会与源会话重复计数。

**Q：路径粘贴过来带了引号怎么办？**
没关系，首尾的成对双引号会自动去掉。

**Q：能导入到工作区之外的任意目录吗？**
不能。会话必须归属某个已注册的工作区。

**Q：报 `attach-failed` 怎么办？**
会话已经写进存储了，只是挂到工作区这一步失败。先重启 DSH 看是否自动出现；如果侧栏仍没有，说明该会话处于"有数据但未登记"状态，需要检查工作区注册表。

---

## 十四、卸载

在插件面板禁用或卸载即可。已导入的会话**不受影响**，它们是正常存储的会话，卸载插件后照常可读可续。

---

## 附：链接

- 仓库：https://github.com/ttackqwed/dsh-session-log-import
- 下载：https://github.com/ttackqwed/dsh-session-log-import/releases/tag/v1.0.0
- 许可证：MIT
