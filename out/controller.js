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
class WaveformController {
    constructor(context, viewProvider) {
        this.context = context;
        this.viewProvider = viewProvider;
        this.stateKey = 'waveformPlotter.state';
        this.state = structuredClone(types_1.DEFAULT_STATE);
        this.disposables = [];
        this.autoLoadedSessions = new Set();
        this.dataBuffer = new dataBuffer_1.DataBuffer(vscode.workspace.getConfiguration('waveformPlotter').get('maxChannels', 8), vscode.workspace.getConfiguration('waveformPlotter').get('bufferSize', 10000));
        this.passiveCollector = new passiveCollector_1.PassiveCollector(this.dataBuffer);
        this.liveWatchService = new liveWatchService_1.LiveWatchService(this.dataBuffer, () => this.scheduleSync());
        this.rttService = new rttService_1.RttService(this.dataBuffer, () => this.scheduleSync());
        this.viewProvider.setMessageHandler((message) => {
            void this.handleMessage(message);
        });
    }
    async initialize() {
        await this.loadState();
        this.registerListeners();
        this.rebuildBufferFromState();
        this.scheduleSync(true);
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
    async removeVariable(name) {
        const trimmed = name.trim();
        this.state.variableNames = this.state.variableNames.filter((v) => v !== trimmed);
        this.state.trackedVariables = this.state.trackedVariables.filter((v) => v !== trimmed);
        this.dataBuffer.removeChannel(trimmed);
        this.liveWatchService.clearResolvedEntries();
        this.persist();
        this.scheduleSync(true);
    }
    async setTracked(name, checked) {
        const trimmed = name.trim();
        if (!trimmed) {
            return;
        }
        const tracked = new Set(this.state.trackedVariables);
        if (checked) {
            tracked.add(trimmed);
        }
        else {
            tracked.delete(trimmed);
        }
        this.state.trackedVariables = [...tracked];
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
            refreshFps: update.refreshFps === 60 ? 60 : 30
        };
        this.persist();
        this.scheduleSync(true);
    }
    async setFrequency(hz) {
        this.state.liveWatchFrequency = clampInt(hz, 1, 2000, 50);
        this.persist();
        this.scheduleSync(true);
    }
    async toggleLive() {
        if (this.state.dataSource === 'RTT') {
            if (this.rttService.isRunning.value) {
                await this.stopRtt();
            }
            else {
                await this.startRtt();
            }
            return;
        }
        if (this.liveWatchService.isRunning.value) {
            await this.stopLiveWatch();
        }
        else {
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
    registerListeners() {
        this.disposables.push(vscode.debug.onDidStartDebugSession((session) => {
            this.currentDebugSession = session;
            this.currentStoppedThreadId = undefined;
            void this.tryAutoLoadElf(session);
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
        }));
    }
    async tryAutoLoadElf(session) {
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
    getElfPathFromSession(session) {
        const cfg = session.configuration;
        const candidates = [cfg.program, cfg.executable, cfg.elf];
        for (const value of candidates) {
            if (typeof value === 'string' && value.trim()) {
                return value;
            }
        }
        return undefined;
    }
    async startLiveWatch() {
        const session = this.currentDebugSession ?? vscode.debug.activeDebugSession;
        const tracked = [...new Set(this.state.trackedVariables)];
        if (!tracked.length) {
            void vscode.window.showWarningMessage('Please select variables first.');
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
        await this.liveWatchService.startLiveWatch(this.state.telnetPort, this.state.liveWatchFrequency);
        if (!this.liveWatchService.isRunning.value) {
            void vscode.window.showErrorMessage(this.liveWatchService.lastError ?? 'Live Watch failed to start.');
            return;
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
            const ok = await this.rttService.initOpenOcdRtt(this.state.telnetPort, this.state.rttPort, this.state.rttRamStart, this.state.rttRamSize);
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
    rebuildBufferFromState() {
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
    async loadState() {
        const saved = this.context.workspaceState.get(this.stateKey);
        this.state = { ...structuredClone(types_1.DEFAULT_STATE), ...(saved ?? {}) };
    }
    persist() {
        this.state.resolvedAddresses = this.liveWatchService.dumpResolvedEntries();
        void this.context.workspaceState.update(this.stateKey, this.state);
    }
    scheduleSync(immediate = false) {
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
    async pushState() {
        const viewState = this.buildViewState();
        this.viewProvider.postState(viewState);
    }
    buildViewState() {
        const snapshot = this.dataBuffer.snapshot();
        const channels = this.dataBuffer.getChannels();
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
            data: snapshot,
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
    buildStatusText() {
        const channels = this.dataBuffer.getChannels();
        if (!channels.length) {
            return 'Select variables and start recording to see waveforms';
        }
        const maxPoints = channels.reduce((m, ch) => Math.max(m, ch.size), 0);
        const yRange = this.estimateYRange();
        return `#${this.passiveCollector.sampleCount + this.liveWatchService.sampleCount + this.rttService.sampleCount} samples | ${maxPoints} pts | Y: [${fmt(yRange.min)}, ${fmt(yRange.max)}]`;
    }
    estimateYRange() {
        const channels = this.dataBuffer.getChannels();
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        for (const ch of channels) {
            for (let i = 0; i < ch.size; i += 1) {
                const v = ch.get(i);
                if (Number.isNaN(v)) {
                    continue;
                }
                min = Math.min(min, v);
                max = Math.max(max, v);
            }
        }
        if (!Number.isFinite(min) || !Number.isFinite(max)) {
            return { min: -1, max: 1 };
        }
        if (min === max) {
            return { min: min - 1, max: max + 1 };
        }
        return { min, max };
    }
    buildLiveStatusText() {
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
exports.WaveformController = WaveformController;
function csvField(s) {
    return /[,"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function fmt(v) {
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
function formatCompactValue(v, dataType) {
    if (!Number.isFinite(v)) {
        return 'NaN';
    }
    const prefix = dataType ? `(${dataType.toLowerCase()}) ` : '';
    const abs = Math.abs(v);
    const body = abs >= 10000 ? v.toFixed(0) : abs >= 1 ? v.toFixed(3) : abs >= 0.001 ? v.toFixed(5) : v.toExponential(2);
    return `${prefix}${body}`;
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
//# sourceMappingURL=controller.js.map