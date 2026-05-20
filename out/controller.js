"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WaveformController = void 0;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const dataBuffer_1 = require("./core/dataBuffer");
const types_1 = require("./core/types");
const liveWatchService_1 = require("./services/liveWatchService");
const passiveCollector_1 = require("./services/passiveCollector");
const rttService_1 = require("./services/rttService");
const logger_1 = require("./services/logger");
class WaveformController {
    constructor(context, viewProvider) {
        this.context = context;
        this.viewProvider = viewProvider;
        this.stateKey = 'waveformPlotter.state';
        this.state = structuredClone(types_1.DEFAULT_STATE);
        this.disposables = [];
        this.autoLoadedSessions = new Set();
        this.latestPreviewValues = new Map();
        this.lastPushedDataVersion = -1;
        this.lastPushedChannelSignature = '';
        this.lastPushedTotalSamples = 0;
        this.persistTask = Promise.resolve();
        this.suppressAutoLiveUntilNextSession = true;
        this.elfWorkspacePromise = null;
        this.dataBuffer = new dataBuffer_1.DataBuffer(vscode.workspace.getConfiguration('waveformPlotter').get('maxChannels', 8), vscode.workspace.getConfiguration('waveformPlotter').get('bufferSize', 10000));
        this.passiveCollector = new passiveCollector_1.PassiveCollector(this.dataBuffer);
        this.liveWatchService = new liveWatchService_1.LiveWatchService(this.dataBuffer, () => this.scheduleSync());
        this.rttService = new rttService_1.RttService(this.dataBuffer, () => this.scheduleSync());
        this.viewProvider.setMessageHandler((message) => {
            void this.handleMessage(message);
        });
    }
    async initialize() {
        (0, logger_1.log)('Controller initializing...');
        await this.loadState();
        this.registerListeners();
        this.rebuildBufferFromState();
        if (vscode.debug.activeDebugSession) {
            this.currentDebugSession = vscode.debug.activeDebugSession;
            (0, logger_1.log)(`Active debug session found: ${this.currentDebugSession.name}`);
            void this.ensureRealtimeRunning(vscode.debug.activeDebugSession);
        }
        (0, logger_1.log)(`State loaded: ${this.state.variableNames.length} variables, ${this.state.trackedVariables.length} tracked`);
        // 即使没有 debug session，也尝试从工作区自动加载 ELF，便于后续脱机解析变量
        void this.tryAutoLoadElfFromWorkspace();
        this.scheduleSync(true);
        (0, logger_1.log)('Controller initialized');
    }
    dispose() {
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
    async openView() {
        await this.viewProvider.reveal();
        this.scheduleSync(true);
    }
    async addVariable(name, checked = true) {
        const trimmed = name.trim();
        if (!trimmed) {
            return;
        }
        const wasPresent = this.state.variableNames.includes(trimmed);
        if (!wasPresent) {
            this.state.variableNames.push(trimmed);
        }
        this.persist();
        (0, logger_1.log)(`addVariable: "${trimmed}" (checked=${checked}, wasPresent=${wasPresent})`);
        const session = this.currentDebugSession ?? vscode.debug.activeDebugSession;
        if (session) {
            try {
                await this.resolveTrackedVariables(session, [trimmed]);
            }
            catch (err) {
                console.warn(`[waveform-plotter] Failed to resolve "${trimmed}" while adding`, err);
            }
        }
        else {
            // 无 debug session 时尝试自动加载 ELF 并解析
            try {
                if (!this.liveWatchService.elfResolver.isLoaded()) {
                    await this.tryAutoLoadElfFromWorkspace();
                }
                if (this.liveWatchService.elfResolver.isLoaded()) {
                    const elfPath = this.liveWatchService.elfResolver.lastElfPath;
                    if (elfPath) {
                        (0, logger_1.log)(`Resolving "${trimmed}" from ELF: ${elfPath}`);
                        await this.resolveTrackedFromElf(elfPath, [trimmed]);
                    }
                    else {
                        (0, logger_1.warn)(`ELF loaded but no path available for "${trimmed}"`);
                    }
                }
                else {
                    (0, logger_1.warn)(`ELF not loaded, cannot resolve "${trimmed}"`);
                }
            }
            catch (err) {
                (0, logger_1.error)(`Failed to resolve "${trimmed}" from ELF`, err);
            }
        }
        // resolve 后才确认是否是复合类型，避免给复合根节点自动勾选
        const hasCompositeChildren = this.getTrackTargetNames(trimmed).some((target) => target !== trimmed);
        (0, logger_1.log)(`addVariable: "${trimmed}" hasCompositeChildren=${hasCompositeChildren}`);
        if (checked && !hasCompositeChildren) {
            await this.setTracked(trimmed, true);
        }
        const resolved = this.liveWatchService.getResolvedEntries();
        const leafNodes = this.liveWatchService.getKnownLeafNodes();
        (0, logger_1.log)(`addVariable: after resolve, ${Object.keys(resolved).length} entries, ${leafNodes.length} leaf nodes`);
        if (session) {
            void this.refreshPreviewValues(session, this.getAllLeafNodeNames()).catch((err) => {
                (0, logger_1.error)(`Failed to refresh preview for "${trimmed}"`, err);
            });
            // 不自动启动 Live Watch（用户需显式点击 Live 按钮），避免变量添加时触发 OpenOCD 连接导致卡顿
        }
        // 统一在 resolve 完成后推状态，避免首帧出现可勾选的复合根节点
        this.scheduleSync(true);
    }
    async removeVariable(name) {
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
    async setTracked(name, checked) {
        const trimmed = name.trim();
        if (!trimmed) {
            return;
        }
        const tracked = new Set(this.state.trackedVariables);
        const targets = this.getTrackTargetNames(trimmed);
        const failedTargets = [];
        for (const target of targets) {
            if (checked) {
                if (this.dataBuffer.getChannels().some((c) => c.name === target)) {
                    tracked.add(target);
                    continue;
                }
                const channel = this.dataBuffer.addChannel(target);
                if (channel) {
                    tracked.add(target);
                }
                else {
                    failedTargets.push(target);
                }
            }
            else {
                tracked.delete(target);
            }
        }
        if (failedTargets.length > 0) {
            const first = failedTargets[0];
            const more = failedTargets.length > 1 ? ` and ${failedTargets.length - 1} more` : '';
            void vscode.window.showWarningMessage(`Variable "${first}"${more} cannot be plotted because the channel limit (${this.dataBuffer.maxChannels}) has been reached.`);
        }
        this.state.trackedVariables = [...tracked];
        this.persist();
        this.scheduleSync(true);
    }
    async editVariable(name, valueStr) {
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
    toggleExpandNode(name) {
        const set = new Set(this.state.expandedNodes);
        if (set.has(name)) {
            set.delete(name);
        }
        else {
            set.add(name);
        }
        this.state.expandedNodes = [...set];
        this.persist();
        this.scheduleSync(true);
    }
    async startRecording() {
        this.passiveCollector.recording = true;
        this.persist();
        this.scheduleSync(true);
    }
    async stopRecording() {
        this.passiveCollector.recording = false;
        this.persist();
        this.scheduleSync(true);
    }
    async clearAll() {
        this.dataBuffer.clearAll();
        this.passiveCollector.resetSampleCount();
        this.liveWatchService.clearResolvedEntries();
        this.latestPreviewValues.clear();
        this.scheduleSync(true);
    }
    async exportCsv() {
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
        const lines = [];
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
    async setDisplayMode(mode) {
        this.state.displayMode = mode;
        this.persist();
        this.scheduleSync(true);
    }
    async setTimeUnit(unit) {
        this.state.timeUnit = unit;
        this.persist();
        this.scheduleSync(true);
    }
    async setDataSource(source) {
        this.state.dataSource = source;
        this.persist();
        this.scheduleSync(true);
    }
    async updateSettings(update) {
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
    async setFrequency(hz) {
        this.state.liveWatchFrequency = clampInt(hz, 1, 10000, 50);
        this.persist();
        this.scheduleSync(true);
    }
    async toggleLive() {
        if (this.state.dataSource === 'RTT') {
            if (this.rttService.isRunning.value) {
                this.suppressAutoLiveUntilNextSession = true;
                await this.stopRtt();
            }
            else {
                this.suppressAutoLiveUntilNextSession = false;
                await this.startRtt();
            }
            return;
        }
        if (this.liveWatchService.isRunning.value) {
            this.suppressAutoLiveUntilNextSession = true;
            await this.stopLiveWatch();
        }
        else {
            this.suppressAutoLiveUntilNextSession = false;
            await this.startLiveWatch();
        }
    }
    async stopAllLive() {
        await this.stopLiveWatch();
        await this.stopRtt();
    }
    async handleMessage(message) {
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
    registerListeners() {
        this.disposables.push(vscode.debug.onDidStartDebugSession((session) => {
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
        }));
        this.disposables.push(vscode.debug.onDidTerminateDebugSession((session) => {
            if (this.currentDebugSession?.id === session.id) {
                this.currentDebugSession = undefined;
                this.currentStoppedThreadId = undefined;
            }
            void this.stopLiveWatch();
            this.scheduleSync(true);
        }));
        this.disposables.push(vscode.debug.registerDebugAdapterTrackerFactory('*', {
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
        }));
    }
    async tryAutoLoadElf(session) {
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
    async tryAutoLoadElfFromWorkspace() {
        if (this.liveWatchService.elfResolver.isLoaded()) {
            return;
        }
        if (!this.elfWorkspacePromise) {
            this.elfWorkspacePromise = this.loadElfFromWorkspace();
        }
        await this.elfWorkspacePromise;
    }
    async loadElfFromWorkspace() {
        const elfPath = await this.detectElfFromWorkspace();
        if (!elfPath) {
            (0, logger_1.warn)('No ELF file found in workspace');
            return;
        }
        (0, logger_1.log)(`Loading ELF from workspace: ${elfPath}`);
        const loaded = await this.liveWatchService.elfResolver.loadSymbols(elfPath);
        (0, logger_1.log)(`ELF loaded: ${loaded}, symbols: ${this.liveWatchService.elfResolver.getSymbolCount()}`);
    }
    async getElfPathFromSession(session) {
        const cfg = session.configuration;
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
    resolveWorkspacePath(rawPath, workspaceFolder) {
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
    async detectElfFromLaunchConfigs() {
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const candidates = new Set();
        for (const workspaceFolder of workspaceFolders) {
            const launchConfig = vscode.workspace.getConfiguration('launch', workspaceFolder.uri);
            const configurations = launchConfig.get('configurations', []);
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
    async detectElfFromWorkspace() {
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
        const candidates = new Set();
        for (const pattern of patterns) {
            const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 10);
            for (const uri of uris) {
                candidates.add(uri.fsPath);
            }
            if (candidates.size > 1) {
                break;
            }
        }
        if (candidates.size === 0) {
            return undefined;
        }
        if (candidates.size > 1) {
            console.warn(`[waveform-plotter] Found multiple ELF files. Set waveformPlotter.elfPath to specify the correct one:`, [...candidates]);
            return undefined;
        }
        return [...candidates][0];
    }
    getConfiguredElfPath() {
        const raw = vscode.workspace.getConfiguration('waveformPlotter').get('elfPath', '').trim();
        if (!raw) {
            return undefined;
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        const resolved = raw.replace(/\$\{workspaceFolder\}/g, folder?.uri.fsPath ?? '')
            .replace(/\$\{workspaceRoot\}/g, folder?.uri.fsPath ?? '');
        try {
            const fsSync = require('fs');
            if (fsSync.statSync(resolved).isFile()) {
                return resolved;
            }
            console.warn(`[waveform-plotter] Configured elfPath "${resolved}" is not a file.`);
            return undefined;
        }
        catch {
            console.warn(`[waveform-plotter] Configured elfPath "${resolved}" cannot be accessed.`);
            return undefined;
        }
    }
    async startLiveWatch() {
        const session = this.currentDebugSession ?? vscode.debug.activeDebugSession;
        const tracked = [...new Set(this.state.trackedVariables)];
        const resolveTargets = [...new Set([...this.state.variableNames, ...tracked])];
        if (!resolveTargets.length) {
            void vscode.window.showWarningMessage('Please select variables first.');
            return;
        }
        const telnetPort = this.state.telnetPort;
        (0, logger_1.log)(`startLiveWatch: ${resolveTargets.length} targets, telnetPort=${telnetPort}, freq=${this.state.liveWatchFrequency}Hz`);
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
            (0, logger_1.log)(`startLiveWatch: ${Object.keys(resolvedEntries).length} already resolved, ${needsResolution.length} need resolution`);
            if (needsResolution.length > 0) {
                if (session) {
                    (0, logger_1.log)(`Resolving ${needsResolution.length} vars via debug session`);
                    await this.resolveTrackedVariables(session, needsResolution);
                }
                else {
                    // 无 debug session 时尝试自动加载 ELF
                    if (!this.liveWatchService.elfResolver.isLoaded()) {
                        await this.tryAutoLoadElfFromWorkspace();
                    }
                    if (this.liveWatchService.elfResolver.isLoaded()) {
                        (0, logger_1.log)(`Resolving ${needsResolution.length} vars from ELF`);
                        await this.liveWatchService.resolveFromElf(this.liveWatchService.elfResolver.lastElfPath ?? '', needsResolution);
                    }
                    else {
                        (0, logger_1.warn)('Cannot resolve - ELF not loaded');
                    }
                }
            }
            // 检查是否有已解析的条目可以开始采集
            const finalEntries = this.liveWatchService.getResolvedEntries();
            const finalEntryCount = Object.keys(finalEntries).length;
            (0, logger_1.log)(`startLiveWatch: final resolved entries: ${finalEntryCount}`);
            if (finalEntryCount === 0) {
                const elfLoaded = this.liveWatchService.elfResolver.isLoaded();
                const elfPath = this.liveWatchService.elfResolver.lastElfPath;
                const targetNames = resolveTargets.join(', ');
                let msg = `Failed to resolve variables: "${targetNames}".`;
                if (!elfLoaded) {
                    msg += `\nNo ELF file loaded. Set "waveformPlotter.elfPath" in settings to specify the ELF file path, or ensure a .elf file exists in the workspace (searched **/build/**/*.elf, **/Debug/**/*.elf, etc.).`;
                }
                else {
                    msg += `\nELF loaded: ${elfPath}.`;
                    msg += `\nThe variable name may not match any symbol in the ELF. Check the variable name and try again.`;
                }
                (0, logger_1.warn)(msg);
                void vscode.window.showWarningMessage(msg);
                return;
            }
            // Log first few entries for diagnostics
            const entryNames = Object.keys(finalEntries).slice(0, 5);
            for (const name of entryNames) {
                const e = finalEntries[name];
                (0, logger_1.log)(`  Entry: ${name} addr=0x${e.address.toString(16)} type=${e.dataType}`);
            }
            if (session) {
                (0, logger_1.log)(`Starting Live Watch via debug session: ${session.name}`);
                await this.liveWatchService.startLiveWatchViaSession(session, this.state.liveWatchFrequency);
            }
            else {
                await this.liveWatchService.startLiveWatch(telnetPort, this.state.liveWatchFrequency);
            }
            if (!this.liveWatchService.isRunning.value) {
                (0, logger_1.error)(`Live Watch failed: ${this.liveWatchService.lastError ?? 'unknown'}`);
                void vscode.window.showErrorMessage(`Live Watch failed to start.\n` +
                    `Error: ${this.liveWatchService.lastError ?? '(no error details)'}\n` +
                    `Make sure OpenOCD is running and connected to the target device.`);
                return;
            }
            (0, logger_1.log)(`Live Watch started successfully`);
        }
        finally {
            clearTimeout(timer);
            if (stalled) {
                // 如果超时，立即停止 live watch 避免后台残留
                this.liveWatchService.lastError = 'Connection timed out. Check that OpenOCD is running on the target port.';
                await this.liveWatchService.stopLiveWatch();
                (0, logger_1.error)('Live Watch timed out');
                void vscode.window.showErrorMessage('Live Watch failed to start.\n' +
                    'Connection timed out after 12 seconds.\n' +
                    'Make sure OpenOCD is running and the target is connected.');
                return;
            }
        }
        this.state.resolvedAddresses = this.liveWatchService.dumpResolvedEntries();
        this.persist();
        this.scheduleSync(true);
    }
    async stopLiveWatch() {
        await this.liveWatchService.stopLiveWatch();
        this.scheduleSync(true);
    }
    async startRtt() {
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
    async stopRtt() {
        await this.rttService.stopRtt();
        if (this.state.rttAutoInit) {
            await this.rttService.stopOpenOcdRtt(this.state.telnetPort);
        }
        this.scheduleSync(true);
    }
    absorbExpandedMembers() {
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
    buildTreeRows() {
        const resolved = this.liveWatchService.getResolvedEntries();
        const expandedSet = new Set(this.state.expandedNodes);
        const allNodes = new Set();
        for (const name of this.state.variableNames) {
            for (const path of getAncestorPaths(name)) {
                allNodes.add(path);
            }
            const relatedNodes = [
                ...Object.keys(resolved),
                ...this.liveWatchService.getKnownTreeNodes()
            ];
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
        const children = new Map();
        const hasChildren = new Set();
        for (const node of allNodes) {
            const direct = [];
            for (const other of allNodes) {
                if (other !== node && getParentPath(other) === node) {
                    direct.push(other);
                }
            }
            if (direct.length > 0) {
                direct.sort();
                children.set(node, direct);
                hasChildren.add(node);
            }
        }
        const roots = [...allNodes].filter((n) => !getParentPath(n)).sort(compareWatchPaths);
        const rows = [];
        const walk = (names, depth) => {
            for (const name of names) {
                const entry = resolved[name];
                const hintedType = this.liveWatchService.getKnownLeafType(name);
                const declaredTypeText = entry?.declaredTypeText ?? this.liveWatchService.getKnownLeafDeclaredType(name);
                const displayName = getDisplayName(name);
                const nodeHasChildren = hasChildren.has(name);
                const channel = this.dataBuffer.getChannels().find((c) => c.name === name);
                const latest = channel && channel.size > 0 ? channel.get(channel.size - 1) : undefined;
                const valueText = this.getDisplayValueText(name, latest, entry?.dataType ?? hintedType)
                    || this.liveWatchService.getKnownDisplayValue(name)
                    || '';
                const trackTargets = this.getTrackTargetNames(name);
                const trackedCount = trackTargets.filter((target) => this.state.trackedVariables.includes(target)).length;
                let checkState = 'unchecked';
                if (trackedCount === trackTargets.length && trackedCount > 0) {
                    checkState = 'checked';
                }
                else if (trackedCount > 0) {
                    checkState = 'partial';
                }
                rows.push({
                    name,
                    displayName,
                    depth,
                    valueText,
                    dataType: declaredTypeText ?? formatInternalDataType(entry?.dataType ?? hintedType),
                    address: entry ? `0x${entry.address.toString(16)}` : '',
                    hasChildren: nodeHasChildren,
                    expanded: expandedSet.has(name),
                    selectable: depth > 0 && !nodeHasChildren,
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
        return rows;
    }
    rebuildBufferFromState() {
        if (this.state.variableNames.length === 0) {
            this.clearTrackedRuntimeState();
            return;
        }
        for (const name of this.state.trackedVariables) {
            this.dataBuffer.addChannel(name);
        }
        for (const [name, value] of Object.entries(this.state.resolvedAddresses ?? {})) {
            const m = value.match(/^0x([0-9a-fA-F]+):(\w+)$/);
            if (!m) {
                continue;
            }
            this.liveWatchService.hydrateResolvedEntries({ [name]: value });
        }
    }
    async loadState() {
        const saved = this.context.workspaceState.get(this.stateKey);
        this.state = { ...structuredClone(types_1.DEFAULT_STATE), ...(saved ?? {}) };
        this.sanitizeLoadedState();
    }
    /** 收集所有已知叶子节点名称（已解析 + 已知树叶子 + 无子节点的根变量） */
    getAllLeafNodeNames() {
        const resolved = this.liveWatchService.getResolvedEntries();
        const knownLeafs = this.liveWatchService.getKnownLeafNodes();
        const leafSet = new Set();
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
    async refreshPreviewValues(session, names) {
        const values = await this.passiveCollector.readCurrentValues(session, names);
        for (const [name, value] of values.entries()) {
            this.latestPreviewValues.set(name, value);
        }
        if (values.size > 0) {
            this.scheduleSync(true);
        }
    }
    async resolveTrackedVariables(session, variableNames) {
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
            resolvedFromElf = await this.liveWatchService.resolveFromElf(this.liveWatchService.elfResolver.lastElfPath ?? '', names);
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
    async resolveTrackedFromElf(elfPath, names) {
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
    async ensureRealtimeRunning(session) {
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
    persist() {
        this.state.resolvedAddresses = this.liveWatchService.dumpResolvedEntries();
        const snapshot = structuredClone(this.state);
        this.persistTask = this.persistTask
            .catch(() => undefined)
            .then(() => this.context.workspaceState.update(this.stateKey, snapshot));
    }
    scheduleSync(immediate = false) {
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
    async pushState() {
        const channels = this.dataBuffer.getChannels();
        const visibleChannels = this.getVisibleChannels(channels);
        const channelSignature = visibleChannels.map((c) => c.name).join('\u0001');
        const dataVersionChanged = this.dataBuffer.version !== this.lastPushedDataVersion;
        const structureChanged = channelSignature !== this.lastPushedChannelSignature;
        // 记录当前 buffer 状态
        const latestValues = visibleChannels.map((c) => ({
            name: c.name,
            size: c.size,
            latest: c.size > 0 ? c.get(c.size - 1) : undefined
        }));
        const hasValues = latestValues.some((v) => v.latest !== undefined && Number.isFinite(v.latest));
        if (dataVersionChanged && hasValues) {
            (0, logger_1.log)(`pushState: ${channels.length} channels, ver=${this.dataBuffer.version}, ts=${this.dataBuffer.tsSize}, values=[${latestValues.map(v => `${v.name}=${v.latest ?? '?'}`).join(', ')}]`);
        }
        const canAppend = this.viewProvider.hasView() &&
            dataVersionChanged &&
            !structureChanged &&
            this.dataBuffer.tsSize > 0;
        if (canAppend) {
            const append = this.buildAppendState(visibleChannels.map((c) => c.name));
            if (append && append.timestampsSec.length > 0) {
                const viewState = this.buildViewState(channels, false);
                this.viewProvider.postState(viewState);
                this.viewProvider.postAppend(append);
                this.lastPushedDataVersion = this.dataBuffer.version;
                this.lastPushedChannelSignature = channelSignature;
                this.lastPushedTotalSamples = append.totalSamples;
                (0, logger_1.log)(`pushState: append ${append.timestampsSec.length} samples`);
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
    buildViewState(channels, includeData) {
        const visibleChannels = this.getVisibleChannels(channels);
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
        // 记录 tree rows 中的值
        const treeRows = this.buildTreeRows();
        const leafRows = treeRows.filter(r => !r.hasChildren);
        const rowsWithValues = leafRows.filter(r => r.valueText);
        if (rowsWithValues.length > 0) {
            (0, logger_1.log)(`buildViewState: ${leafRows.length} leaf rows, ${rowsWithValues.length} with values: ${rowsWithValues.slice(0, 5).map(r => `${r.name}=${r.valueText}`).join(', ')}`);
        }
        const liveRunning = this.state.dataSource === 'RTT'
            ? this.rttService.isRunning.value
            : this.liveWatchService.isRunning.value;
        return {
            bufferCapacity: this.dataBuffer.capacity,
            variables,
            data: includeData ? this.buildFilteredSnapshot(visibleChannels) : undefined,
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
    getDisplayValueText(name, latestBuffered, dataType) {
        if (latestBuffered !== undefined && Number.isFinite(latestBuffered)) {
            return formatCompactValue(latestBuffered, dataType);
        }
        const preview = this.latestPreviewValues.get(name);
        if (preview !== undefined && Number.isFinite(preview)) {
            return formatCompactValue(preview, dataType);
        }
        return '';
    }
    buildAppendState(visibleNames) {
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
    buildStatusText() {
        const channels = this.dataBuffer.getChannels();
        if (!channels.length) {
            return 'Select variables and start recording to see waveforms';
        }
        const maxPoints = channels.reduce((m, ch) => Math.max(m, ch.size), 0);
        return `#${this.passiveCollector.sampleCount + this.liveWatchService.sampleCount + this.rttService.sampleCount} samples | ${maxPoints} pts`;
    }
    buildLiveStatusText() {
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
    hasResolvedNameOrDescendant(name) {
        const resolvedEntries = this.liveWatchService.getResolvedEntries();
        if (resolvedEntries[name]) {
            return true;
        }
        if (Object.keys(resolvedEntries).some((entryName) => isDescendantPath(entryName, name))) {
            return true;
        }
        return this.liveWatchService.getKnownLeafNodes().some((entryName) => isDescendantPath(entryName, name));
    }
    getTrackTargetNames(name) {
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
    getVisibleChannels(channels) {
        const tracked = new Set(this.state.trackedVariables);
        return channels.filter((channel) => tracked.has(channel.name));
    }
    buildFilteredSnapshot(channels) {
        const full = this.dataBuffer.snapshot();
        return {
            timestampsSec: full.timestampsSec,
            version: full.version,
            channels: full.channels.filter((channel) => channels.some((visible) => visible.name === channel.name))
        };
    }
    pruneInvalidResolvedState() {
        if (this.state.variableNames.length === 0) {
            this.clearTrackedRuntimeState();
            return;
        }
        const validNames = new Set();
        const knownLeafs = new Set(this.liveWatchService.getKnownLeafNodes());
        const resolvedNames = new Set(Object.keys(this.liveWatchService.getResolvedEntries()));
        for (const rootName of this.state.variableNames) {
            const descendants = [...new Set([...knownLeafs, ...resolvedNames])]
                .filter((name) => isDescendantPath(name, rootName));
            if (descendants.length > 0) {
                for (const name of descendants) {
                    validNames.add(name);
                }
            }
            else if (resolvedNames.has(rootName)) {
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
    sanitizeLoadedState() {
        this.state.variableNames = [...new Set(this.state.variableNames.map((name) => name.trim()).filter(Boolean))];
        this.state.trackedVariables = [...new Set(this.state.trackedVariables.map((name) => name.trim()).filter(Boolean))];
        this.state.expandedNodes = [...new Set(this.state.expandedNodes.map((name) => name.trim()).filter(Boolean))];
        if (this.state.variableNames.length === 0) {
            this.state.trackedVariables = [];
            this.state.expandedNodes = [];
            this.state.resolvedAddresses = {};
        }
    }
    clearTrackedRuntimeState() {
        this.state.trackedVariables = [];
        this.state.expandedNodes = [];
        this.state.resolvedAddresses = {};
        this.latestPreviewValues.clear();
        this.liveWatchService.clearResolvedEntries();
        for (const channelName of this.dataBuffer.getChannels().map((c) => c.name)) {
            this.dataBuffer.removeChannel(channelName);
        }
    }
}
exports.WaveformController = WaveformController;
function csvField(s) {
    return /[,"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function splitWatchPath(name) {
    return name.match(/[^.[\]]+|\[[^\]]+\]/g) ?? [];
}
function buildWatchPath(segments) {
    let out = '';
    for (const segment of segments) {
        if (!out) {
            out = segment;
        }
        else if (segment.startsWith('[')) {
            out += segment;
        }
        else {
            out += `.${segment}`;
        }
    }
    return out;
}
function getAncestorPaths(name) {
    const segments = splitWatchPath(name);
    const paths = [];
    for (let i = 1; i <= segments.length; i += 1) {
        paths.push(buildWatchPath(segments.slice(0, i)));
    }
    return paths;
}
function getParentPath(name) {
    const segments = splitWatchPath(name);
    if (segments.length <= 1) {
        return undefined;
    }
    return buildWatchPath(segments.slice(0, -1));
}
function getDisplayName(name) {
    const segments = splitWatchPath(name);
    return segments[segments.length - 1] ?? name;
}
function isDescendantPath(candidate, parent) {
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
function compareWatchPaths(a, b) {
    return a.localeCompare(b, undefined, { numeric: true });
}
function formatCompactValue(v, dataType) {
    if (!Number.isFinite(v)) {
        return 'NaN';
    }
    const prefix = dataType ? `(${dataType.toLowerCase()}) ` : '';
    const abs = Math.abs(v);
    const body = abs >= 10000 ? v.toFixed(0) : abs >= 1 ? v.toFixed(3) : abs >= 0.001 ? v.toFixed(5) : v.toExponential(2);
    return `${prefix}${body}`;
}
function formatInternalDataType(dataType) {
    return dataType ? dataType.toLowerCase() : '';
}
async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
function clamp(v, min, max, fallback) {
    if (!Number.isFinite(v)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, v));
}
function clampInt(v, min, max, fallback) {
    return Math.round(clamp(v, min, max, fallback));
}
function normalizeRefreshFps(v) {
    if (v >= 120) {
        return 120;
    }
    if (v >= 60) {
        return 60;
    }
    return 30;
}
//# sourceMappingURL=controller.js.map