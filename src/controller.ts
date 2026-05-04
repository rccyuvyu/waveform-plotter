import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { DataBuffer } from './core/dataBuffer';
import { DEFAULT_STATE, PersistedState } from './core/types';
import { LiveWatchService } from './services/liveWatchService';
import { PassiveCollector } from './services/passiveCollector';
import { RttService } from './services/rttService';
import { OpenOcdPortDetector } from './services/openocdPortDetector';
import { WaveformViewProvider, WaveformViewState } from './ui/panel';

export class WaveformController implements vscode.Disposable {
  private readonly stateKey = 'waveformPlotter.state';
  private state: PersistedState = structuredClone(DEFAULT_STATE);
  private readonly dataBuffer: DataBuffer;
  private readonly passiveCollector: PassiveCollector;
  private readonly liveWatchService: LiveWatchService;
  private readonly rttService: RttService;
  private readonly openOcdPortDetector = new OpenOcdPortDetector();
  private currentDebugSession: vscode.DebugSession | undefined;
  private currentStoppedThreadId: number | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private syncTimer: NodeJS.Timeout | undefined;
  private autoLoadedSessions = new Set<string>();
  private lastPushedDataVersion = -1;
  private lastPushedChannelSignature = '';

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
      this.dataBuffer.addChannel(trimmed);
    }
    await this.setTracked(trimmed, checked);
    this.persist();
    this.scheduleSync(true);
  }

  async removeVariable(name: string): Promise<void> {
    const trimmed = name.trim();
    this.state.variableNames = this.state.variableNames.filter((v) => v !== trimmed);
    this.state.trackedVariables = this.state.trackedVariables.filter((v) => v !== trimmed);
    this.dataBuffer.removeChannel(trimmed);
    this.liveWatchService.clearResolvedEntries();
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
      refreshFps: update.refreshFps === 60 ? 60 : 30
    };
    this.persist();
    this.scheduleSync(true);
  }

  async setFrequency(hz: number): Promise<void> {
    this.state.liveWatchFrequency = clampInt(hz, 1, 2000, 50);
    this.persist();
    this.scheduleSync(true);
  }

  async toggleLive(): Promise<void> {
    if (this.state.dataSource === 'RTT') {
      if (this.rttService.isRunning.value) {
        await this.stopRtt();
      } else {
        await this.startRtt();
      }
      return;
    }

    if (this.liveWatchService.isRunning.value) {
      await this.stopLiveWatch();
    } else {
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
          refreshFps: Number(message.refreshFps) === 60 ? 60 : 30
        });
        return;
      case 'openSettings':
        this.scheduleSync(true);
        return;
      case 'refresh':
        this.scheduleSync(true);
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
        void this.tryAutoLoadElf(session);
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
              if (this.liveWatchService.isRunning.value) {
                void this.liveWatchService.refineResolvedTypes(
                  session,
                  [...this.state.trackedVariables],
                  this.currentStoppedThreadId
                );
              }
              if (this.passiveCollector.recording) {
                void this.passiveCollector
                  .collectFromSession(session, [...this.state.trackedVariables])
                  .then(() => this.scheduleSync(true));
              }
            }
            if (message?.event === 'continued') {
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

    const telnetPort = await this.resolveOpenOcdTelnetPort(session);
    if (!telnetPort) {
      void vscode.window.showErrorMessage('Unable to find OpenOCD Telnet port automatically. Please check OpenOCD and debug config.');
      return;
    }

    if (session) {
      await this.tryAutoLoadElf(session);
    }
    const elfResolved = this.liveWatchService.elfResolver.isLoaded()
      ? await this.liveWatchService.resolveFromElf(this.liveWatchService.elfResolver.lastElfPath ?? '', tracked)
      : 0;

    const unresolved = tracked.filter((name) => !this.liveWatchService.getResolvedEntries()[name]);
    let gdbResolved = 0;
    if (unresolved.length && session) {
      gdbResolved = await this.liveWatchService.resolveVariables(session, unresolved, this.currentStoppedThreadId);
    }

    if (elfResolved + gdbResolved === 0) {
      void vscode.window.showWarningMessage('Failed to resolve variables. Pause the debugger once and try again.');
      return;
    }

    if (session) {
      await this.liveWatchService.refineResolvedTypes(session, tracked, this.currentStoppedThreadId);
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
      const session = this.currentDebugSession ?? vscode.debug.activeDebugSession;
      const telnetPort = await this.resolveOpenOcdTelnetPort(session);
      if (!telnetPort) {
        void vscode.window.showErrorMessage('Unable to find OpenOCD Telnet port automatically. RTT auto-init requires OpenOCD Telnet.');
        this.scheduleSync(true);
        return;
      }
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

  private async resolveOpenOcdTelnetPort(session?: vscode.DebugSession): Promise<number | undefined> {
    const hintPorts = this.collectOpenOcdPortHints(session);
    const detected = await this.openOcdPortDetector.findTelnetPort(this.state.telnetPort, hintPorts);
    if (!detected) {
      return undefined;
    }
    if (detected !== this.state.telnetPort) {
      this.state.telnetPort = detected;
      this.persist();
      void vscode.window.showInformationMessage(`Waveform Plotter: auto-detected OpenOCD Telnet port ${detected}.`);
    }
    return detected;
  }

  private collectOpenOcdPortHints(session?: vscode.DebugSession): number[] {
    if (!session) {
      return [];
    }
    const cfg = session.configuration as Record<string, unknown>;
    const hints = new Set<number>();
    const gdbPorts = new Set<number>();
    const tclPorts = new Set<number>();

    const addIfPort = (p: number): void => {
      if (Number.isInteger(p) && p >= 1 && p <= 65535) {
        hints.add(p);
      }
    };

    const addGdbPort = (p: number): void => {
      if (Number.isInteger(p) && p >= 1 && p <= 65535) {
        gdbPorts.add(p);
      }
    };

    const addTclPort = (p: number): void => {
      if (Number.isInteger(p) && p >= 1 && p <= 65535) {
        tclPorts.add(p);
      }
    };

    const parsePortLike = (value: unknown): number | undefined => {
      if (typeof value === 'number' && Number.isInteger(value)) {
        return value;
      }
      if (typeof value === 'string') {
        const n = Number.parseInt(value.trim(), 10);
        if (Number.isInteger(n)) {
          return n;
        }
      }
      return undefined;
    };

    // Direct keys: 仅将 telnet 端口直接加入候选；gdb/tcl 只用于推导
    const directTelnetKeys = ['telnetPort', 'openocdTelnetPort', 'openOcdTelnetPort'];
    for (const key of directTelnetKeys) {
      const p = parsePortLike(cfg[key]);
      if (p !== undefined) {
        addIfPort(p);
      }
    }
    const directGdbKeys = ['gdbPort', 'gdbport', 'gdbTargetPort'];
    for (const key of directGdbKeys) {
      const p = parsePortLike(cfg[key]);
      if (p !== undefined) {
        addGdbPort(p);
      }
    }
    const directTclKeys = ['tclPort', 'openocdTclPort', 'openOcdTclPort'];
    for (const key of directTclKeys) {
      const p = parsePortLike(cfg[key]);
      if (p !== undefined) {
        addTclPort(p);
      }
    }

    const extractPorts = (text: string, keyPattern: RegExp, consumer: (p: number) => void): void => {
      let m: RegExpExecArray | null;
      while ((m = keyPattern.exec(text)) !== null) {
        const p = Number.parseInt(m[1], 10);
        if (Number.isInteger(p) && p >= 1 && p <= 65535) {
          consumer(p);
        }
      }
    };

    const extractFromText = (text: string): void => {
      extractPorts(text, /telnet[_ -]?port[^0-9]{0,8}(\d{2,5})/gi, (p) => addIfPort(p));
      extractPorts(text, /gdb[_ -]?port[^0-9]{0,8}(\d{2,5})/gi, (p) => {
        addGdbPort(p);
      });
      extractPorts(text, /tcl[_ -]?port[^0-9]{0,8}(\d{2,5})/gi, (p) => {
        addTclPort(p);
      });
    };

    const pushAny = (value: unknown): void => {
      if (value === null || value === undefined) {
        return;
      }
      if (typeof value === 'string') {
        extractFromText(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          pushAny(item);
        }
        return;
      }
      if (typeof value === 'object') {
        for (const v of Object.values(value as Record<string, unknown>)) {
          pushAny(v);
        }
      }
    };

    pushAny(cfg);
    // Cortex-Debug 常见映射: gdb/tcl/telnet 连续端口
    for (const p of gdbPorts) {
      addIfPort(p + 2);
    }
    for (const p of tclPorts) {
      addIfPort(p + 1);
    }

    return [...hints].filter((p) => p >= 1 && p <= 65535);
  }

  private async stopRtt(): Promise<void> {
    await this.rttService.stopRtt();
    if (this.state.rttAutoInit) {
      await this.rttService.stopOpenOcdRtt(this.state.telnetPort);
    }
    this.scheduleSync(true);
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

  private persist(): void {
    this.state.resolvedAddresses = this.liveWatchService.dumpResolvedEntries();
    void this.context.workspaceState.update(this.stateKey, this.state);
  }

  private scheduleSync(immediate = false): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
    }
    if (immediate) {
      void this.pushState();
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
    const includeData =
      this.dataBuffer.version !== this.lastPushedDataVersion ||
      channelSignature !== this.lastPushedChannelSignature;

    const viewState = this.buildViewState(channels, includeData);
    this.viewProvider.postState(viewState);

    if (includeData) {
      this.lastPushedDataVersion = this.dataBuffer.version;
      this.lastPushedChannelSignature = channelSignature;
    }
  }

  private buildViewState(
    channels: ReturnType<DataBuffer['getChannels']>,
    includeData: boolean
  ): WaveformViewState {
    const variables = this.state.variableNames.map((name) => {
      const ch = channels.find((c) => c.name === name);
      const entry = this.liveWatchService.getResolvedEntries()[name];
      const valueText = ch && ch.size > 0 ? formatCompactValue(ch.get(ch.size - 1), entry?.dataType) : '';
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
      variables,
      data: includeData ? this.dataBuffer.snapshot() : undefined,
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
      return this.rttService.lastError ? `RTT: error` : `RTT: tcp:${this.state.rttPort} (${this.rttService.sampleCount})`;
    }
    if (!this.liveWatchService.isRunning.value) {
      return '';
    }
    return this.liveWatchService.lastError
      ? 'Live: error'
      : `Live: telnet:${this.state.telnetPort}@${this.state.liveWatchFrequency}Hz (${this.liveWatchService.sampleCount})`;
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
