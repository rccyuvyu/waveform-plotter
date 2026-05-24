import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { DataBuffer } from './core/dataBuffer';
import { DEFAULT_STATE, PersistedState, TreeViewRow } from './core/types';
import { LiveWatchService } from './services/liveWatchService';
import { PassiveCollector } from './services/passiveCollector';
import { RttService } from './services/rttService';
import { WaveformAppendState, WaveformViewProvider, WaveformViewState } from './ui/panel';
import { log, warn, error as logError } from './services/logger';

export class WaveformController implements vscode.Disposable {
  private readonly stateKey = 'waveformPlotter.state';
  private state: PersistedState = structuredClone(DEFAULT_STATE);
  private readonly dataBuffer: DataBuffer;
  private readonly passiveCollector: PassiveCollector;
  private readonly liveWatchService: LiveWatchService;
  private readonly rttService: RttService;
  private currentDebugSession: vscode.DebugSession | undefined;
  private currentStoppedThreadId: number | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private syncTimer: NodeJS.Timeout | undefined;
  private autoLoadedSessions = new Set<string>();
  private readonly latestPreviewValues = new Map<string, number>();
  private lastPushedDataVersion = -1;
  private lastPushedChannelSignature = '';
  private lastPushedTotalSamples = 0;
  private persistTask: Promise<void> = Promise.resolve();
  private suppressAutoLiveUntilNextSession = true;
  private elfWorkspacePromise: Promise<void> | null = null;
  private startLiveWatchTask: Promise<void> | null = null;
  private cachedTreeRows: TreeViewRow[] | null = null;
  /** 树结构签名，用于判断是否需要重建 cachedTreeRows */
  private cachedTreeSig = '';
  private cachedTreeStructureVersion = 0;
  private lastPushedTreeVersion = -1;
  private treeValueSyncTimer: NodeJS.Timeout | undefined;
  private lastTreeValueSyncAt = 0;
  private static readonly TREE_VALUE_SYNC_INTERVAL_MS = 120;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly viewProvider: WaveformViewProvider
  ) {
    this.dataBuffer = new DataBuffer(
      vscode.workspace.getConfiguration('waveformPlotter').get<number>('maxChannels', 8),
      vscode.workspace.getConfiguration('waveformPlotter').get<number>('bufferSize', 10000)
    );
    this.passiveCollector = new PassiveCollector(this.dataBuffer);
    this.liveWatchService = new LiveWatchService(this.dataBuffer, () => this.scheduleSync());
    this.rttService = new RttService(this.dataBuffer, () => this.scheduleSync());

    this.viewProvider.setMessageHandler((message) => {
      void this.handleMessage(message);
    });
  }

  async initialize(): Promise<void> {
    log('Controller initializing...');
    await this.loadState();
    this.registerListeners();
    this.rebuildBufferFromState();
    if (vscode.debug.activeDebugSession) {
      this.currentDebugSession = vscode.debug.activeDebugSession;
      log(`Active debug session found: ${this.currentDebugSession.name}`);
      void this.ensureRealtimeRunning(vscode.debug.activeDebugSession);
    }
    log(`State loaded: ${this.state.variableNames.length} variables, ${this.state.trackedVariables.length} tracked`);
    // 即使没有 debug session，也尝试从工作区自动加载 ELF，便于后续脱机解析变量
    void this.tryAutoLoadElfFromWorkspace();
    this.scheduleSync(true);
    log('Controller initialized');
  }

  dispose(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
    }
    if (this.treeValueSyncTimer) {
      clearTimeout(this.treeValueSyncTimer);
      this.treeValueSyncTimer = undefined;
    }
    void this.liveWatchService.stopLiveWatch();
    void this.rttService.stopRtt();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  async openView(): Promise<void> {
    await this.viewProvider.reveal();
    this.scheduleSync(true);
  }

  async addVariable(name: string, checked = true): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    const wasPresent = this.state.variableNames.includes(trimmed);
    if (!wasPresent) {
      this.state.variableNames.push(trimmed);
    }
    this.persist();
    log(`addVariable: "${trimmed}" (checked=${checked}, wasPresent=${wasPresent})`);

    const session = this.currentDebugSession ?? vscode.debug.activeDebugSession;
    if (session) {
      try {
        await this.resolveTrackedVariables(session, [trimmed]);
      } catch (err) {
        console.warn(`[waveform-plotter] Failed to resolve "${trimmed}" while adding`, err);
      }
    } else {
      // 无 debug session 时尝试自动加载 ELF 并解析
      try {
        if (!this.liveWatchService.elfResolver.isLoaded()) {
          await this.tryAutoLoadElfFromWorkspace();
        }
        if (this.liveWatchService.elfResolver.isLoaded()) {
          const elfPath = this.liveWatchService.elfResolver.lastElfPath;
          if (elfPath) {
            log(`Resolving "${trimmed}" from ELF: ${elfPath}`);
            await this.resolveTrackedFromElf(elfPath, [trimmed]);
          } else {
            warn(`ELF loaded but no path available for "${trimmed}"`);
          }
        } else {
          warn(`ELF not loaded, cannot resolve "${trimmed}"`);
        }
      } catch (err) {
        logError(`Failed to resolve "${trimmed}" from ELF`, err);
      }
    }

    // resolve 后才确认是否是复合类型，避免给复合根节点自动勾选
    const hasCompositeChildren = this.getTrackTargetNames(trimmed).some((target) => target !== trimmed);
    log(`addVariable: "${trimmed}" hasCompositeChildren=${hasCompositeChildren}`);
    if (checked && !hasCompositeChildren) {
      await this.setTracked(trimmed, true);
    }

    const resolved = this.liveWatchService.getResolvedEntries();
    const leafNodes = this.liveWatchService.getKnownLeafNodes();
    log(`addVariable: after resolve, ${Object.keys(resolved).length} entries, ${leafNodes.length} leaf nodes`);

    if (session) {
      void this.refreshPreviewValues(session, this.getAllLeafNodeNames()).catch((err) => {
        logError(`Failed to refresh preview for "${trimmed}"`, err);
      });
      // 不自动启动 Live Watch（用户需显式点击 Live 按钮），避免变量添加时触发 OpenOCD 连接导致卡顿
    }

    // 统一在 resolve 完成后推状态，避免首帧出现可勾选的复合根节点
    this.scheduleSync(true);
  }

  async removeVariable(name: string): Promise<void> {
    const trimmed = name.trim();
    this.state.variableNames = this.state.variableNames.filter((v) => v !== trimmed);
    this.state.trackedVariables = this.state.trackedVariables.filter((v) => v !== trimmed && !v.startsWith(`${trimmed}.`));
    for (const key of [...this.latestPreviewValues.keys()]) {
      if (key === trimmed || key.startsWith(`${trimmed}.`)) {
        this.latestPreviewValues.delete(key);
      }
    }
    for (const channelName of this.dataBuffer.getChannels().map((c) => c.name)) {
      if (channelName === trimmed || channelName.startsWith(`${trimmed}.`)) {
        this.dataBuffer.removeChannel(channelName);
      }
    }
    this.liveWatchService.removeResolvedEntriesByPrefix(trimmed);
    if (this.state.variableNames.length === 0) {
      this.clearTrackedRuntimeState();
    }
    this.persist();
    this.scheduleSync(true);
  }

  async setTracked(name: string, checked: boolean): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    const tracked = new Set(this.state.trackedVariables);
    const failedTargets: string[] = [];
    const addTarget = (target: string) => {
      if (this.dataBuffer.getChannels().some((c) => c.name === target)) {
        return true;
      }
      const channel = this.dataBuffer.addChannel(target);
      if (channel) {
        return true;
      }
      return false;
    };

    if (checked) {
      this.pruneChannelsToTrackedSet(new Set([...tracked, trimmed]));
      // 只跟踪用户勾选的那一个变量，不自动跟踪其子成员
      if (addTarget(trimmed)) {
        tracked.add(trimmed);
      } else {
        failedTargets.push(trimmed);
      }
    } else {
      tracked.delete(trimmed);
      this.pruneChannelsToTrackedSet(tracked);
    }
    if (failedTargets.length > 0) {
      const first = failedTargets[0];
      const more = failedTargets.length > 1 ? ` and ${failedTargets.length - 1} more` : '';
      void vscode.window.showWarningMessage(
        `Variable "${first}"${more} cannot be plotted because the channel limit (${this.dataBuffer.maxChannels}) has been reached.`
      );
    }
    this.state.trackedVariables = [...tracked];
    this.persist();
    this.scheduleSync(true);
  }

  private async editVariable(name: string, valueStr: string): Promise<void> {
    const entry = this.liveWatchService.getResolvedEntries()[name];
    if (!entry) {
      return;
    }
    const parsed = this.liveWatchService.parseUserValue(valueStr, entry.dataType);
    if (parsed === null) {
      void vscode.window.showErrorMessage(`Cannot parse "${valueStr}" as ${entry.dataType}`);
      return;
    }
    const ok = await this.liveWatchService.writeMemory(name, parsed);
    if (!ok) {
      void vscode.window.showErrorMessage(`Write failed for ${name}`);
    }
    this.scheduleSync();
  }

  private toggleExpandNode(name: string): void {
    const set = new Set(this.state.expandedNodes);
    if (set.has(name)) {
      set.delete(name);
    } else {
      set.add(name);
    }
    this.state.expandedNodes = [...set];
    this.persist();
    this.scheduleSync(true);
  }

  async startRecording(): Promise<void> {
    this.passiveCollector.recording = true;
    this.persist();
    this.scheduleSync(true);
  }

  async stopRecording(): Promise<void> {
    this.passiveCollector.recording = false;
    this.persist();
    this.scheduleSync(true);
  }

  async clearAll(): Promise<void> {
    this.dataBuffer.clearAll();
    this.passiveCollector.resetSampleCount();
    this.liveWatchService.clearResolvedEntries();
    this.latestPreviewValues.clear();
    this.scheduleSync(true);
  }

  async exportCsv(): Promise<void> {
    const snapshot = this.dataBuffer.snapshot();
    if (snapshot.channels.length === 0) {
      void vscode.window.showInformationMessage('No waveform data to export.');
      return;
    }

    const uri = await vscode.window.showSaveDialog({
      saveLabel: 'Export',
      filters: { CSV: ['csv'] },
      defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionPath, 'waveform_data.csv'))
    });
    if (!uri) {
      return;
    }

    const lines: string[] = [];
    lines.push(['index', ...snapshot.channels.map((ch) => csvField(ch.name))].join(','));
    const maxSize = snapshot.channels.reduce((m, ch) => Math.max(m, ch.data.length), 0);
    for (let i = 0; i < maxSize; i += 1) {
      const row = [String(i)];
      for (const ch of snapshot.channels) {
        row.push(ch.data[i] !== undefined && Number.isFinite(ch.data[i]) ? String(ch.data[i]) : '');
      }
      lines.push(row.join(','));
    }

    await fs.writeFile(uri.fsPath, lines.join('\n'), 'utf8');
    void vscode.window.showInformationMessage(`CSV exported to ${uri.fsPath}`);
  }

  async setDisplayMode(mode: 'TIME' | 'FFT'): Promise<void> {
    this.state.displayMode = mode;
    this.persist();
    this.scheduleSync(true);
  }

  async setTimeUnit(unit: 'ms' | 'us'): Promise<void> {
    this.state.timeUnit = unit;
    this.persist();
    this.scheduleSync(true);
  }

  async setDataSource(source: 'Telnet' | 'RTT'): Promise<void> {
    this.state.dataSource = source;
    this.persist();
    this.scheduleSync(true);
  }

  async updateSettings(update: Partial<PersistedState>): Promise<void> {
    this.state = {
      ...this.state,
      ...update,
      liveWatchFrequency: clampInt(update.liveWatchFrequency ?? this.state.liveWatchFrequency, 1, 10000, 1000),
      telnetPort: clampInt(update.telnetPort ?? this.state.telnetPort, 1, 65535, 4444),
      rttPort: clampInt(update.rttPort ?? this.state.rttPort, 1, 65535, 9090),
      fontSize: clampInt(update.fontSize ?? this.state.fontSize, 8, 20, 12),
      lineWidth: clamp(update.lineWidth ?? this.state.lineWidth, 0.5, 5, 2),
      refreshFps: normalizeRefreshFps(update.refreshFps ?? this.state.refreshFps)
    };
    this.persist();
    this.scheduleSync(true);
  }

  async setFrequency(hz: number): Promise<void> {
    this.state.liveWatchFrequency = clampInt(hz, 1, 10000, 1000);
    this.persist();
    this.scheduleSync(true);
  }

  async toggleLive(): Promise<void> {
    if (this.state.dataSource === 'RTT') {
      if (this.rttService.isRunning.value) {
        this.suppressAutoLiveUntilNextSession = true;
        await this.stopRtt();
      } else {
        this.suppressAutoLiveUntilNextSession = false;
        await this.startRtt();
      }
      return;
    }

    if (this.liveWatchService.livePlotting) {
      // 正在 Live 绘图 → 停止绘图（保持 TCL 读取，树仍显示值）
      this.liveWatchService.livePlotting = false;
      this.suppressAutoLiveUntilNextSession = true;
      log('Live plotting stopped');
    } else {
      this.suppressAutoLiveUntilNextSession = false;
      if (!this.liveWatchService.isRunning.value) {
        // 首次点击 Live：连接 TCL 并启动连续读取
        await this.startLiveWatch();
        log('TCL connected, continuous reading started');
      }
      this.liveWatchService.livePlotting = true;
      // 清空旧数据
      this.dataBuffer.clearAll();
      this.lastPushedDataVersion = -1;
      this.lastPushedChannelSignature = '';
      this.lastPushedTotalSamples = 0;
      log('Live plotting started');
    }
  }

  async stopAllLive(): Promise<void> {
    await this.stopLiveWatch();
    await this.stopRtt();
  }

  private async handleMessage(message: any): Promise<void> {
    switch (message?.type) {
      case 'addVariable':
        await this.addVariable(String(message.name ?? ''));
        return;
      case 'removeVariable':
        await this.removeVariable(String(message.name ?? ''));
        return;
      case 'toggleTracked':
        await this.setTracked(String(message.name ?? ''), Boolean(message.checked));
        return;
      case 'record':
        await this.startRecording();
        return;
      case 'stopRecord':
        await this.stopRecording();
        return;
      case 'clear':
        await this.clearAll();
        return;
      case 'exportCsv':
        await this.exportCsv();
        return;
      case 'displayMode':
        await this.setDisplayMode(message.mode === 'FFT' ? 'FFT' : 'TIME');
        return;
      case 'timeUnit':
        await this.setTimeUnit(message.unit === 'us' ? 'us' : 'ms');
        return;
      case 'dataSource':
        await this.setDataSource(message.source === 'RTT' ? 'RTT' : 'Telnet');
        return;
      case 'setFrequency':
        await this.setFrequency(Number(message.frequencyHz));
        return;
      case 'toggleLive':
        await this.toggleLive();
        return;
      case 'saveSettings':
        await this.updateSettings({
          telnetPort: Number(message.telnetPort) || this.state.telnetPort,
          rttPort: Number(message.rttPort) || this.state.rttPort,
          rttRamStart: String(message.rttRamStart ?? '').trim(),
          rttRamSize: String(message.rttRamSize ?? '').trim(),
          rttAutoInit: Boolean(message.rttAutoInit),
          fontSize: Number(message.fontSize) || this.state.fontSize,
          lineWidth: Number(message.lineWidth) || this.state.lineWidth,
          refreshFps: normalizeRefreshFps(Number(message.refreshFps))
        });
        return;
      case 'openSettings':
        this.scheduleSync(true);
        return;
      case 'refresh':
        this.lastPushedDataVersion = -1;
        this.lastPushedChannelSignature = '';
        this.lastPushedTotalSamples = 0;
        this.scheduleSync(true);
        return;
      case 'editVariable':
        await this.editVariable(String(message.name ?? ''), String(message.value ?? ''));
        return;
      case 'toggleExpand':
        this.toggleExpandNode(String(message.name ?? ''));
        return;
      default:
        return;
    }
  }

  private registerListeners(): void {
    this.disposables.push(
      vscode.debug.onDidStartDebugSession((session) => {
        this.currentDebugSession = session;
        this.currentStoppedThreadId = undefined;
        this.suppressAutoLiveUntilNextSession = false;
        // 清除上一轮 session 的缓存地址，强制对新目标重新解析
        this.liveWatchService.clearResolvedEntries();
        this.state.resolvedAddresses = {};
        this.latestPreviewValues.clear();
        this.persist();
        void this.tryAutoLoadElf(session);
        void this.ensureRealtimeRunning(session);
        this.scheduleSync(true);
      })
    );

    this.disposables.push(
      vscode.debug.onDidTerminateDebugSession((session) => {
        if (this.currentDebugSession?.id === session.id) {
          this.currentDebugSession = undefined;
          this.currentStoppedThreadId = undefined;
        }
        void this.stopLiveWatch();
        this.scheduleSync(true);
      })
    );

    this.disposables.push(
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: (session) => ({
          onDidSendMessage: (message) => {
            if (message?.event === 'stopped') {
              this.currentDebugSession = session;
              this.currentStoppedThreadId = message?.body?.threadId;
              this.passiveCollector.rememberStoppedThread(this.currentStoppedThreadId);
              void this.tryAutoLoadElf(session);
              const resolveNow = [...new Set([...this.state.variableNames, ...this.state.trackedVariables])];
              void this.resolveTrackedVariables(session, resolveNow)
                .then(async () => {
                  await this.refreshPreviewValues(session, this.getAllLeafNodeNames());
                  await this.ensureRealtimeRunning(session);
                });
              if (this.passiveCollector.recording) {
                void this.passiveCollector
                  .collectFromSession(session, [...this.state.trackedVariables])
                  .then(() => this.scheduleSync(true));
              }
            }
            if (message?.event === 'continued') {
              this.currentDebugSession = session;
              void this.ensureRealtimeRunning(session);
              this.scheduleSync();
            }
          }
        })
      })
    );
  }

  private async tryAutoLoadElf(session: vscode.DebugSession): Promise<void> {
    if (this.autoLoadedSessions.has(session.id)) {
      return;
    }
    const elfPath = await this.getElfPathFromSession(session);
    if (!elfPath) {
      return;
    }
    const loaded = await this.liveWatchService.elfResolver.loadSymbols(elfPath);
    if (loaded) {
      this.autoLoadedSessions.add(session.id);
      this.persist();
      this.scheduleSync(true);
    }
  }

  /** 无 debug session 时从工作区检测并加载 ELF */
  private async tryAutoLoadElfFromWorkspace(): Promise<void> {
    if (this.liveWatchService.elfResolver.isLoaded()) {
      return;
    }
    if (!this.elfWorkspacePromise) {
      this.elfWorkspacePromise = this.loadElfFromWorkspace();
    }
    await this.elfWorkspacePromise;
  }

  private async loadElfFromWorkspace(): Promise<void> {
    const elfPath = await this.detectElfFromWorkspace();
    if (!elfPath) {
      warn('No ELF file found in workspace');
      return;
    }
    log(`Loading ELF from workspace: ${elfPath}`);
    const loaded = await this.liveWatchService.elfResolver.loadSymbols(elfPath);
    log(`ELF loaded: ${loaded}, symbols: ${this.liveWatchService.elfResolver.getSymbolCount()}`);
  }

  private async getElfPathFromSession(session: vscode.DebugSession): Promise<string | undefined> {
    const cfg = session.configuration as Record<string, unknown>;
    const candidates = [cfg.program, cfg.executable, cfg.elf];
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) {
        const resolved = this.resolveWorkspacePath(value, session.workspaceFolder);
        if (resolved) {
          return resolved;
        }
      }
    }
    const launchDetected = await this.detectElfFromLaunchConfigs();
    if (launchDetected) {
      return launchDetected;
    }
    return this.detectElfFromWorkspace();
  }

  private resolveWorkspacePath(rawPath: string, workspaceFolder?: vscode.WorkspaceFolder): string | undefined {
    let resolved = rawPath.trim();
    const folder = workspaceFolder ?? vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      resolved = resolved.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath);
      resolved = resolved.replace(/\$\{workspaceRoot\}/g, folder.uri.fsPath);
      resolved = resolved.replace(/\$\{workspaceFolderBasename\}/g, path.basename(folder.uri.fsPath));
    }
    if (!path.isAbsolute(resolved)) {
      const base = folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (base) {
        resolved = path.resolve(base, resolved);
      }
    }
    return resolved ? resolved : undefined;
  }

  private async detectElfFromLaunchConfigs(): Promise<string | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const candidates = new Set<string>();

    for (const workspaceFolder of workspaceFolders) {
      const launchConfig = vscode.workspace.getConfiguration('launch', workspaceFolder.uri);
      const configurations = launchConfig.get<Array<Record<string, unknown>>>('configurations', []);
      for (const config of configurations) {
        const type = typeof config.type === 'string' ? config.type : '';
        if (type !== 'cortex-debug' && type !== 'cppdbg' && type !== 'platformio-debug') {
          continue;
        }
        const exe = typeof config.executable === 'string'
          ? config.executable
          : (typeof config.program === 'string' ? config.program : '');
        if (!exe) {
          continue;
        }
        const resolved = this.resolveWorkspacePath(exe, workspaceFolder);
        if (resolved) {
          candidates.add(resolved);
        }
      }
    }

    const existing = [...candidates].filter((candidate) => !!candidate);
    if (existing.length === 1) {
      return existing[0];
    }
    return undefined;
  }

  private async detectElfFromWorkspace(): Promise<string | undefined> {
    // 优先使用用户手动设置的 ELF 路径
    const configuredPath = this.getConfiguredElfPath();
    if (configuredPath) {
      return configuredPath;
    }

    const patterns = [
      '**/build/**/*.elf',
      '**/cmake-build-*/**/*.elf',
      '**/Debug/**/*.elf',
      '**/Release/**/*.elf',
      '**/.pio/build/**/*.elf',
      '**/Objects/**/*.axf',
      '**/Debug/Exe/**/*.out',
      '**/Release/Exe/**/*.out',
      '**/out/**/*.elf',
      '**/bin/**/*.elf'
    ];

    const candidates = new Set<string>();
    for (const pattern of patterns) {
      const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 10);
      for (const uri of uris) {
        candidates.add(uri.fsPath);
      }
    }

    if (candidates.size === 0) {
      return undefined;
    }

    const list = [...candidates];
    if (list.length > 1) {
      // 有多个 ELF 文件时按优先级选择：优先 Release/RelWithDebInfo，其次 Debug
      const release = list.find((p) => /[/\\\\]Release[/\\\\]/i.test(p) || /[/\\\\]RelWithDebInfo[/\\\\]/i.test(p));
      const chosen = release ?? list[0];
      const releaseCount = list.filter((p) => /[/\\\\]Release[/\\\\]/i.test(p)).length;
      const debugCount = list.filter((p) => /[/\\\\]Debug[/\\\\]/i.test(p)).length;
      console.log(
        `[waveform-plotter] Found ${list.length} ELF files, auto-selected: "${chosen}" ` +
        `(Release: ${releaseCount}, Debug: ${debugCount}). ` +
        `Set waveformPlotter.elfPath to override.`
      );
      return chosen;
    }

    return list[0];
  }

  private getConfiguredElfPath(): string | undefined {
    const raw = vscode.workspace.getConfiguration('waveformPlotter').get<string>('elfPath', '').trim();
    if (!raw) {
      return undefined;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    const resolved = raw.replace(/\$\{workspaceFolder\}/g, folder?.uri.fsPath ?? '')
                        .replace(/\$\{workspaceRoot\}/g, folder?.uri.fsPath ?? '');
    try {
      const fsSync = require('fs') as typeof import('fs');
      if (fsSync.statSync(resolved).isFile()) {
        return resolved;
      }
      console.warn(`[waveform-plotter] Configured elfPath "${resolved}" is not a file.`);
      return undefined;
    } catch {
      console.warn(`[waveform-plotter] Configured elfPath "${resolved}" cannot be accessed.`);
      return undefined;
    }
  }

  private async startLiveWatch(): Promise<void> {
    if (this.startLiveWatchTask) {
      await this.startLiveWatchTask;
      return;
    }

    this.startLiveWatchTask = this.startLiveWatchCore();
    try {
      await this.startLiveWatchTask;
    } finally {
      this.startLiveWatchTask = null;
    }
  }

  private async startLiveWatchCore(): Promise<void> {
    const session = this.currentDebugSession ?? vscode.debug.activeDebugSession;
    const tracked = [...new Set(this.state.trackedVariables)];
    const resolveTargets = [...new Set([...this.state.variableNames, ...tracked])];
    if (!resolveTargets.length) {
      void vscode.window.showWarningMessage('Please select variables first.');
      return;
    }

    const telnetPort = this.state.telnetPort;
    log(`startLiveWatch: ${resolveTargets.length} targets, telnetPort=${telnetPort}, freq=${this.state.liveWatchFrequency}Hz`);

    // 对整个 resolution + connection 加总超时，防止卡死
    const STALL_TIMEOUT_MS = 12000;
    let stalled = false;
    const timer = setTimeout(() => {
      stalled = true;
    }, STALL_TIMEOUT_MS);
    try {

    // 只解析尚未解析过的变量，避免重复 GDB 调用
    const resolvedEntries = this.liveWatchService.getResolvedEntries();
    const alreadyResolved = new Set([
      ...Object.keys(resolvedEntries),
      ...this.liveWatchService.getKnownLeafNodes()
    ]);
    const needsResolution = resolveTargets.filter((name) => !alreadyResolved.has(name));
    log(`startLiveWatch: ${Object.keys(resolvedEntries).length} already resolved, ${needsResolution.length} need resolution`);

    if (needsResolution.length > 0) {
      if (session) {
        log(`Resolving ${needsResolution.length} vars via debug session`);
        await this.resolveTrackedVariables(session, needsResolution);
      } else {
        // 无 debug session 时尝试自动加载 ELF
        if (!this.liveWatchService.elfResolver.isLoaded()) {
          await this.tryAutoLoadElfFromWorkspace();
        }
        if (this.liveWatchService.elfResolver.isLoaded()) {
          log(`Resolving ${needsResolution.length} vars from ELF`);
          await this.liveWatchService.resolveFromElf(
            this.liveWatchService.elfResolver.lastElfPath ?? '',
            needsResolution
          );
        } else {
          warn('Cannot resolve - ELF not loaded');
        }
      }
    }

    // 检查是否有已解析的条目可以开始采集
    const finalEntries = this.liveWatchService.getResolvedEntries();
    const finalEntryCount = Object.keys(finalEntries).length;
    log(`startLiveWatch: final resolved entries: ${finalEntryCount}`);
    if (finalEntryCount === 0) {
      const elfLoaded = this.liveWatchService.elfResolver.isLoaded();
      const elfPath = this.liveWatchService.elfResolver.lastElfPath;
      const targetNames = resolveTargets.join(', ');
      let msg = `Failed to resolve variables: "${targetNames}".`;
      if (!elfLoaded) {
        msg += `\nNo ELF file loaded. Set "waveformPlotter.elfPath" in settings to specify the ELF file path, or ensure a .elf file exists in the workspace (searched **/build/**/*.elf, **/Debug/**/*.elf, etc.).`;
      } else {
        msg += `\nELF loaded: ${elfPath}.`;
        msg += `\nThe variable name may not match any symbol in the ELF. Check the variable name and try again.`;
      }
      warn(msg);
      void vscode.window.showWarningMessage(msg);
      return;
    }

    // Log first few entries for diagnostics
    const entryNames = Object.keys(finalEntries).slice(0, 5);
    for (const name of entryNames) {
      const e = finalEntries[name];
      log(`  Entry: ${name} addr=0x${e.address.toString(16)} type=${e.dataType}`);
    }

    if (session) {
      log(`Starting Live Watch via debug session: ${session.name}`);
      await this.liveWatchService.startLiveWatchViaSession(session, this.state.liveWatchFrequency);
    } else {
      await this.liveWatchService.startLiveWatch(telnetPort, this.state.liveWatchFrequency);
    }
    if (!this.liveWatchService.isRunning.value) {
      logError(`Live Watch failed: ${this.liveWatchService.lastError ?? 'unknown'}`);
      void vscode.window.showErrorMessage(
        `Live Watch failed to start.\n` +
        `Error: ${this.liveWatchService.lastError ?? '(no error details)'}\n` +
        `Make sure OpenOCD is running and connected to the target device.`
      );
      return;
    }
    log(`Live Watch started successfully`);

    } finally {
      clearTimeout(timer);
      if (stalled) {
        // 如果超时，立即停止 live watch 避免后台残留
        this.liveWatchService.lastError = 'Connection timed out. Check that OpenOCD is running on the target port.';
        await this.liveWatchService.stopLiveWatch();
        logError('Live Watch timed out');
        void vscode.window.showErrorMessage(
          'Live Watch failed to start.\n' +
          'Connection timed out after 12 seconds.\n' +
          'Make sure OpenOCD is running and the target is connected.'
        );
        return;
      }
    }

    this.state.resolvedAddresses = this.liveWatchService.dumpResolvedEntries();
    this.persist();
    this.scheduleSync(true);
  }

  private async stopLiveWatch(): Promise<void> {
    await this.liveWatchService.stopLiveWatch();
    this.scheduleSync(true);
  }

  private async startRtt(): Promise<void> {
    const tracked = [...new Set(this.state.trackedVariables)];
    if (!tracked.length) {
      void vscode.window.showWarningMessage('Please select variables first.');
      return;
    }

    if (this.state.rttAutoInit) {
      const telnetPort = this.state.telnetPort;
      const ok = await this.rttService.initOpenOcdRtt(telnetPort, this.state.rttPort, this.state.rttRamStart, this.state.rttRamSize);
      if (!ok) {
        void vscode.window.showErrorMessage(this.rttService.lastError ?? 'RTT init failed.');
        this.scheduleSync(true);
        return;
      }
      await sleep(120);
    }

    await this.rttService.startRtt('127.0.0.1', this.state.rttPort, tracked);
    if (!this.rttService.isRunning.value) {
      void vscode.window.showErrorMessage(this.rttService.lastError ?? 'RTT failed to start.');
      return;
    }

    this.scheduleSync(true);
  }

  private async stopRtt(): Promise<void> {
    await this.rttService.stopRtt();
    if (this.state.rttAutoInit) {
      await this.rttService.stopOpenOcdRtt(this.state.telnetPort);
    }
    this.scheduleSync(true);
  }

  private absorbExpandedMembers(): void {
    const allResolved = this.liveWatchService.getResolvedEntries();
    const resolvedNames = new Set([
      ...Object.keys(allResolved),
      ...this.liveWatchService.getKnownLeafNodes()
    ]);
    for (const rootName of this.state.variableNames) {
      const childNames = [...resolvedNames].filter((key) => isDescendantPath(key, rootName));
      if (childNames.length === 0) {
        continue;
      }
      this.state.trackedVariables = this.state.trackedVariables.filter((v) => v !== rootName);
      this.dataBuffer.removeChannel(rootName);
      for (const channelName of this.dataBuffer.getChannels().map((c) => c.name)) {
        if (isDescendantPath(channelName, rootName) && !this.state.trackedVariables.includes(channelName)) {
          this.dataBuffer.removeChannel(channelName);
        }
      }
    }
  }

  private buildTreeStructureSignature(): string {
    return [
      this.state.variableNames.join(','),
      this.state.expandedNodes.join(','),
      this.state.trackedVariables.join(','),
      this.liveWatchService.getKnownTreeNodes().join(','),
      this.liveWatchService.getKnownLeafNodes().join(','),
      Object.keys(this.liveWatchService.getResolvedEntries()).join(',')
    ].join('|');
  }

  private buildTreeRows(): TreeViewRow[] {
    // 生成树结构签名，仅在结构/状态变化时重建
    const treeSig = this.buildTreeStructureSignature();
    if (this.cachedTreeRows && this.cachedTreeSig === treeSig) {
      // 结构未变，只需要更新值
      return this.updateCachedTreeValues();
    }
    this.cachedTreeSig = treeSig;
    this.cachedTreeStructureVersion += 1;

    const resolved = this.liveWatchService.getResolvedEntries();
    const expandedSet = new Set(this.state.expandedNodes);
    const allNodes = new Set<string>();
    const relatedNodes = [
      ...Object.keys(resolved),
      ...this.liveWatchService.getKnownTreeNodes()
    ];
    for (const name of this.state.variableNames) {
      for (const path of getAncestorPaths(name)) {
        allNodes.add(path);
      }
      for (const resolvedName of relatedNodes) {
        if (resolvedName !== name && !isDescendantPath(resolvedName, name)) {
          continue;
        }
        for (const path of getAncestorPaths(resolvedName)) {
          if (path === name || isDescendantPath(path, name)) {
            allNodes.add(path);
          }
        }
      }
    }

    const children = new Map<string, string[]>();
    const hasChildren = new Set<string>();
    for (const node of allNodes) {
      const parent = getParentPath(node);
      if (!parent) {
        continue;
      }
      const direct = children.get(parent) ?? [];
      direct.push(node);
      children.set(parent, direct);
      hasChildren.add(parent);
    }
    for (const [parent, direct] of children.entries()) {
      direct.sort(compareWatchPaths);
      children.set(parent, direct);
    }

    const roots = [...allNodes].filter((n) => !getParentPath(n)).sort(compareWatchPaths);
    const rows: TreeViewRow[] = [];
    const channelsByName = new Map(this.dataBuffer.getChannels().map((channel) => [channel.name, channel]));

    const walk = (names: string[], depth: number) => {
      for (const name of names) {
        const entry = resolved[name];
        const hintedType = this.liveWatchService.getKnownLeafType(name);
        const declaredTypeText = entry?.declaredTypeText ?? this.liveWatchService.getKnownLeafDeclaredType(name);
        const displayName = getDisplayName(name);
        const nodeHasChildren = hasChildren.has(name);
        const channel = channelsByName.get(name);
        const latest = channel && channel.size > 0 ? channel.get(channel.size - 1) : undefined;
        const previewVal = this.liveWatchService.getLastReadValue(name);
        const valueText = this.getDisplayValueText(name, latest ?? previewVal, entry?.dataType ?? hintedType)
          || this.liveWatchService.getKnownDisplayValue(name)
          || '';
        const trackTargets = this.getTrackTargetNames(name);
        const trackedCount = trackTargets.filter((target) => this.state.trackedVariables.includes(target)).length;
        let checkState: TreeViewRow['checkState'] = 'unchecked';
        if (trackedCount === trackTargets.length && trackedCount > 0) {
          checkState = 'checked';
        } else if (trackedCount > 0) {
          checkState = 'partial';
        }
        const selectable = depth > 0 && isSelectableLeafNode(nodeHasChildren, declaredTypeText, entry?.dataType ?? hintedType);
        rows.push({
          name,
          displayName,
          depth,
          valueText,
          dataType: declaredTypeText ?? formatInternalDataType(entry?.dataType ?? hintedType),
          address: entry ? `0x${entry.address.toString(16)}` : '',
          hasChildren: nodeHasChildren,
          expanded: expandedSet.has(name),
          selectable,
          editable: selectable && !!entry,
          checkState,
          color: channel?.color ?? '',
          isRoot: depth === 0
        });
        if (nodeHasChildren && expandedSet.has(name)) {
          walk((children.get(name) ?? []).sort(compareWatchPaths), depth + 1);
        }
      }
    };

    walk(roots, 0);
    this.cachedTreeRows = rows;
    return rows;
  }

  /** 树结构未变时，只更新值（valueText、checkState、color、address），避免重建整个 DOM */
  private updateCachedTreeValues(): TreeViewRow[] {
    if (!this.cachedTreeRows) return [];
    const resolved = this.liveWatchService.getResolvedEntries();
    const channelsByName = new Map(this.dataBuffer.getChannels().map((channel) => [channel.name, channel]));
    for (const row of this.cachedTreeRows) {
      const entry = resolved[row.name];
      const channel = channelsByName.get(row.name);
      const latest = channel && channel.size > 0 ? channel.get(channel.size - 1) : undefined;
      const previewVal = this.liveWatchService.getLastReadValue(row.name);
      row.valueText = this.getDisplayValueText(row.name, latest ?? previewVal, entry?.dataType)
        || this.liveWatchService.getKnownDisplayValue(row.name)
        || '';
      row.dataType = entry?.declaredTypeText ?? this.liveWatchService.getKnownLeafDeclaredType(row.name)
        ?? formatInternalDataType(entry?.dataType ?? this.liveWatchService.getKnownLeafType(row.name));
      row.address = entry ? `0x${entry.address.toString(16)}` : '';
      const trackTargets = this.getTrackTargetNames(row.name);
      const trackedCount = trackTargets.filter((t) => this.state.trackedVariables.includes(t)).length;
      if (trackedCount === trackTargets.length && trackedCount > 0) {
        row.checkState = 'checked';
      } else if (trackedCount > 0) {
        row.checkState = 'partial';
      } else {
        row.checkState = 'unchecked';
      }
      row.color = channel?.color ?? '';
      row.editable = row.selectable && !!entry;
    }
    return this.cachedTreeRows;
  }

  private rebuildBufferFromState(): void {
    if (this.state.variableNames.length === 0) {
      this.clearTrackedRuntimeState();
      return;
    }
    // 启动时清除旧持久化跟踪状态，用户需手动勾选需要跟踪的变量。
    // 这是为了防止旧版本自动展开结构体占满通道导致无法添加新变量。
    this.clearTrackedRuntimeState();
  }

  private async loadState(): Promise<void> {
    const saved = this.context.workspaceState.get<PersistedState>(this.stateKey);
    this.state = { ...structuredClone(DEFAULT_STATE), ...(saved ?? {}) };
    this.sanitizeLoadedState();
  }

  /** 收集所有已知叶子节点名称（已解析 + 已知树叶子 + 无子节点的根变量） */
  private getAllLeafNodeNames(): string[] {
    const resolved = this.liveWatchService.getResolvedEntries();
    const knownLeafs = this.liveWatchService.getKnownLeafNodes();
    const leafSet = new Set<string>();
    for (const name of Object.keys(resolved)) {
      leafSet.add(name);
    }
    for (const name of knownLeafs) {
      leafSet.add(name);
    }
    for (const name of this.state.variableNames) {
      const hasDescendant = [...leafSet].some((entry) => isDescendantPath(entry, name));
      if (!hasDescendant && !leafSet.has(name)) {
        leafSet.add(name);
      }
    }
    return [...leafSet];
  }

  private async refreshPreviewValues(
    session: vscode.DebugSession,
    names: string[]
  ): Promise<void> {
    const values = await this.passiveCollector.readCurrentValues(session, this.getPreferredPreviewNames(names));
    for (const [name, value] of values.entries()) {
      this.latestPreviewValues.set(name, value);
    }
    if (values.size > 0) {
      this.scheduleTreeValueSync(true);
    }
  }

  private async resolveTrackedVariables(
    session: vscode.DebugSession,
    variableNames: string[]
  ): Promise<number> {
    const names = [...new Set(variableNames.map((name) => name.trim()).filter(Boolean))];
    if (names.length === 0) {
      return 0;
    }

    await this.tryAutoLoadElf(session);

    let resolvedFromElf = 0;
    if (this.liveWatchService.elfResolver.isLoaded()) {
      // resolveFromElf 内部已处理 nm 符号查找 + ptype /o 复合类型展开 + whatis/sizeof 简单类型，
      // 并在 liveWatchService.knownTreeNodes / knownLeafNodes / watchEntries 中注册了完整结果。
      // 此处不再需要重复调用 resolveCompositeWatchTree / resolveCompositeLeafInfos。
      resolvedFromElf = await this.liveWatchService.resolveFromElf(
        this.liveWatchService.elfResolver.lastElfPath ?? '',
        names
      );
    }

    const unresolved = names.filter((name) => !this.hasResolvedNameOrDescendant(name));
    let resolvedFromSession = 0;
    if (unresolved.length > 0) {
      resolvedFromSession = await this.liveWatchService.resolveVariables(session, unresolved, this.currentStoppedThreadId);
    }

    if (session.type !== 'cortex-debug') {
      await this.liveWatchService.refineResolvedTypes(session, names, this.currentStoppedThreadId);
    }
    this.absorbExpandedMembers();
    this.pruneInvalidResolvedState();
    this.persist();

    const finalResolvedCount = names.filter((name) => this.hasResolvedNameOrDescendant(name)).length;
    return Math.max(resolvedFromElf + resolvedFromSession, finalResolvedCount);
  }

  /** 无 debug session 时纯 ELF 解析（nm + gdb 读取 ELF，无需目标连接） */
  private async resolveTrackedFromElf(elfPath: string, names: string[]): Promise<void> {
    // resolveFromElf 内部已处理 nm 符号查找 + 复合类型展开 + 简单类型解析，
    // 并在 liveWatchService 中注册了完整结果。
    const resolvedCount = await this.liveWatchService.resolveFromElf(elfPath, names);
    if (resolvedCount === 0) {
      return;
    }
    this.absorbExpandedMembers();
    this.pruneInvalidResolvedState();
    this.persist();
  }

  private async ensureRealtimeRunning(session?: vscode.DebugSession): Promise<void> {
    if (this.suppressAutoLiveUntilNextSession) {
      return;
    }

    if (this.state.variableNames.length === 0) {
      this.clearTrackedRuntimeState();
      return;
    }

    const activeSession = session ?? this.currentDebugSession ?? vscode.debug.activeDebugSession;
    if (!activeSession) {
      return;
    }

    if (this.state.dataSource === 'RTT') {
      if (!this.rttService.isRunning.value) {
        await this.startRtt();
      }
      return;
    }

    if (!this.liveWatchService.isRunning.value) {
      await this.startLiveWatch();
    }
  }

  private persist(): void {
    this.state.resolvedAddresses = this.liveWatchService.dumpResolvedEntries();
    const snapshot = structuredClone(this.state);
    this.persistTask = this.persistTask
      .catch(() => undefined)
      .then(() => this.context.workspaceState.update(this.stateKey, snapshot));
  }

  private scheduleSync(immediate = false): void {
    if (immediate) {
      if (this.syncTimer) {
        clearTimeout(this.syncTimer);
        this.syncTimer = undefined;
      }
      void this.pushState();
      return;
    }
    if (this.syncTimer) {
      return;
    }
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      void this.pushState();
    }, 16);
  }

  private scheduleTreeValueSync(immediate = false): void {
    const now = Date.now();
    const minInterval = WaveformController.TREE_VALUE_SYNC_INTERVAL_MS;
    if (immediate) {
      if (now - this.lastTreeValueSyncAt >= minInterval) {
        this.lastTreeValueSyncAt = now;
        this.scheduleSync(true);
        return;
      }
      if (this.treeValueSyncTimer) {
        return;
      }
      const delay = Math.max(0, minInterval - (now - this.lastTreeValueSyncAt));
      this.treeValueSyncTimer = setTimeout(() => {
        this.treeValueSyncTimer = undefined;
        this.lastTreeValueSyncAt = Date.now();
        this.scheduleSync(true);
      }, delay);
      return;
    }
    if (this.treeValueSyncTimer) {
      return;
    }
    const delay = Math.max(0, minInterval - (now - this.lastTreeValueSyncAt));
    this.treeValueSyncTimer = setTimeout(() => {
      this.treeValueSyncTimer = undefined;
      this.lastTreeValueSyncAt = Date.now();
      this.scheduleSync(true);
    }, delay);
  }

  private async pushState(): Promise<void> {
    const channels = this.dataBuffer.getChannels();
    const visibleChannels = this.getVisibleChannels(channels);
    const channelSignature = visibleChannels.map((c) => c.name).join('\u0001');
    const dataVersionChanged = this.dataBuffer.version !== this.lastPushedDataVersion;
    const structureChanged = channelSignature !== this.lastPushedChannelSignature;
    this.liveWatchService.setPreviewSampleTargets(this.getPreferredPreviewNames(this.getAllLeafNodeNames()));
    const treeStructureChanged = !this.cachedTreeRows || this.cachedTreeSig !== this.buildTreeStructureSignature();
    const now = Date.now();
    const shouldSyncTreeValues = now - this.lastTreeValueSyncAt >= WaveformController.TREE_VALUE_SYNC_INTERVAL_MS;

    // 记录当前 buffer 状态
    const latestValues = visibleChannels.map((c) => ({
      name: c.name,
      size: c.size,
      latest: c.size > 0 ? c.get(c.size - 1) : undefined
    }));
    const hasValues = latestValues.some((v) => v.latest !== undefined && Number.isFinite(v.latest));
    if (dataVersionChanged && hasValues) {
      log(`pushState: ${channels.length} channels, ver=${this.dataBuffer.version}, ts=${this.dataBuffer.tsSize}, values=[${latestValues.map(v => `${v.name}=${v.latest ?? '?'}`).join(', ')}]`);
    }

    const canAppend =
      this.viewProvider.hasView() &&
      dataVersionChanged &&
      !structureChanged &&
      !treeStructureChanged &&
      this.dataBuffer.tsSize > 0;

    if (canAppend) {
      const append = this.buildAppendState(visibleChannels.map((c) => c.name));
      if (append && append.timestampsSec.length > 0) {
        if (shouldSyncTreeValues) {
          const treeRows = this.buildTreeRows();
          const viewState = this.buildViewState(channels, false, treeRows, false);
          this.viewProvider.postState(viewState);
          this.lastTreeValueSyncAt = now;
          this.lastPushedTreeVersion = this.cachedTreeStructureVersion;
        }
        this.viewProvider.postAppend(append);
        this.lastPushedDataVersion = this.dataBuffer.version;
        this.lastPushedChannelSignature = channelSignature;
        this.lastPushedTotalSamples = append.totalSamples;
        log(`pushState: append ${append.timestampsSec.length} samples`);
        return;
      }
    }

    const treeRows = this.buildTreeRows();
    this.lastTreeValueSyncAt = now;
    const includeData = dataVersionChanged || structureChanged;
    const viewState = this.buildViewState(channels, includeData, treeRows, true);
    this.viewProvider.postState(viewState);

    if (includeData) {
      this.lastPushedDataVersion = this.dataBuffer.version;
      this.lastPushedChannelSignature = channelSignature;
      this.lastPushedTotalSamples = this.dataBuffer.totalSamples;
    }
    this.lastPushedTreeVersion = this.cachedTreeStructureVersion;
  }

  private buildViewState(
    channels: ReturnType<DataBuffer['getChannels']>,
    includeData: boolean,
    treeRows?: TreeViewRow[],
    includeTree = true
  ): WaveformViewState {
    const visibleChannels = this.getVisibleChannels(channels);
    const channelsByName = new Map(channels.map((channel) => [channel.name, channel]));
    const variables = this.state.variableNames.map((name) => {
      const ch = channelsByName.get(name);
      const entry = this.liveWatchService.getResolvedEntries()[name];
      const valueText = this.getDisplayValueText(name, ch?.size ? ch.get(ch.size - 1) : undefined, entry?.dataType);
      return {
        name,
        checked: this.state.trackedVariables.includes(name),
        valueText,
        color: ch?.color ?? '#ccc'
      };
    });
    // 构建 tree rows（仅一次，避免 O(n^2) 双重计算）
    const effectiveTreeRows = treeRows ?? this.buildTreeRows();
    const leafRows = effectiveTreeRows.filter(r => !r.hasChildren);
    const rowsWithValues = leafRows.filter(r => r.valueText);
    if (rowsWithValues.length > 0) {
      log(`buildViewState: ${leafRows.length} leaf rows, ${rowsWithValues.length} with values: ${rowsWithValues.slice(0, 5).map(r => `${r.name}=${r.valueText}`).join(', ')}`);
    }

    const liveRunning = this.state.dataSource === 'RTT'
      ? this.rttService.isRunning.value
      : this.liveWatchService.livePlotting;

    return {
      bufferCapacity: this.dataBuffer.capacity,
      totalSamples: this.dataBuffer.totalSamples,
      trackedCount: this.state.trackedVariables.length,
      activeChannelCount: visibleChannels.length,
      variables,
      data: includeData ? this.buildFilteredSnapshot(visibleChannels) : undefined,
      treeVariables: includeTree ? effectiveTreeRows : undefined,
      treeValueUpdates: includeTree ? undefined : this.buildTreeValueUpdates(effectiveTreeRows),
      status: this.buildStatusText(),
      sessionStatus: this.currentDebugSession ? 'Debug session active' : 'No debug session',
      liveStatus: this.buildLiveStatusText(),
      recording: this.passiveCollector.recording,
      liveRunning,
      dataSource: this.state.dataSource,
      frequencyHz: this.state.liveWatchFrequency,
      actualFrequencyHz: this.state.dataSource === 'RTT'
        ? this.rttService.getActualFrequencyHz()
        : this.liveWatchService.getActualFrequencyHz(),
      displayMode: this.state.displayMode,
      timeUnit: this.state.timeUnit,
      fontSize: this.state.fontSize,
      lineWidth: this.state.lineWidth,
      refreshFps: this.state.refreshFps,
      settings: {
        telnetPort: this.state.telnetPort,
        rttPort: this.state.rttPort,
        rttRamStart: this.state.rttRamStart,
        rttRamSize: this.state.rttRamSize,
        rttAutoInit: this.state.rttAutoInit
      }
    };
  }

  private getDisplayValueText(name: string, latestBuffered: number | undefined, dataType?: string): string {
    if (latestBuffered !== undefined && Number.isFinite(latestBuffered)) {
      if (dataType === 'ENUM') {
        const enumName = this.liveWatchService.getEnumConstantName(name, latestBuffered);
        if (enumName) { return enumName; }
      }
      return formatCompactValue(latestBuffered, dataType);
    }
    const preview = this.latestPreviewValues.get(name);
    if (preview !== undefined && Number.isFinite(preview)) {
      if (dataType === 'ENUM') {
        const enumName = this.liveWatchService.getEnumConstantName(name, preview);
        if (enumName) { return enumName; }
      }
      return formatCompactValue(preview, dataType);
    }
    return '';
  }

  private buildAppendState(visibleNames: string[]): WaveformAppendState | undefined {
    const append = this.dataBuffer.appendSnapshotSince(this.lastPushedTotalSamples);
    if (!append) {
      return undefined;
    }
    return {
      totalSamples: append.totalSamples,
      timestampsSec: append.timestampsSec,
      channels: append.channels.filter((ch) => visibleNames.includes(ch.name))
    };
  }

  private buildStatusText(): string {
    const channels = this.dataBuffer.getChannels();
    if (!channels.length) {
      return 'Select variables and start recording to see waveforms';
    }
    const maxPoints = channels.reduce((m, ch) => Math.max(m, ch.size), 0);
    return `#${this.passiveCollector.sampleCount + this.liveWatchService.sampleCount + this.rttService.sampleCount} samples | ${maxPoints} pts`;
  }

  private buildLiveStatusText(): string {
    if (this.state.dataSource === 'RTT') {
      if (!this.rttService.isRunning.value) {
        return '';
      }
      const actualHz = this.rttService.getActualFrequencyHz();
      return this.rttService.lastError
        ? 'RTT: error'
        : `RTT: tcp:${this.state.rttPort} ${actualHz > 0 ? `${actualHz.toFixed(actualHz >= 100 ? 0 : 1)}Hz ` : ''}(${this.rttService.sampleCount})`;
    }
    if (!this.liveWatchService.isRunning.value) {
      return '';
    }
    const endpointLabel = this.liveWatchService.getLiveEndpointLabel() || `port:${this.state.telnetPort}`;
    const actualHz = this.liveWatchService.getActualFrequencyHz();
    return this.liveWatchService.lastError
      ? 'Live: error'
      : `Live: ${endpointLabel}@${this.state.liveWatchFrequency}Hz ${actualHz > 0 ? `${actualHz.toFixed(actualHz >= 100 ? 0 : 1)}Hz ` : ''}(${this.liveWatchService.sampleCount})`;
  }

  private hasResolvedNameOrDescendant(name: string): boolean {
    const resolvedEntries = this.liveWatchService.getResolvedEntries();
    if (resolvedEntries[name]) {
      return true;
    }
    return Object.keys(resolvedEntries).some((entryName) => isDescendantPath(entryName, name));
  }

  private getTrackTargetNames(name: string): string[] {
    const descendantCandidates = [
      ...Object.keys(this.liveWatchService.getResolvedEntries()),
      ...this.liveWatchService.getKnownLeafNodes()
    ];
    const descendants = [...new Set(descendantCandidates)].filter((entryName) => isDescendantPath(entryName, name));
    if (descendants.length > 0) {
      return descendants.sort(compareWatchPaths);
    }
    return [name];
  }

  private getVisibleChannels(channels: ReturnType<DataBuffer['getChannels']>): ReturnType<DataBuffer['getChannels']> {
    const tracked = new Set(this.state.trackedVariables);
    return channels.filter((channel) => tracked.has(channel.name));
  }

  private buildTreeValueUpdates(rows: TreeViewRow[]): NonNullable<WaveformViewState['treeValueUpdates']> {
    return rows.map((row) => ({
      name: row.name,
      valueText: row.valueText,
      dataType: row.dataType,
      address: row.address,
      checkState: row.checkState,
      color: row.color,
      editable: row.editable
    }));
  }

  private getPreferredPreviewNames(names: string[]): string[] {
    const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
    if (unique.length <= 64) {
      return unique;
    }

    const expanded = new Set(this.state.expandedNodes);
    const tracked = new Set(this.state.trackedVariables);
    const preferred: string[] = [];
    for (const name of unique) {
      const parent = getParentPath(name);
      if (!parent) {
        if (tracked.has(name)) {
          preferred.push(name);
        }
        continue;
      }
      if (tracked.has(name) || expanded.has(parent)) {
        preferred.push(name);
      }
    }

    if (preferred.length > 0) {
      return preferred.slice(0, 128);
    }
    const trackedOnly = unique.filter((name) => tracked.has(name));
    if (trackedOnly.length > 0) {
      return trackedOnly.slice(0, 128);
    }
    return unique.slice(0, 64);
  }

  private buildFilteredSnapshot(channels: ReturnType<DataBuffer['getChannels']>): NonNullable<WaveformViewState['data']> {
    const full = this.dataBuffer.snapshot();
    return {
      timestampsSec: full.timestampsSec,
      version: full.version,
      channels: full.channels.filter((channel) => channels.some((visible) => visible.name === channel.name))
    };
  }

  private pruneInvalidResolvedState(): void {
    if (this.state.variableNames.length === 0) {
      this.clearTrackedRuntimeState();
      return;
    }

    const validNames = new Set<string>();
    const knownLeafs = new Set(this.liveWatchService.getKnownLeafNodes());
    const resolvedNames = new Set(Object.keys(this.liveWatchService.getResolvedEntries()));

    for (const rootName of this.state.variableNames) {
      const descendants = [...new Set([...knownLeafs, ...resolvedNames])]
        .filter((name) => isDescendantPath(name, rootName));
      if (descendants.length > 0) {
        for (const name of descendants) {
          validNames.add(name);
        }
      } else if (resolvedNames.has(rootName)) {
        validNames.add(rootName);
      }
    }

    this.state.trackedVariables = this.state.trackedVariables.filter((name) => validNames.has(name));

    for (const key of [...this.latestPreviewValues.keys()]) {
      if (!validNames.has(key)) {
        this.latestPreviewValues.delete(key);
      }
    }

    for (const channelName of this.dataBuffer.getChannels().map((c) => c.name)) {
      if (!validNames.has(channelName)) {
        this.dataBuffer.removeChannel(channelName);
      }
    }

    for (const resolvedName of Object.keys(this.liveWatchService.getResolvedEntries())) {
      if (!validNames.has(resolvedName) && !this.state.variableNames.includes(resolvedName)) {
        this.liveWatchService.removeResolvedEntry(resolvedName);
      }
    }
  }

  private sanitizeLoadedState(): void {
    this.state.variableNames = [...new Set(this.state.variableNames.map((name) => name.trim()).filter(Boolean))];
    this.state.trackedVariables = [...new Set(this.state.trackedVariables.map((name) => name.trim()).filter(Boolean))];
    this.state.expandedNodes = [...new Set(this.state.expandedNodes.map((name) => name.trim()).filter(Boolean))];
    if (this.state.variableNames.length === 0) {
      this.state.trackedVariables = [];
      this.state.expandedNodes = [];
      this.state.resolvedAddresses = {};
    }
  }

  private clearTrackedRuntimeState(): void {
    this.state.trackedVariables = [];
    this.state.expandedNodes = [];
    this.state.resolvedAddresses = {};
    this.latestPreviewValues.clear();
    this.liveWatchService.clearResolvedEntries();
    for (const channelName of this.dataBuffer.getChannels().map((c) => c.name)) {
      this.dataBuffer.removeChannel(channelName);
    }
  }

  private pruneChannelsToTrackedSet(allowedNames: Set<string>): void {
    for (const channelName of this.dataBuffer.getChannels().map((c) => c.name)) {
      if (!allowedNames.has(channelName)) {
        this.dataBuffer.removeChannel(channelName);
      }
    }
  }
}

function csvField(s: string): string {
  return /[,"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function splitWatchPath(name: string): string[] {
  return name.match(/[^.[\]]+|\[[^\]]+\]/g) ?? [];
}

function buildWatchPath(segments: string[]): string {
  let out = '';
  for (const segment of segments) {
    if (!out) {
      out = segment;
    } else if (segment.startsWith('[')) {
      out += segment;
    } else {
      out += `.${segment}`;
    }
  }
  return out;
}

function getAncestorPaths(name: string): string[] {
  const segments = splitWatchPath(name);
  const paths: string[] = [];
  for (let i = 1; i <= segments.length; i += 1) {
    paths.push(buildWatchPath(segments.slice(0, i)));
  }
  return paths;
}

function getParentPath(name: string): string | undefined {
  const segments = splitWatchPath(name);
  if (segments.length <= 1) {
    return undefined;
  }
  return buildWatchPath(segments.slice(0, -1));
}

function getDisplayName(name: string): string {
  const segments = splitWatchPath(name);
  return segments[segments.length - 1] ?? name;
}

function isDescendantPath(candidate: string, parent: string): boolean {
  const candidateSegments = splitWatchPath(candidate);
  const parentSegments = splitWatchPath(parent);
  if (candidateSegments.length <= parentSegments.length) {
    return false;
  }
  for (let i = 0; i < parentSegments.length; i += 1) {
    if (candidateSegments[i] !== parentSegments[i]) {
      return false;
    }
  }
  return true;
}

function compareWatchPaths(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

function formatCompactValue(v: number, dataType?: string): string {
  if (!Number.isFinite(v)) {
    return 'NaN';
  }
  if (dataType === 'BOOL') {
    return v !== 0 ? 'true' : 'false';
  }
  const prefix = dataType ? `(${dataType.toLowerCase()}) ` : '';
  const abs = Math.abs(v);
  const body = abs >= 10000 ? v.toFixed(0) : abs >= 1 ? v.toFixed(3) : abs >= 0.001 ? v.toFixed(5) : v.toExponential(2);
  return `${prefix}${body}`;
}

function formatInternalDataType(dataType?: string): string {
  return dataType ? dataType.toLowerCase() : '';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, v));
}

function isSelectableLeafNode(
  hasChildren: boolean,
  declaredTypeText: string | undefined,
  dataType: unknown
): boolean {
  if (hasChildren) {
    return false;
  }
  if (dataType) {
    return true;
  }
  if (!declaredTypeText) {
    return false;
  }
  const normalized = declaredTypeText.replace(/\s+/g, ' ').trim();
  if (/[&*]/.test(normalized) || /^(class|struct|union)\b/i.test(normalized)) {
    return false;
  }
  return true;
}

function clampInt(v: number, min: number, max: number, fallback: number): number {
  return Math.round(clamp(v, min, max, fallback));
}

function normalizeRefreshFps(v: number): number {
  if (v >= 120) {
    return 120;
  }
  if (v >= 60) {
    return 60;
  }
  return 30;
}
