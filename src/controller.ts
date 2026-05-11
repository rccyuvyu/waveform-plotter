import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { DataBuffer } from './core/dataBuffer';
import { DEFAULT_STATE, PersistedState, TreeViewRow } from './core/types';
import { LiveWatchService } from './services/liveWatchService';
import { PassiveCollector } from './services/passiveCollector';
import { RttService } from './services/rttService';
import { WaveformAppendState, WaveformViewProvider, WaveformViewState } from './ui/panel';

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
  private suppressAutoLiveUntilNextSession = false;

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
    await this.loadState();
    this.registerListeners();
    this.rebuildBufferFromState();
    if (vscode.debug.activeDebugSession) {
      this.currentDebugSession = vscode.debug.activeDebugSession;
      void this.ensureRealtimeRunning(vscode.debug.activeDebugSession);
    }
    this.scheduleSync(true);
  }

  dispose(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
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
    if (!this.state.variableNames.includes(trimmed)) {
      this.state.variableNames.push(trimmed);
    }
    if (!this.dataBuffer.getChannels().some((c) => c.name === trimmed)) {
      const channel = this.dataBuffer.addChannel(trimmed);
      if (!channel) {
        void vscode.window.showWarningMessage(
          `Variable "${trimmed}" was added, but it cannot be plotted because the channel limit (${this.dataBuffer.maxChannels}) has been reached.`
        );
      }
    }
    await this.setTracked(trimmed, checked);
    const session = this.currentDebugSession ?? vscode.debug.activeDebugSession;
    if (session) {
      await this.resolveTrackedVariables(session, [trimmed]);
    }
    this.persist();
    this.scheduleSync(true);
    if (session) {
      void this.refreshPreviewValues(session, [trimmed]);
      void this.ensureRealtimeRunning(session);
    }
  }

  async removeVariable(name: string): Promise<void> {
    const trimmed = name.trim();
    this.state.variableNames = this.state.variableNames.filter((v) => v !== trimmed);
    this.state.trackedVariables = this.state.trackedVariables.filter((v) => v !== trimmed);
    for (const key of [...this.latestPreviewValues.keys()]) {
      if (key === trimmed || key.startsWith(`${trimmed}.`)) {
        this.latestPreviewValues.delete(key);
      }
    }
    this.dataBuffer.removeChannel(trimmed);
    this.liveWatchService.removeResolvedEntriesByPrefix(trimmed);
    this.persist();
    this.scheduleSync(true);
  }

  async setTracked(name: string, checked: boolean): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    const tracked = new Set(this.state.trackedVariables);
    if (checked) {
      tracked.add(trimmed);
    } else {
      tracked.delete(trimmed);
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
      liveWatchFrequency: clampInt(update.liveWatchFrequency ?? this.state.liveWatchFrequency, 1, 2000, 50),
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
    this.state.liveWatchFrequency = clampInt(hz, 1, 10000, 50);
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

    if (this.liveWatchService.isRunning.value) {
      this.suppressAutoLiveUntilNextSession = true;
      await this.stopLiveWatch();
    } else {
      this.suppressAutoLiveUntilNextSession = false;
      await this.startLiveWatch();
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
              const trackedNow = [...this.state.trackedVariables];
              void this.resolveTrackedVariables(session, trackedNow)
                .then(async () => {
                  await this.refreshPreviewValues(session, [...this.state.trackedVariables]);
                  await this.ensureRealtimeRunning(session);
                });
              if (this.passiveCollector.recording) {
                void this.passiveCollector
                  .collectFromSession(session, trackedNow)
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
    const elfPath = this.getElfPathFromSession(session);
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

  private getElfPathFromSession(session: vscode.DebugSession): string | undefined {
    const cfg = session.configuration as Record<string, unknown>;
    const candidates = [cfg.program, cfg.executable, cfg.elf];
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }
    return undefined;
  }

  private async startLiveWatch(): Promise<void> {
    const session = this.currentDebugSession ?? vscode.debug.activeDebugSession;
    const tracked = [...new Set(this.state.trackedVariables)];
    if (!tracked.length) {
      void vscode.window.showWarningMessage('Please select variables first.');
      return;
    }

    const telnetPort = this.state.telnetPort;

    const resolvedCount = session
      ? await this.resolveTrackedVariables(session, tracked)
      : (this.liveWatchService.elfResolver.isLoaded()
        ? await this.liveWatchService.resolveFromElf(this.liveWatchService.elfResolver.lastElfPath ?? '', tracked)
        : 0);

    if (resolvedCount === 0) {
      void vscode.window.showWarningMessage('Failed to resolve variables. Pause the debugger once and try again.');
      return;
    }

    await this.liveWatchService.startLiveWatch(telnetPort, this.state.liveWatchFrequency);
    if (!this.liveWatchService.isRunning.value) {
      void vscode.window.showErrorMessage(this.liveWatchService.lastError ?? 'Live Watch failed to start.');
      return;
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

  /**
   * 扫描 watchEntries，将所有尚未登记的展开结构体成员加入 variableNames / trackedVariables，
   * 同时移除已被展开的父变量（不再有直接条目的原始名称）。
   */
  private absorbExpandedMembers(): void {
    const allResolved = this.liveWatchService.getResolvedEntries();
    const resolvedNames = new Set(Object.keys(allResolved));
    // 找出已被展开的父变量（在 state 中但不在 resolved 中的名称，且有子成员）
    const expandedParents = new Set<string>();
    for (const name of this.state.trackedVariables) {
      if (resolvedNames.has(name)) {
        continue;
      }
      // 检查是否有子成员（name. 开头的条目）
      for (const key of resolvedNames) {
        if (key.startsWith(name + '.')) {
          expandedParents.add(name);
          break;
        }
      }
    }
    // 添加展开的子成员
    const added = new Set<string>();
    for (const name of resolvedNames) {
      if (!name.includes('.')) {
        continue;
      }
      added.add(name);
      if (!this.state.variableNames.includes(name)) {
        this.state.variableNames.push(name);
      }
      if (!this.state.trackedVariables.includes(name)) {
        this.state.trackedVariables.push(name);
      }
    }
    // 移除已被展开的父变量
    for (const parent of expandedParents) {
      this.state.variableNames = this.state.variableNames.filter((v) => v !== parent);
      this.state.trackedVariables = this.state.trackedVariables.filter((v) => v !== parent);
    }
  }

  /** 根据 variableNames + resolvedEntries 构建变量树行列表 */
  private buildTreeRows(): TreeViewRow[] {
    const resolved = this.liveWatchService.getResolvedEntries();
    const expandedSet = new Set(this.state.expandedNodes);

    // 收集所有节点名（包括从点分名称中提取的父级前缀）
    const allNodes = new Set<string>();
    for (const name of this.state.variableNames) {
      allNodes.add(name);
      let dot = name.indexOf('.');
      while (dot > 0) {
        allNodes.add(name.substring(0, dot));
        dot = name.indexOf('.', dot + 1);
      }
    }

    // 构建直接子节点映射
    const children = new Map<string, string[]>();
    const hasChildren = new Set<string>();
    for (const node of allNodes) {
      const prefix = node + '.';
      const direct: string[] = [];
      for (const other of allNodes) {
        if (other === node || !other.startsWith(prefix)) {
          continue;
        }
        const rest = other.substring(prefix.length);
        if (!rest.includes('.')) {
          direct.push(other);
        }
      }
      if (direct.length > 0) {
        direct.sort();
        children.set(node, direct);
        hasChildren.add(node);
      }
    }

    const roots = [...allNodes].filter((n) => !n.includes('.')).sort();
    const rows: TreeViewRow[] = [];

    const walk = (names: string[], depth: number) => {
      for (const name of names) {
        const entry = resolved[name];
        const displayName = name.includes('.') ? name.substring(name.lastIndexOf('.') + 1) : name;
        const nodeHasChildren = hasChildren.has(name);
        const channel = this.dataBuffer.getChannels().find((c) => c.name === name);
        const latest = channel && channel.size > 0 ? channel.get(channel.size - 1) : undefined;
        const valueText = this.getDisplayValueText(name, latest, entry?.dataType);
        rows.push({
          name,
          displayName,
          depth,
          valueText,
          dataType: entry?.dataType?.toLowerCase() ?? '',
          address: entry ? `0x${entry.address.toString(16)}` : '',
          hasChildren: nodeHasChildren,
          expanded: expandedSet.has(name)
        });
        if (nodeHasChildren && expandedSet.has(name)) {
          walk(children.get(name)!, depth + 1);
        }
      }
    };

    walk(roots, 0);
    return rows;
  }

  private rebuildBufferFromState(): void {
    for (const name of this.state.variableNames) {
      this.dataBuffer.addChannel(name);
    }
    for (const [name, value] of Object.entries(this.state.resolvedAddresses ?? {})) {
      const m = value.match(/^0x([0-9a-fA-F]+):(\w+)$/);
      if (!m) {
        continue;
      }
      this.liveWatchService.hydrateResolvedEntries({ [name]: value });
    }
    for (const name of this.state.trackedVariables) {
      if (!this.state.variableNames.includes(name)) {
        this.state.variableNames.push(name);
      }
    }
  }

  private async loadState(): Promise<void> {
    const saved = this.context.workspaceState.get<PersistedState>(this.stateKey);
    this.state = { ...structuredClone(DEFAULT_STATE), ...(saved ?? {}) };
  }

  private async refreshPreviewValues(
    session: vscode.DebugSession,
    trackedVariables: string[]
  ): Promise<void> {
    const values = await this.passiveCollector.readCurrentValues(session, trackedVariables);
    for (const [name, value] of values.entries()) {
      this.latestPreviewValues.set(name, value);
    }
    if (values.size > 0) {
      this.scheduleSync(true);
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

    let resolvedCount = 0;
    if (this.liveWatchService.elfResolver.isLoaded()) {
      resolvedCount += await this.liveWatchService.resolveFromElf(
        this.liveWatchService.elfResolver.lastElfPath ?? '',
        names
      );
    }

    const unresolved = names.filter((name) => !this.liveWatchService.getResolvedEntries()[name]);
    if (unresolved.length > 0) {
      resolvedCount += await this.liveWatchService.resolveVariables(session, unresolved, this.currentStoppedThreadId);
    }

    await this.liveWatchService.refineResolvedTypes(session, names, this.currentStoppedThreadId);
    this.absorbExpandedMembers();
    this.persist();

    const resolvedEntries = this.liveWatchService.getResolvedEntries();
    return names.filter((name) =>
      !!resolvedEntries[name] || Object.keys(resolvedEntries).some((entryName) => entryName.startsWith(`${name}.`))
    ).length;
  }

  private async ensureRealtimeRunning(session?: vscode.DebugSession): Promise<void> {
    if (this.suppressAutoLiveUntilNextSession) {
      return;
    }

    const activeSession = session ?? this.currentDebugSession ?? vscode.debug.activeDebugSession;
    if (!activeSession) {
      return;
    }

    const tracked = [...new Set(this.state.trackedVariables.map((name) => name.trim()).filter(Boolean))];
    if (tracked.length === 0) {
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

  private async pushState(): Promise<void> {
    const channels = this.dataBuffer.getChannels();
    const channelSignature = channels.map((c) => c.name).join('\u0001');
    const dataVersionChanged = this.dataBuffer.version !== this.lastPushedDataVersion;
    const structureChanged = channelSignature !== this.lastPushedChannelSignature;
    const canAppend =
      this.viewProvider.hasView() &&
      dataVersionChanged &&
      !structureChanged &&
      this.dataBuffer.tsSize > 0;

    if (canAppend) {
      const append = this.buildAppendState();
      if (append && append.timestampsSec.length > 0) {
        const viewState = this.buildViewState(channels, false);
        this.viewProvider.postState(viewState);
        this.viewProvider.postAppend(append);
        this.lastPushedDataVersion = this.dataBuffer.version;
        this.lastPushedChannelSignature = channelSignature;
        this.lastPushedTotalSamples = append.totalSamples;
        return;
      }
    }

    const includeData = dataVersionChanged || structureChanged;
    const viewState = this.buildViewState(channels, includeData);
    this.viewProvider.postState(viewState);

    if (includeData) {
      this.lastPushedDataVersion = this.dataBuffer.version;
      this.lastPushedChannelSignature = channelSignature;
      this.lastPushedTotalSamples = this.dataBuffer.totalSamples;
    }
  }

  private buildViewState(
    channels: ReturnType<DataBuffer['getChannels']>,
    includeData: boolean
  ): WaveformViewState {
    const variables = this.state.variableNames.map((name) => {
      const ch = channels.find((c) => c.name === name);
      const entry = this.liveWatchService.getResolvedEntries()[name];
      const valueText = this.getDisplayValueText(name, ch?.size ? ch.get(ch.size - 1) : undefined, entry?.dataType);
      return {
        name,
        checked: this.state.trackedVariables.includes(name),
        valueText,
        color: ch?.color ?? '#ccc'
      };
    });

    const liveRunning = this.state.dataSource === 'RTT'
      ? this.rttService.isRunning.value
      : this.liveWatchService.isRunning.value;

    return {
      bufferCapacity: this.dataBuffer.capacity,
      variables,
      data: includeData ? this.dataBuffer.snapshot() : undefined,
      treeVariables: this.buildTreeRows(),
      status: this.buildStatusText(),
      sessionStatus: this.currentDebugSession ? 'Debug session active' : 'No debug session',
      liveStatus: this.buildLiveStatusText(),
      recording: this.passiveCollector.recording,
      liveRunning,
      dataSource: this.state.dataSource,
      frequencyHz: this.state.liveWatchFrequency,
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
      return formatCompactValue(latestBuffered, dataType);
    }
    const preview = this.latestPreviewValues.get(name);
    if (preview !== undefined && Number.isFinite(preview)) {
      return formatCompactValue(preview, dataType);
    }
    return '';
  }

  private buildAppendState(): WaveformAppendState | undefined {
    const append = this.dataBuffer.appendSnapshotSince(this.lastPushedTotalSamples);
    if (!append) {
      return undefined;
    }
    return append;
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
      return this.rttService.lastError
        ? 'RTT: error'
        : `RTT: tcp:${this.state.rttPort} (${this.rttService.sampleCount})`;
    }
    if (!this.liveWatchService.isRunning.value) {
      return '';
    }
    const endpointLabel = this.liveWatchService.getLiveEndpointLabel() || `port:${this.state.telnetPort}`;
    return this.liveWatchService.lastError
      ? 'Live: error'
      : `Live: ${endpointLabel}@${this.state.liveWatchFrequency}Hz (${this.liveWatchService.sampleCount})`;
  }
}

function csvField(s: string): string {
  return /[,"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) {
    return 'N/A';
  }
  if (v === 0) {
    return '0';
  }
  const abs = Math.abs(v);
  if (abs >= 1000) {
    return v.toFixed(0);
  }
  if (abs >= 1) {
    return v.toFixed(2);
  }
  if (abs >= 0.01) {
    return v.toFixed(4);
  }
  return v.toExponential(2);
}

function formatCompactValue(v: number, dataType?: string): string {
  if (!Number.isFinite(v)) {
    return 'NaN';
  }
  const prefix = dataType ? `(${dataType.toLowerCase()}) ` : '';
  const abs = Math.abs(v);
  const body = abs >= 10000 ? v.toFixed(0) : abs >= 1 ? v.toFixed(3) : abs >= 0.001 ? v.toFixed(5) : v.toExponential(2);
  return `${prefix}${body}`;
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
