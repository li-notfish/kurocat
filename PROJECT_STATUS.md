# KuroCat 项目状态与交接文档

更新时间：2026-11-23（Asia/Shanghai）

## 1. 项目简介

KuroCat 是一个透明置顶桌面宠物：根据全局键盘和鼠标输入，让猫咪模拟敲键、操作鼠标和眨眼互动。项目支持多种猫咪皮肤、65%/108 键布局、触摸互动、系统托盘、自动更新和 MCP 自定义猫咪。

本轮目标是为猫咪增加**真实可见的数位板和手柄支持**：当数位笔或手柄活动时，前景设备模型从键盘/鼠标切换为数位板/手柄。上一版真机复测暴露了两个后端根因：Wacom 笔卡顿来自 `RAWHID` 按值拷贝后继续按指针读取整包报文（越界/未定义行为）；手柄按键无响应来自 gilrs 的 WGI 后端在部分 Windows 11 机器上枚举到空的 `RawGameController` 集合，只能收到连接公告，之后没有任何按钮/摇杆事件（右键托盘时重新渲染已缓存的连接状态，因此看起来像“右键后才出现手柄”）。本轮已修复 Raw Input 读取，并将 Windows 手柄切换为 gilrs 的 XInput 后端，重新打包待真机复测。

## 2. 技术栈

- 前端：TypeScript、HTML5 Canvas 2D、CSS、Vite 6。
- 桌面框架：Tauri v2，前端通过 `kuro-input` 等事件接收 Rust 输入。
- 后端：Rust 2021；Windows 使用 `windows-sys` 与 `windows`，macOS 使用系统事件接口。
- Windows/macOS 手柄：`gilrs 0.11`；Windows 使用 `xinput` feature（XInput 后端），macOS 使用默认后端。XInput 直接轮询系统控制器槽位，不依赖 WGI 枚举，窗口失焦时也持续产生按键/轴事件。
- 数位笔：Windows Raw Input HID 全局监听（标准 HID Digitizer + Wacom 厂商报文），直接解析坐标、压力、倾角、Tip、侧键、橡皮擦、InRange 和 ExpressKeys；WebView Pointer Events 保留为画布内兼容回退。
- 安装包：Tauri bundler + NSIS。

主要文件：

- `src/main.ts`：事件类型、Tauri 事件路由、Pointer Events 笔输入回退与快速点笔坐标初始化。
- `src/catEngine.ts`：前景设备状态机、猫咪动画、键盘/鼠标/数位板/手柄模型与绘制。
- `src-tauri/src/peripherals.rs`：gilrs 手柄采集、热插拔、按钮/轴映射。
- `src-tauri/src/tablet.rs`：Windows 数位板 Raw Input 后台线程、HID 解析、Wacom CTL-6100 报文与 ExpressKeys。
- `src-tauri/src/input_hook.rs`：前后端共享的 `InputEvent` 定义，包含手柄与数位板事件。
- `src-tauri/src/lib.rs`：启动手柄和数位板监听。
- `src-tauri/src/tray.rs`：托盘「设备演示」菜单。
- `src-tauri/Cargo.toml`：Windows Raw Input、Windows/macOS gilrs 依赖配置。

## 3. 已完成并验证

- **前景设备切换**：`keyboard` / `tablet` / `gamepad` 三种模型互斥显示；笔或手柄活动时立即切换；键盘按键、鼠标点击/滚轮切回键盘。手柄空闲时保留最后一个物理手柄快照；被动鼠标移动不会顶掉手柄，只有真实点击或按键才切回。手柄的任意按钮或轴事件都会把前景切回手柄。
- **连接握手保护**：手柄连接后的 1.4 秒内忽略键盘切换，避免蓝牙握手、手柄唤醒或系统注入事件导致模型瞬间闪回键盘。
- **强制演示与自动恢复**：托盘「设备演示」支持「自动（跟随真实输入）」「键盘 / 鼠标模型」「数位板演示」「手柄演示」。强制模式忽略真实输入；切回自动时根据真实连接状态恢复，不残留无硬件 DEMO 动画。
- **Windows 手柄后端**：使用 `gilrs 0.11` 的 XInput 后端；启动时枚举已连接手柄，运行中处理 `Connected` / `Disconnected` / `ButtonPressed` / `ButtonReleased` / `ButtonChanged` / `AxisChanged` 和热插拔。已用 ViGEm 虚拟 Xbox 手柄在窗口失焦状态下自动化验证：按钮与左摇杆事件持续到达 WebView，键盘切回后再次按手柄可立即切回手柄模型。
- **稳定按钮映射**：A/B/X/Y、LT/LB/RT/RB、View/Menu/Guide、L3/R3、方向键映射到前端固定 ID；模拟扳机通过 `Axis::LeftZ/RightZ` 映射到轴 4/5，并在上升沿生成 LT/RT 气泡。macOS 同样使用 gilrs 映射。
- **手柄视觉状态**：双摇杆、方向键、面键、肩键、扳机、中心菜单键、玩家灯、DEMO 标签和输入高亮；模型已按“猫面对手柄”的视角水平镜像，并按用户要求整体上下翻转，文字保持正向。机身中央轮廓已补实，左右摇杆与 D-pad 均落在手柄表面；D-pad 上下左右的高亮、猫爪落点和浮动气泡锚点保持一致。
- **手柄浮动气泡**：A/B/X/Y、方向键、肩键、扳机、摇杆按键等按真实按下沿生成键帽气泡；每个手柄独立记录 held 状态，断开重连后仍能正常触发。
- **数位板视觉状态**：数位板机身、绘图区、快捷键、压感条、USB-C、线缆、数位笔、笔尖光晕、压感墨迹、倾角握笔与 DEMO 动画；进入数位板演示时立即从绘图区开始动画。
- **Wacom Raw Input 读取修复**：`RAWHID` 是 `Copy` 类型且 `bRawData: [u8; 1]`；上一版把整个结构体拷贝到栈上后，`bRawData.as_ptr()` 指向栈上 1 字节副本，却继续读取 `dwSizeHid * dwCount` 字节，属于越界/未定义行为，会导致 Wacom 笔尖跳变、延迟甚至卡死。现在改为借用原始 Raw Input 缓冲区中的 `RAWHID`，并对包头、`dwSizeHid` 乘法溢出、实际可用字节数做严格校验；新增合成 Raw Input 缓冲区单测防止回归。
- **Wacom 报文兼容**：CTL-6100 官方驱动 193 字节报文（Report ID 位于偏移 1）和无驱动 192 字节报文（Report ID 位于偏移 0）均支持；Report `0x10` 解析 24-bit X/Y、16-bit 压力和 DetectMask，Report `0x11` 解析 4 个 ExpressKeys。报文布局已与 Hawku TabletDriver 的 CTL-6100 配置交叉核对。
- **数位板事件性能**：每个 `WM_INPUT` 包只保留最新笔样本；位置/压感/倾角最多约 83Hz（12ms）发送到 WebView，按键与 InRange 边沿立即发送。`HIDP_DATA` 缓冲改为设备级复用，不再每个 Raw Input 包重新分配；悬停静止时每 500ms 发送一次心跳保持笔尖可见。
- **自动化验收**：Chromium 截图确认 65%/108 键下手柄机身、双摇杆、D-pad、猫爪和 A/D↑/D↓/LT 气泡均在正确位置；浏览器状态机验证确认原生笔会切到数位板、鼠标不能挪动笔尖、静默笔会自动释放、出界会清除笔状态。
- **构建与测试**：`npm run build`、`cargo check`、`cargo test tablet::tests`（11/11）、`cargo test peripherals::tests`（4/4）和 NSIS 打包均通过；release 构建前已清理本 crate 缓存，确保安装包使用最新代码。
- **Windows 手柄根因**：gilrs 的 WGI 后端在部分 Windows 11 机器上 `RawGameController::RawGameControllers()` 返回空集合，于是只能收到 `Connected` 公告、永远收不到按钮/轴事件。表现就是「右键托盘时手柄才出现（重新渲染已缓存的连接状态），之后怎么动手柄都没反应」。
- **XInput 后端统一 Y 轴**：gilrs 的 XInput 后端把「摇杆上推」报成正值，而前端按屏幕坐标约定「上推为负」。已在 `peripherals.rs` 用 `normalize_axis_value` 在 Windows 上翻转 Y 轴（轴 1/3/7），新增单测 `keeps_stick_up_direction_negative` 锁定该约定。
- **XInput 扳机形态**：XInput 后端把模拟扳机作为 `Button::LeftTrigger2` / `RightTrigger2` 按钮上报（带 0~1 力度值），不是轴。前端已有的 LT/RT 按钮槽（id 4/6）会同时驱动扳机条和气泡，无需额外适配。

## 4. 真机验收与已知限制

- **实体蓝牙 Xbox 手柄**：后端已从 WinRT 轮询改为 gilrs 的 XInput 后端，用户实机确认手柄已能正常响应和切换；仍需在 Surface 上验证长时间空闲、蓝牙休眠唤醒、按键盘后摇杆/按钮切回手柄、以及 A/B/X/Y、方向键、肩键、扳机和摇杆上下方向。
- **非 XInput 手柄**：XInput 只认系统 Xbox 控制器槽位。PS/PS5/Switch Pro 等手柄需要 Steam Input 或 DS4Windows 映射成 Xbox 控制器后才会被识别；直连 HID 手柄不受支持。
- **Wacom CTL-6100**：已定位并修复 Raw Input 缓冲区根因，报文偏移与 Hawku 配置一致；仍需用新安装包在朋友的 CTL-6100 上连续绘画 30 秒以上，确认笔尖跟手、压感、侧键、橡皮擦和 ExpressKeys。旧安装包的卡顿反馈来自修复前代码。
- **其他数位板**：坐标范围和压感上限会优先从标准 HID caps 读取，读不到时才使用 CTL-6100 默认值；极端厂商格式或非标准 Report ID 仍可能需要补充。
- **全局压感回退限制**：Pointer Events 只在笔尖位于 KuroCat 画布内且未启用穿透锁定时生效；Windows 原生 Raw Input 路径不依赖画布焦点，但其他平台的全局压感仍不可用。
- **平台范围**：Windows 手柄要求 Windows 10 1703+ 的 WGI；`win7` feature 下不编译手柄监听模块。macOS 使用 gilrs，支持范围取决于系统与 gilrs。
- **数位板平台范围**：原生数位板 Raw Input 仅 Windows；macOS/Linux 保留 Pointer Events 回退。
- **托盘入口**：设备演示入口在系统托盘；右键菜单未新增该子菜单。

## 5. 建议真机验收步骤

1. 安装新包，连接 Xbox 手柄，确认前景切为上下翻转后的手柄模型。
2. 静置手柄 10 秒以上，确认不再自动回到键盘；移动鼠标仍保持手柄，点击鼠标或按键盘后才切回。再操作手柄摇杆或按键，确认无需重新连接即可自动切回手柄。
3. 依次测试 A/B/X/Y、方向键、双摇杆、LT/RT、LB/RB、View/Menu；确认按键气泡、模型高亮和猫爪跟随的位置一致，模拟扳机也有 LT/RT 气泡。摇杆上推时把手柄上的摇杆球应向手柄上侧移动、猫咪视线跟随上移（XInput 后端的 Y 轴已在 Rust 层翻转为屏幕坐标约定）。
4. 使用 Wacom CTL-6100、Surface Pen 或其他数位板，在任意应用（包括 KuroCat 窗口外）连续绘画 30 秒以上，确认笔尖不再卡顿、延迟明显降低；测试 Tip、两个侧键、橡皮擦和 4 个 ExpressKeys，并确认笔悬停静止后仍保持可见。
5. 托盘依次切换「键盘 / 鼠标模型」「数位板演示」「手柄演示」「自动」，确认强制模式不被真实输入打断，自动模式无残留演示。
6. 在 65%/108 键、所有猫咪皮肤（尤其鲸鱼娘）下重复检查模型位置、上下翻转后的方向、气泡和窗口边界。

## 6. 工作区、构建与产物

- 当前外设改动未提交；`src-tauri/src/peripherals.rs` 和 `src-tauri/src/tablet.rs` 是新增文件，不能遗漏。
- 修改文件：`README.md`、`PROJECT_STATUS.md`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/src/input_hook.rs`、`src-tauri/src/lib.rs`、`src-tauri/src/tray.rs`、`src/main.ts`、`src/catEngine.ts`。
- `.codegraph/` 是原有未跟踪目录，不要删除或纳入本次功能改动。
- 本轮参考了 BongoCat 的 gilrs/WGI 手柄事件流思路和 Hawku TabletDriver 的 CTL-6100 报文配置；未直接复制代码，临时参考仓库已清理。
- 临时验收文件 `device-preview.html`、`src-tauri/examples/` 已删除；Vite 测试服务器已停止。
- 构建前若 Rust 不在 PATH：`$env:Path="C:\\Users\\linot\\.cargo\\bin;"+$env:Path`。
- 检查命令：`npm run build`，`cargo check --manifest-path src-tauri/Cargo.toml`，`cargo test --manifest-path src-tauri/Cargo.toml tablet::tests`，`cargo test --manifest-path src-tauri/Cargo.toml peripherals::tests`。
- NSIS 打包：`npm run tauri:build -- --bundles nsis`。
- 最终安装包：`D:\\SourceCode\\kurocat\\src-tauri\\target\\release\\bundle\\nsis\\KuroCat_4.7.0_x64-setup.exe`
- 大小：2,087,267 字节；构建时间：2026-11-23 21:30:36。
- SHA-256：`7C6E32F8997267A8C435C5F67F9C518A39F6D71BC2DC9F5A474B0F2F51BB40E9`。
- 该安装包包含：Wacom Raw Input 越界读取修复与 `HIDP_DATA` 设备级复用；Windows 手柄改用 gilrs 的 XInput 后端（含 Y 轴方向归一化）；以及此前的手柄上下翻转、机身内摇杆/D-pad、扳机气泡、Windows 原生数位板解析。
