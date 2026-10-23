# cch-tui 打包与分发

本文说明 Rust TUI 二进制（`cch-tui`）如何构建、打包进 npm 平台包，以及宿主缺失时的降级行为。

- 源码：`packages/tui-native/native`（Cargo workspace，bin 名 `cch-tui`）
- 解析器：`src/utils/tuiBinary.ts`
- 平台包模板：`packages/tui-native/packaging/package.json.template`
- CI：`.github/workflows/ci.yml`（`rust` + `native` 矩阵 + `package`）
- 本地全流程：`scripts/build-all.mjs`

## 分发模型

根包 **不内嵌** TUI 二进制，而是通过 6 个 `optionalDependencies` 按宿主安装。

> **状态**：根 `package.json` 的 `optionalDependencies` 与 `workspaces` 目前**尚未**加入这些包。
> CI 使用 `bun install --frozen-lockfile`，而本地禁止执行 `bun install` 更新 `bun.lock`；
> 发布前需由一次受控的 lockfile 更新统一注入。在此之前运行时解析失败会走
> `getTuiBinaryError()` 的降级路径。

| npm 包 | Cargo target | `os` | `cpu` | 二进制 |
|---|---|---|---|---|
| `@cch/tui-linux-x64` | `x86_64-unknown-linux-gnu` | `linux` | `x64` | `bin/cch-tui` |
| `@cch/tui-linux-arm64` | `aarch64-unknown-linux-gnu` | `linux` | `arm64` | `bin/cch-tui` |
| `@cch/tui-darwin-x64` | `x86_64-apple-darwin` | `darwin` | `x64` | `bin/cch-tui` |
| `@cch/tui-darwin-arm64` | `aarch64-apple-darwin` | `darwin` | `arm64` | `bin/cch-tui` |
| `@cch/tui-windows-x64` | `x86_64-pc-windows-msvc` | `win32` | `x64` | `bin/cch-tui.exe` |
| `@cch/tui-windows-arm64` | `aarch64-pc-windows-msvc` | `win32` | `arm64` | `bin/cch-tui.exe` |

npm 只会安装 `os`/`cpu` 匹配宿主的那一个平台包；其余平台包即使下载失败也不影响安装（optional 语义）。

> 版本号必须与根包一致。当前占位为 `2.8.4`；发版时 6 个平台包与根包一起 bump。

## 产物布局

### 仓库 / CI staging

```
vendor/tui/<cargo-triple>/cch-tui[.exe]
vendor/tui/<cargo-triple>/cch-tui[.exe].sha256
```

- `node scripts/build-all.mjs`（不带 `--skip-native`）在 Step 1 逐 triple `cargo build --release --target ...`，并把 bin 与 sha256 sidecar 写入上述目录。
- CI `native` 矩阵上传 `stage/tui/<triple>/`；`package` job 同步到 `vendor/tui/<triple>/` 并做 6×2 断言（bin + sidecar，含 windows-arm64）。
- `vendor/tui/**` 为构建产物，不入 git（与 `vendor/<napi>/` 一致）。

### npm 平台包

平台包目录由模板 `packages/tui-native/packaging/package.json.template` 复制生成，模板与 6 个实例位于：

```
packages/tui-native/packaging/package.json.template  # 模板（非 workspace，不发布）
packages/tui-native/platforms/<platform>-<arch>/package.json
```

平台包内布局：

```
package.json
bin/cch-tui              # 或 bin/cch-tui.exe
bin/cch-tui.sha256       # 可选；"<64位hex>  cch-tui" 格式
```

`files` 固定为 `["bin/"]`。不要添加 `bin` 字段——TUI 由根包解析路径后调用，不通过 `node_modules/.bin` 暴露。

## 运行时解析与校验

`src/utils/tuiBinary.ts` 导出：

```ts
resolveTuiBinary(): { path: string; version: string } | null
getTuiBinaryError(): string | null
getTuiPlatformKey(): TuiPlatformKey | null
getTuiBinaryPackageName(): string | null
```

流程：

1. `process.platform` / `process.arch` → `linux|darwin|windows` + `x64|arm64`，拼接 `@cch/tui-<platform>-<arch>`。
2. 用 `createRequire(import.meta.url).resolve('<pkg>/package.json')` 定位安装目录（从 `dist/` 或 `dist/chunks/` 出发可命中根包的嵌套 `node_modules`）。
3. 依次尝试 `bin/cch-tui[.exe]`、包根 `cch-tui[.exe]`（兼容手工组装的安装）。
4. Unix 上检查 `X_OK`；Windows 只检查文件存在。
5. 若存在 `<binary>.sha256`，解析第一个字段为 64 位 hex 并比对文件 sha256；格式错误或不匹配即失败。sidecar 缺失视为正常。
6. 成功返回 `{ path, version }`（`version` 取自平台包 `package.json`）。

**不 spawn 进程。** 是否启动、如何传参由调用方决定。任何失败都返回 `null`，不抛异常；`getTuiBinaryError()` 返回可操作文案（缺包、安装时跳过 optional、平台不支持、不可执行、校验失败）。

当前尚未有调用方接入该解析器（本次只做打包/分发接线）；接入方应显式处理 `null`。

## 发布步骤

前置：6 个平台的 CI artifact 已生成（`native-<triple>`），或本地 `node scripts/build-all.mjs` 已填充 `vendor/tui/`。

1. **准备平台包**（以 linux-x64 为例，其余同理）：
   ```bash
   cp -r packages/tui-native/platforms/linux-x64 /tmp/pkg-tui-linux-x64
   mkdir -p /tmp/pkg-tui-linux-x64/bin
   cp vendor/tui/x86_64-unknown-linux-gnu/cch-tui{,.sha256} /tmp/pkg-tui-linux-x64/bin/
   chmod +x /tmp/pkg-tui-linux-x64/bin/cch-tui
   ```
   Windows 使用 `cch-tui.exe` 及其 sidecar。确认 `package.json` 的 `version` 与根包一致。
2. **校验 sidecar**：`sha256sum -c`（macOS 用 `shasum -a 256 -c`）必须在 `bin/` 内通过。
3. **发布 6 个平台包**（先于根包）：
   ```bash
   (cd /tmp/pkg-tui-linux-x64 && npm publish --access public)
   # 重复 6 次
   ```
4. **解析根包 optionalDependencies**：发布前需注入 `workspace:*` 占位并更新
   `bun.lock`（见上文状态说明）。
   - `bun publish` 会把 `workspace:*` 展开为 workspace 内平台包的版本。
   - 用 `npm publish` 时必须先把根 `package.json` 中 6 个 `@cch/tui-*` 替换为实际发布版本（例如 `2.8.4`），否则会发布字面量 `workspace:*`。
5. **发布根包**：`npm publish --provenance --access public`（现有 `.github/workflows/publish-npm.yml` 流程）。
6. **验收**：在 6 类宿主上 `npm i -g claude-code-hardened`，确认 `node_modules/@cch/tui-<platform>-<arch>/bin/cch-tui[.exe]` 存在且可执行；调用 `resolveTuiBinary()` 返回非 null。

## 缺失 / 不可用时的降级行为

`resolveTuiBinary()` 返回 `null`，调用方不应崩溃。建议路径：

1. 记录 `getTuiBinaryError()`（含完整安装指引）；
2. 回退到非原生 TUI（现有 Ink 实现）或禁用 TUI 子命令；
3. 在 `doctor` / 诊断输出中标记 "native TUI unavailable"。

典型缺失场景：

| 场景 | 行为 |
|---|---|
| 安装时 `--omit=optional` / `--no-optional` | 平台包不存在 → `null`，提示重新安装 |
| 未覆盖的平台（musl、ia32、linux-arm 等） | `null`，提示支持列表 |
| 平台包存在但 `bin/` 为空（发布/打包错误） | `null`，提示包不完整 |
| sha256 sidecar 不匹配或格式错误 | `null`，提示下载损坏 |
| 文件缺失执行位（手工拷贝、zip 解压） | `null`，提示 `chmod +x` |

## CI 接线

- `rust` job：在 `packages/tui-native/native` 下跑 `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test`。
- `native` job：6 target（含 `aarch64-pc-windows-msvc`）各构建 5 个 napi crate + `cch-tui`；Unix 用 `sha256sum`/`shasum`，Windows 用 `Get-FileHash` 生成 sidecar。
- `package` job：同步 `vendor/tui/` 并对 6 triple 的 bin + sidecar 做硬断言；`build-all.mjs` Step 3 在任一单文件产物缺失时 `exit(1)`。

## 已知边界

- Linux 产物链接 glibc，**不提供 musl 包**；Alpine 等宿主走降级路径。
- 版本占位 `workspace:*` 依赖发布工具展开；npm 发布路径需手动替换（见发布步骤 4）。
- 本次改动未重新生成 `bun.lock`（环境约束禁止运行 bun）；合入前需在可运行 bun 的环境执行一次 `bun install` 提交 lockfile。
