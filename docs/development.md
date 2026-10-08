# 开发约定

## Git

- 主线为 `main`，只通过 GitHub 上的合并请求更新，不直接推送。每批相关的工作从最新主线建立 `dev/<主题>` 分支。
- 提交信息用中文，小批次，一个提交表达一个清楚的变更目的。
- 开合并请求前运行下面的检查，并用 `git diff main...HEAD` 做一次静态审阅：核对范围、文档、秘密和未实现的内容。
- 合并请求由维护者审阅后以“合并提交”方式合入，保留批次边界；分支合并后自动删除。

## 代码与依赖

优先使用成熟组件，业务胶水保持直接可读。不为假想的扩展建立层层接口，不为开发中的短命错误保留兼容兜底。一个问题反复打补丁仍不稳定时，回到全局设计重新考虑。

取舍原则见[架构](architecture.md#取舍原则)：按实际发生的概率、后果和实现与运维成本决定投入，先简单可用，出现具体问题再加必要的措施。

代码组织：一个文件一个职责，入口文件（`server.ts`、`App.tsx`）只做编排和分发，具体处理放具名函数或所属模块；同一段逻辑出现第二次就提取，但不为只有一处使用的代码预留抽象。协议里的事件类型从 `@cc-desk-tunnel/protocol` 引用具名类型。注释写约束和原因，不复述代码；模块结构见各模块 README，改动结构时同步更新。

三个 npm workspace 共享根目录的 `package-lock.json`，用 `npm ci` 复现依赖，不引入第二种包管理器。Node 24 直接运行可擦除的 TypeScript，`npm run typecheck` 仍是必须的静态检查。第三方二进制的下载来源、版本和校验值写在使用它的脚本里。不提交依赖目录、构建产物或凭据。

Windows 上的 shell 命令与脚本使用 `pwsh.exe`（PowerShell 7）。终端、管道、子进程和文本文件一律 UTF-8。

## 文档

- `README.md` 是总览、快速开始和文档索引。
- 跨模块的说明放 `docs/`，模块细节跟随模块目录。
- 进行中的批次可以在 `docs/tasks/` 放一份事项清单；合并后把结论并入相应文档和[变更记录](../CHANGELOG.md)，删除清单。
- 区分已验证的事实与尚未验证的实现，后者记在[路线](roadmap.md)。
- 过时的内容直接删除或改写，不在旁边追加“已过时”的说明；历史由 Git 保留。

## 发布

版本号以 `apps/desktop/package.json` 为准，两端共用；[变更记录](../CHANGELOG.md)里要有同名的一节，按该文件开头说明的结构书写（一句概括，然后是新增功能、优化改进、问题修复、升级说明）。发布脚本把这一节放进固定的发布说明模板：项目简介、本版变化、下载与升级，因此每一版的发布页读起来是同一个样子。

1. 在合并请求里改好版本号与变更记录，合入 `main`。
2. 在 Windows x64 上检出最新的 `main`，准备好打包组件（`npm run prepare:windows:package`）、`gh` 和环境变量 `GH_TOKEN`。
3. `npm run release` 构建安装包与服务端程序包，生成 `release.json`（版本、协议版本、提交、各文件的大小与 SHA256）和 `SHA256SUMS`，上传为草稿发布；核对无误后在发布页点发布，或直接用 `npm run release -- --publish`。`--dry-run` 只构建到 `artifacts/release/`，不上传。

`release.json` 里的 `runtime` 是该版本所需的镜像级别，取自 `deploy/docker/runtime-level`。改动 Dockerfile、镜像入口脚本或 Node.js / frps 的版本时把这个数字加一：旧镜像上的服务端会提示在服务器上升级，而不是自行安装。只更换 Claude Code 的版本不需要加，升级时会把所需版本装进数据目录。

发布在此时才打上 `v<版本>` 标签。已发布的版本不改文件，有问题就递增版本重新发布。

## 凭据与本机文件

开发用的服务器地址、账号、令牌等只放在被忽略的 `.local/`，不进入版本库、日志或文档。一次性的人工测试入口和与具体机器相关的脚本也放在那里；可复用的回归测试才提交。

## 提交前检查

```sh
npm run check
npm run typecheck
npm run format:check
npm test
git diff --check
```

`npm run check` 检查的是 Git 索引，新增文件要先暂存；它只识别少数秘密特征，不是专业的秘密扫描器。涉及界面行为时运行 `npm run test:ui`（先 `npm run setup:desktop`，并安装 Playwright 浏览器或设置 `PLAYWRIGHT_CHANNEL=chrome`）。模拟服务上的测试结果与真实 Claude 的验证分别记录，不能互相替代。
