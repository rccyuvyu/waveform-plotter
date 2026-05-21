# Waveform Plotter (VSCode)


## 已实现功能

- 被动模式（调试器 `stopped` 事件触发采样）
- Live Watch（OpenOCD Telnet 读内存）
  - ELF 符号解析（`arm-none-eabi-nm`）
  - GDB 回退地址解析（`print &var` / `ptype` / `sizeof`）
  - 支持 `int8/16/32`、`uint8/16/32`、`float`、`double`
- RTT 模式
  - OpenOCD 自动初始化（`rtt setup/start/server start`）
  - RAM 区域自动扫描 + 成功区域缓存
  - RTT TCP 流 CSV 解析
- 时域 / FFT 频域切换
  - Hanning 窗 + Cooley-Tukey FFT
- 绘图交互
  - 自动追踪最新数据
  - 左键拖拽平移
  - 滚轮 Y 缩放
  - Shift+滚轮 X 缩放
  - 悬停十字线 + tooltip
  - 右键重置视图
- 变量管理
  - 手动输入 `+ Add`
  - 编辑器右键 `Add to Waveform Plotter`
  - 勾选启停、右键/按钮删除
- CSV 导出
- 设置持久化（workspaceState）

## 目录

- `src/extension.ts` 扩展入口
- `src/controller.ts` 核心控制器（状态、调试监听、数据源控制）
- `src/services/` Live/RTT/ELF/Telnet/被动采样服务
- `media/main.js` Webview UI + Canvas 绘图引擎

## 运行

```bash
cd vscode-waveform-plotter
npm install
npm run compile
```

## 打包

每次需要产出扩展包时执行：

```bash
npm run package:vsix
```

该命令会自动：

- 将版本号按 patch 递增（如 `1.0.88 -> 1.0.89`）
- 同步更新 `package.json` 和 `package-lock.json`
- 重新编译 TypeScript
- 生成对应版本的 `.vsix`
