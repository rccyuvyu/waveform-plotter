"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LiveWatchService = void 0;
const passiveCollector_1 = require("./passiveCollector");
const openOcdTclClient_1 = require("./openOcdTclClient");
const openocdPortDetector_1 = require("./openocdPortDetector");
const telnetClient_1 = require("./telnetClient");
const elfSymbolResolver_1 = require("./elfSymbolResolver");
const sampleRateMeter_1 = require("./sampleRateMeter");
const compositeLayout_1 = require("./compositeLayout");
const watchTreeParser_1 = require("./watchTreeParser");
const RESPONSE_PATTERN = /0x[0-9a-fA-F]+:\s+([0-9a-fA-F]+)(?:\s+([0-9a-fA-F]+))?/;
class LiveWatchService {
    constructor(dataBuffer, onData) {
        this.dataBuffer = dataBuffer;
        this.onData = onData;
        this.isRunning = { value: false };
        this.elfResolver = new elfSymbolResolver_1.ElfSymbolResolver();
        /** 是否正在绘制波形（Live 模式下推数据到 dataBuffer） */
        this.livePlotting = false;
        /** 最近一次读取的所有变量值，用于树显示 */
        this.lastReadValues = new Map();
        this.sampleCount = 0;
        this.previewSampleTargets = new Set();
        this.lastNonPlotPreviewPushAt = 0;
        this.sampleRateMeter = new sampleRateMeter_1.SampleRateMeter();
        this.watchEntries = new Map();
        this.knownTreeNodes = new Set();
        this.knownLeafNodes = new Set();
        this.knownLeafTypes = new Map();
        this.knownDeclaredTypes = new Map();
        this.knownExpressions = new Map();
        this.knownDisplayValues = new Map();
        this.endpointLabel = '';
        this.sampleBusy = false;
        this.loopGeneration = 0;
        this.portDetector = new openocdPortDetector_1.OpenOcdPortDetector('127.0.0.1');
    }
    getResolvedEntries() {
        return Object.fromEntries(this.watchEntries.entries());
    }
    getKnownTreeNodes() {
        return [...this.knownTreeNodes];
    }
    getKnownLeafNodes() {
        return [...this.knownLeafNodes];
    }
    getKnownLeafType(name) {
        return this.knownLeafTypes.get(name);
    }
    getKnownLeafDeclaredType(name) {
        return this.knownDeclaredTypes.get(name);
    }
    getKnownExpression(name) {
        return this.knownExpressions.get(name);
    }
    getKnownDisplayValue(name) {
        return this.knownDisplayValues.get(name);
    }
    getLastReadValue(name) {
        return this.lastReadValues.get(name);
    }
    getEnumConstantName(name, value) {
        // 优先通过声明的类型文本查找
        const declaredType = this.knownDeclaredTypes.get(name);
        if (declaredType) {
            const result = this.elfResolver.getEnumConstantName(declaredType, value);
            if (result) {
                return result;
            }
        }
        // 回退：直接用变量名查找（简单枚举变量通过 buildEntry 已缓存）
        return this.elfResolver.getEnumConstantName(name, value);
    }
    clearResolvedEntries() {
        this.watchEntries.clear();
        this.knownTreeNodes.clear();
        this.knownLeafNodes.clear();
        this.knownLeafTypes.clear();
        this.knownDeclaredTypes.clear();
        this.knownExpressions.clear();
        this.knownDisplayValues.clear();
    }
    removeResolvedEntry(name) {
        this.watchEntries.delete(name);
        this.removeKnownNodesByPrefix(name);
    }
    removeResolvedEntriesByPrefix(prefix) {
        for (const name of [...this.watchEntries.keys()]) {
            if (name === prefix || name.startsWith(`${prefix}.`)) {
                this.watchEntries.delete(name);
            }
        }
        this.removeKnownNodesByPrefix(prefix);
    }
    hydrateResolvedEntries(entries) {
        for (const [name, value] of Object.entries(entries)) {
            const m = value.match(/^0x([0-9a-fA-F]+):(\w+)$/);
            if (!m) {
                continue;
            }
            const dataType = m[2].toUpperCase();
            this.watchEntries.set(name, {
                name,
                address: Number.parseInt(m[1], 16),
                dataType,
                byteSize: byteSize(dataType)
            });
            this.registerKnownPath(name);
            this.knownLeafTypes.set(name, dataType);
        }
    }
    rememberCompositeShape(rootName, leafInfos) {
        this.removeResolvedEntriesByPrefix(rootName);
        this.registerCompositeLeafInfos(rootName, leafInfos);
    }
    rememberParsedWatchTree(rootName, rootTree) {
        this.removeResolvedEntriesByPrefix(rootName);
        this.registerParsedWatchTree(rootName, rootTree);
    }
    async resolveVariableTreeFromCortexDebug(session, expression) {
        await this.refreshCortexLiveCache(session);
        const root = await this.buildCortexLiveTree(session, expression, expression);
        if (!root) {
            return false;
        }
        const liveEntries = await this.buildEntriesForLiveTree(session, root);
        this.removeResolvedEntriesByPrefix(expression);
        this.registerLiveNodeTree(expression, root);
        for (const entry of liveEntries) {
            this.watchEntries.set(entry.name, entry);
            this.knownLeafTypes.set(entry.name, entry.dataType);
        }
        return root.children.length > 0 || liveEntries.length > 0;
    }
    dumpResolvedEntries() {
        const out = {};
        for (const [name, entry] of this.watchEntries.entries()) {
            out[name] = `0x${entry.address.toString(16)}:${entry.dataType}`;
        }
        return out;
    }
    getLiveEndpointLabel() {
        return this.endpointLabel;
    }
    async resolveFromElf(elfPath, varNames) {
        const ok = await this.elfResolver.loadSymbols(elfPath);
        if (!ok) {
            console.warn(`[waveform-plotter] resolveFromElf: loadSymbols failed for ${elfPath}`);
            return 0;
        }
        let count = 0;
        for (const name of varNames) {
            // 如果该变量已有 entries（简单类型或 session 已解析的复合类型），跳过以避免覆盖
            if (this.watchEntries.has(name)) {
                count += 1;
                continue;
            }
            // 先通过 nm 判断符号大小：小尺寸(≤8)的变量大概率是基本类型，无需跑 ptype /o
            const symbolSize = this.elfResolver.getSymbolByteSize(name);
            const likelySimple = symbolSize !== undefined && symbolSize <= 8;
            const declaredTypeText = likelySimple ? await this.elfResolver.resolveDeclaredTypeText(name) : undefined;
            const compositePointer = declaredTypeText ? isCompositePointerType(declaredTypeText) : false;
            if (likelySimple && !compositePointer) {
                const entry = await this.elfResolver.resolveVariable(name);
                if (entry) {
                    this.watchEntries.set(name, entry);
                    this.registerKnownPath(name);
                    this.knownLeafTypes.set(name, entry.dataType);
                    console.log(`[waveform-plotter] resolveFromElf: "${name}" simple type, addr=0x${entry.address.toString(16)}, type=${entry.dataType}`);
                    count += 1;
                    continue;
                }
            }
            // 大尺寸符号或 nd 未找到的表达式：尝试 ptype /o 复合类型展开
            const watchTree = await this.elfResolver.resolveCompositeWatchTree(name);
            if (watchTree) {
                const leaves = (0, watchTreeParser_1.flattenParsedWatchLeaves)(name, watchTree);
                const hasAnyAddress = leaves.some(l => l.address !== undefined && l.address !== 0);
                if (hasAnyAddress) {
                    // 有有效地址：替换现有 entries 并注册树结构（完全解析）
                    this.removeResolvedEntriesByPrefix(name);
                    this.registerParsedWatchTree(name, watchTree);
                    this.registerEntriesFromParsedLeaves(leaves);
                    const entryCount = [...this.watchEntries.values()].filter(e => e.name.startsWith(name + '.') || e.name === name).length;
                    console.log(`[waveform-plotter] resolveFromElf: "${name}" composite type, ${leaves.length} leaves, ${entryCount} entries`);
                    count += 1;
                    continue;
                }
                // 所有叶子地址为 0/undefined（batch GDB 无法解析运行时地址）：
                // 只在首次注册树结构（用于 WebView 显示），不覆盖已存在的 session entries。
                this.registerParsedWatchTree(name, watchTree);
                console.log(`[waveform-plotter] resolveFromElf: "${name}" composite tree (${leaves.length} leaves) registered for display, no valid addresses - session will resolve`);
                count += 1;
                continue;
            }
            const compositeLeafInfos = await this.elfResolver.resolveCompositeLeafInfos(name);
            if (compositeLeafInfos.length > 0) {
                console.log(`[waveform-plotter] resolveFromElf: "${name}" ptype fallback, ${compositeLeafInfos.length} leaves (no addresses), falling through to session`);
            }
            // 最终回退：直接解析为表达式
            const entry = await this.elfResolver.resolveVariable(name);
            if (entry) {
                this.watchEntries.set(name, entry);
                this.registerKnownPath(name);
                this.knownLeafTypes.set(name, entry.dataType);
                console.log(`[waveform-plotter] resolveFromElf: "${name}" fallback, addr=0x${entry.address.toString(16)}`);
                count += 1;
            }
            else {
                // 最终回退：在全局结构体/类实例中查找成员（例如 "lqr_r_" → "motor.lqr_r_"）
                try {
                    const memberExpression = await this.elfResolver.resolveMemberExpression(name);
                    if (memberExpression) {
                        const memberTree = await this.elfResolver.resolveCompositeWatchTree(memberExpression);
                        if (memberTree) {
                            const memberLeaves = (0, watchTreeParser_1.flattenParsedWatchLeaves)(name, memberTree);
                            const hasMemberAddress = memberLeaves.some((leaf) => leaf.address !== undefined && leaf.address !== 0);
                            if (hasMemberAddress) {
                                this.removeResolvedEntriesByPrefix(name);
                                this.registerParsedWatchTree(name, memberTree);
                                this.registerEntriesFromParsedLeaves(memberLeaves);
                                const entryCount = [...this.watchEntries.values()].filter(e => e.name.startsWith(name + '.') || e.name === name).length;
                                console.log(`[waveform-plotter] resolveFromElf: "${name}" member tree via "${memberExpression}", ${entryCount} entries`);
                                count += 1;
                                continue;
                            }
                            this.registerParsedWatchTree(name, memberTree);
                            console.log(`[waveform-plotter] resolveFromElf: "${name}" member tree via "${memberExpression}" registered for display`);
                            count += 1;
                            continue;
                        }
                    }
                    const memberEntry = await this.elfResolver.resolveAsMember(name);
                    if (memberEntry) {
                        // 保留原始名称，地址已解析为成员的正确地址
                        memberEntry.name = name;
                        this.watchEntries.set(name, memberEntry);
                        this.registerKnownPath(name);
                        this.knownLeafTypes.set(name, memberEntry.dataType);
                        console.log(`[waveform-plotter] resolveFromElf: "${name}" -> member "${memberEntry.name}", addr=0x${memberEntry.address.toString(16)}`);
                        count += 1;
                    }
                    else {
                        console.warn(`[waveform-plotter] resolveFromElf: "${name}" could not be resolved`);
                    }
                }
                catch (memberErr) {
                    console.warn(`[waveform-plotter] resolveFromElf: resolveAsMember("${name}") threw`, memberErr);
                }
            }
        }
        return count;
    }
    async resolveVariables(session, varNames, threadId) {
        if (varNames.length === 0) {
            return 0;
        }
        if (session.type === 'cortex-debug') {
            let count = 0;
            for (const name of varNames) {
                const ok = await this.resolveVariableTreeFromCortexDebug(session, name);
                if (ok) {
                    count += 1;
                }
                else {
                    // cortex-debug 的 liveEvaluate/liveVariables 可能因 GDB 通信问题失败
                    // （如 qXfer 错误），回退到标准 DAP evaluate/variables 路径
                    console.log(`[waveform-plotter] resolveVariables: live path failed for "${name}", falling back to DAP`);
                    const sessionCount = await this.resolveVariablesViaDap(session, [name], threadId);
                    if (sessionCount > 0) {
                        console.log(`[waveform-plotter] resolveVariables: DAP fallback resolved ${sessionCount} entries for "${name}"`);
                        count += sessionCount;
                    }
                    else {
                        console.warn(`[waveform-plotter] resolveVariables: DAP fallback also failed for "${name}"`);
                    }
                }
            }
            return count;
        }
        return this.resolveVariablesViaDap(session, varNames, threadId);
    }
    /** 通过标准 DAP evaluate/variables 请求解析变量（用于非 cortex-debug 会话或 cortex-debug 回退） */
    async resolveVariablesViaDap(session, varNames, threadId) {
        if (varNames.length === 0) {
            return 0;
        }
        const t = threadId ?? (await this.pickThreadId(session));
        if (!t) {
            return 0;
        }
        const frameId = await this.getTopFrameId(session, t);
        if (frameId === undefined) {
            return 0;
        }
        let count = 0;
        for (const name of varNames) {
            // 先检测是否为 struct/class，直接展开
            const expanded = await this.expandStructMembers(session, name, frameId);
            if (expanded && expanded.length > 0) {
                // 移除之前可能由 ELF 解析的父条目
                this.watchEntries.delete(name);
                for (const e of expanded) {
                    this.watchEntries.set(e.name, e);
                    count += 1;
                }
                continue;
            }
            // 基本类型：正常解析
            const entry = await this.resolveSingle(session, name, frameId);
            if (entry) {
                this.watchEntries.set(name, entry);
                count += 1;
            }
        }
        return count;
    }
    async refineResolvedTypes(session, varNames, threadId) {
        if (varNames.length === 0) {
            return 0;
        }
        const t = threadId ?? (await this.pickThreadId(session));
        if (!t) {
            return 0;
        }
        const frameId = await this.getTopFrameId(session, t);
        if (frameId === undefined) {
            return 0;
        }
        let updated = 0;
        for (const name of varNames) {
            const entry = this.watchEntries.get(name);
            if (!entry) {
                continue;
            }
            const typeText = await this.resolveExpressionTypeText(session, name, frameId);
            if (!typeText) {
                continue;
            }
            const compositeTypeTree = await this.resolveCompositeTypeTreeViaDebugger(session, typeText, name, frameId, new Set());
            if (compositeTypeTree) {
                const expanded = await this.buildEntriesForParsedLeaves(session, (0, watchTreeParser_1.flattenParsedWatchLeaves)(name, compositeTypeTree), frameId);
                if (expanded && expanded.length > 0) {
                    this.watchEntries.delete(name);
                    this.registerParsedWatchTree(name, compositeTypeTree);
                    for (const e of expanded) {
                        this.watchEntries.set(e.name, e);
                    }
                    updated += expanded.length;
                }
                continue;
            }
            const sizeResult = await this.safeEval(session, `print (int)sizeof(${name})`, frameId);
            const type = inferDataType(typeText, sizeResult ?? '');
            if (!type) {
                continue;
            }
            if (type !== entry.dataType) {
                this.watchEntries.set(name, {
                    ...entry,
                    dataType: type,
                    byteSize: byteSize(type)
                });
                updated += 1;
            }
        }
        return updated;
    }
    async startLiveWatch(telnetPort, frequencyHz) {
        if (this.isRunning.value) {
            return;
        }
        this.isRunning.value = true;
        this.sampleCount = 0;
        this.lastError = undefined;
        this.sampleRateMeter.reset();
        try {
            await this.connectOpenOcd(telnetPort);
        }
        catch (err) {
            this.lastError = toErrMsg(err);
            this.isRunning.value = false;
            await this.closeClient();
            return;
        }
        const intervalNs = hzToIntervalNs(frequencyHz);
        const generation = ++this.loopGeneration;
        void this.runLoop(intervalNs, generation);
    }
    /**
     * 通过 cortex-debug 的 OpenOCD TCL 端口进行实时采样，
     * 不走 telnet（避免 GDB NAK 冲突），也不走 DAP evaluate（避免 frameId 问题）。
     */
    async startLiveWatchViaSession(session, frequencyHz) {
        if (this.isRunning.value) {
            return;
        }
        this.isRunning.value = true;
        this.sampleCount = 0;
        this.lastError = undefined;
        this.sampleRateMeter.reset();
        const entries = [...this.watchEntries.values()];
        if (entries.length === 0) {
            this.lastError = 'No resolved entries to sample';
            this.isRunning.value = false;
            return;
        }
        const intervalNs = hzToIntervalNs(frequencyHz);
        const generation = ++this.loopGeneration;
        // 尝试 TCL 连接：cortex-debug 常用端口 50001、4445，默认 6666
        let tclClient;
        const tclPorts = [50001, 4445, 6666];
        for (const port of tclPorts) {
            try {
                const client = new openOcdTclClient_1.OpenOcdTclClient('127.0.0.1', port);
                await client.connect();
                tclClient = client;
                this.client = client;
                this.clientMode = 'tcl';
                this.endpointLabel = `tcl:${port}`;
                console.log(`[waveform-plotter] TCL connected on port ${port}`);
                break;
            }
            catch {
                // try next port
            }
        }
        if (!tclClient) {
            // TCL 不可用，尝试 telnet 回退
            console.log(`[waveform-plotter] TCL not available, falling back to telnet`);
            try {
                const cfgPort = session.configuration?.telnetPort;
                const preferred = typeof cfgPort === 'number' && cfgPort > 0 ? cfgPort : 4444;
                await this.connectOpenOcd(preferred);
                console.log(`[waveform-plotter] Telnet fallback connected on ${this.endpointLabel}`);
            }
            catch (err) {
                this.lastError = `Could not connect to OpenOCD via TCL (tried ports ${tclPorts.join(', ')}) or telnet: ${toErrMsg(err)}`;
                this.isRunning.value = false;
                return;
            }
            void this.runLoop(intervalNs, generation);
            return;
        }
        void this.runLoopViaSession(intervalNs, generation);
    }
    async runLoopViaSession(intervalNs, generation) {
        let nextDeadline = process.hrtime.bigint();
        while (this.isRunning.value && generation === this.loopGeneration) {
            nextDeadline += intervalNs;
            await this.sampleOnceViaTcl();
            await this.waitUntilNextDeadline(nextDeadline);
        }
    }
    async sampleOnceViaTcl() {
        if (this.sampleBusy || this.clientMode !== 'tcl' || !this.client) {
            return;
        }
        this.sampleBusy = true;
        try {
            const tcl = this.client;
            const sampledEntries = this.getPreferredSampleEntries();
            const values = new Map();
            if (sampledEntries.length > 0) {
                await this.batchReadTclBlocks(tcl, sampledEntries, values);
            }
            // 始终更新最后读取的值（用于树显示）
            for (const [name, value] of values) {
                this.lastReadValues.set(name, value);
            }
            if (values.size > 0) {
                // 仅在 Live 绘图模式下推数据到 dataBuffer（画波形）
                if (this.livePlotting) {
                    if (this.dataBuffer.getChannels().length > 0) {
                        const nowNs = process.hrtime.bigint();
                        this.dataBuffer.pushAll(values, nowNs);
                        this.sampleCount += 1;
                        this.sampleRateMeter.mark(nowNs);
                        this.lastError = undefined;
                        this.lastNonPlotPreviewPushAt = 0;
                        if (this.sampleCount <= 3) {
                            const sampleStr = [...values.entries()].slice(0, 3).map(([k, v]) => `${k}=${v}`).join(', ');
                            console.log(`[waveform-plotter] sampleViaTcl #${this.sampleCount}: ${sampleStr}`);
                        }
                    }
                    this.onData();
                }
                else {
                    const nowMs = Date.now();
                    if (nowMs - this.lastNonPlotPreviewPushAt >= LiveWatchService.PREVIEW_PUSH_INTERVAL_MS) {
                        this.lastNonPlotPreviewPushAt = nowMs;
                        this.onData();
                    }
                }
            }
        }
        finally {
            this.sampleBusy = false;
        }
    }
    async batchReadTclBlocks(client, entries, outValues) {
        if (entries.length === 0) {
            return;
        }
        const blocks = buildTclReadBlocks(entries);
        for (const block of blocks) {
            try {
                const rawWords = await client.readMemory32(block.startAddress, block.wordCount);
                for (const entry of block.entries) {
                    const raw = extractEntryRawFromWords(rawWords, block.startAddress, entry);
                    const interpreted = interpretBytes(raw, entry.dataType);
                    if (Number.isFinite(interpreted)) {
                        outValues.set(entry.name, interpreted);
                    }
                }
            }
            catch {
                for (const entry of block.entries) {
                    try {
                        const parsed = await this.readViaTcl(client, entry);
                        if (parsed !== undefined && Number.isFinite(parsed)) {
                            outValues.set(entry.name, parsed);
                        }
                    }
                    catch {
                        // skip
                    }
                }
            }
        }
    }
    /** 根据数据类型构建 DAP evaluate 表达式 */
    buildDapReadExpression(entry) {
        const addr = `0x${entry.address.toString(16)}`;
        switch (entry.dataType) {
            case 'FLOAT':
                return `*(float*)(${addr})`;
            case 'DOUBLE':
                return `*(double*)(${addr})`;
            case 'BOOL':
            case 'INT8':
                return `*(int8_t*)(${addr})`;
            case 'UINT8':
                return `*(uint8_t*)(${addr})`;
            case 'INT16':
                return `*(int16_t*)(${addr})`;
            case 'UINT16':
                return `*(uint16_t*)(${addr})`;
            case 'INT32':
                return `*(int32_t*)(${addr})`;
            case 'ENUM':
            case 'UINT32':
                return `*(uint32_t*)(${addr})`;
            case 'INT64':
                return `*(int64_t*)(${addr})`;
            case 'UINT64':
                return `*(uint64_t*)(${addr})`;
            default:
                return undefined;
        }
    }
    /** 解析 DAP evaluate 返回的字符串值为数值 */
    parseDapEvaluateResult(result, dataType) {
        const trimmed = result.trim();
        // 处理 GDB 返回格式：可能包含 $N = 前缀或直接是值
        const valueStr = trimmed.replace(/^\$\d+\s*=\s*/, '').trim();
        switch (dataType) {
            case 'FLOAT':
            case 'DOUBLE': {
                const num = Number.parseFloat(valueStr);
                return Number.isFinite(num) ? num : undefined;
            }
            default: {
                // 整数类型：支持十进制和 0x 十六进制
                const intMatch = valueStr.match(/^(-?0x[0-9a-fA-F]+|-?\d+)/);
                if (intMatch) {
                    const val = Number.parseInt(intMatch[1], intMatch[1].startsWith('0x') || intMatch[1].startsWith('-0x') ? 16 : 10);
                    return Number.isFinite(val) ? val : undefined;
                }
                return undefined;
            }
        }
    }
    async stopLiveWatch() {
        this.isRunning.value = false;
        this.loopGeneration += 1;
        await this.closeClient();
        this.sampleBusy = false;
        this.sampleRateMeter.reset();
    }
    getActualFrequencyHz() {
        return this.sampleRateMeter.getHz();
    }
    setPreviewSampleTargets(names) {
        this.previewSampleTargets = new Set(names.map((name) => name.trim()).filter(Boolean));
    }
    getPreferredSampleEntries(entries = [...this.watchEntries.values()]) {
        const filtered = entries.filter((entry) => entry.address !== 0);
        if (!this.livePlotting) {
            if (this.previewSampleTargets.size > 0) {
                return filtered.filter((entry) => this.previewSampleTargets.has(entry.name));
            }
            return filtered;
        }
        const activeChannels = this.dataBuffer.getChannels();
        if (activeChannels.length === 0) {
            return [];
        }
        const activeNames = new Set(activeChannels.map((channel) => channel.name));
        return filtered.filter((entry) => activeNames.has(entry.name));
    }
    async waitUntilNextDeadline(deadlineNs) {
        const now = process.hrtime.bigint();
        if (deadlineNs <= now) {
            await new Promise((resolve) => setImmediate(resolve));
            return;
        }
        const remainingNs = deadlineNs - now;
        if (remainingNs >= 2000000n) {
            await new Promise((resolve) => setTimeout(resolve, Number(remainingNs / 1000000n)));
            return;
        }
        await new Promise((resolve) => setImmediate(resolve));
    }
    /** 将用户输入的字符串解析为与 dataType 匹配的原始数值（整数类型返回无符号值，FLOAT 返回 uint32 位模式，DOUBLE 返回浮点数自身） */
    parseUserValue(input, dataType) {
        const trimmed = input.trim();
        if (/^[-+]?0x[0-9a-fA-F]+$/.test(trimmed)) {
            return Number.parseInt(trimmed, 16);
        }
        const num = Number(trimmed);
        if (!Number.isFinite(num)) {
            return null;
        }
        switch (dataType) {
            case 'BOOL':
            case 'UINT8':
                return clampInt(num, 0, 255);
            case 'INT8':
                return clampInt(num, -128, 127) & 0xFF;
            case 'UINT16':
                return clampInt(num, 0, 65535);
            case 'INT16':
                return clampInt(num, -32768, 32767) & 0xFFFF;
            case 'ENUM':
                return clampUint(num, 0, 0xFFFFFFFF);
            case 'UINT32':
                return clampUint(num, 0, 0xFFFFFFFF);
            case 'INT32':
                return (clampInt(num, -2147483648, 2147483647) >>> 0);
            case 'FLOAT': {
                const buf = new ArrayBuffer(4);
                const dv = new DataView(buf);
                dv.setFloat32(0, num, true);
                return dv.getUint32(0, true);
            }
            case 'INT64':
            case 'UINT64':
                return clampInt(num, 0, Number.MAX_SAFE_INTEGER);
            case 'DOUBLE':
                return num;
        }
    }
    /** 构建 OpenOCD 内存写命令数组 */
    buildTelnetWriteCommand(entry, value) {
        const addr = `0x${entry.address.toString(16)}`;
        switch (entry.dataType) {
            case 'BOOL':
            case 'INT8':
            case 'UINT8':
                return [`mwb ${addr} ${value}`];
            case 'INT16':
            case 'UINT16':
                return [`mwh ${addr} ${value}`];
            case 'ENUM':
            case 'INT32':
            case 'UINT32':
                return [`mww ${addr} ${value}`];
            case 'FLOAT': {
                const buf = new ArrayBuffer(4);
                const dv = new DataView(buf);
                dv.setFloat32(0, value, true);
                return [`mww ${addr} ${dv.getUint32(0, true)}`];
            }
            case 'INT64':
            case 'UINT64':
            case 'DOUBLE': {
                const buf = new ArrayBuffer(8);
                const dv = new DataView(buf);
                if (entry.dataType === 'DOUBLE') {
                    dv.setFloat64(0, value, true);
                }
                else {
                    dv.setBigInt64(0, BigInt(Math.round(value)), true);
                }
                const low = dv.getUint32(0, true);
                const high = dv.getUint32(4, true);
                const addrHigh = `0x${(entry.address + 4).toString(16)}`;
                return [`mww ${addr} ${low}`, `mww ${addrHigh} ${high}`];
            }
        }
    }
    /** 通过 OpenOCD 修改变量内存值 */
    async writeMemory(name, value) {
        const entry = this.watchEntries.get(name);
        if (!entry || !this.client) {
            return false;
        }
        try {
            if (this.clientMode === 'tcl') {
                await this.writeViaTcl(this.client, entry, value);
                return true;
            }
            const commands = this.buildTelnetWriteCommand(entry, value);
            const responses = await this.client.sendBatch(commands, 500);
            return responses.length === commands.length;
        }
        catch {
            return false;
        }
    }
    async runLoop(intervalNs, generation) {
        let nextDeadline = process.hrtime.bigint();
        while (this.isRunning.value && generation === this.loopGeneration) {
            nextDeadline += intervalNs;
            await this.sampleOnce();
            await this.waitUntilNextDeadline(nextDeadline);
        }
    }
    async sampleOnce() {
        if (!this.isRunning.value || this.sampleBusy) {
            return;
        }
        const client = this.client;
        if (!client) {
            return;
        }
        const entries = [...this.watchEntries.values()];
        const sampledEntries = this.getPreferredSampleEntries(entries);
        if (sampledEntries.length === 0) {
            return;
        }
        this.sampleBusy = true;
        try {
            const values = new Map();
            if (this.clientMode === 'tcl') {
                await this.batchReadTclBlocks(client, sampledEntries, values);
            }
            else {
                const commands = sampledEntries.map((entry) => buildTelnetReadCommand(entry));
                const responses = await client.sendBatch(commands, 700);
                if (responses.length !== sampledEntries.length) {
                    console.warn(`[waveform-plotter] sampleOnce: expected ${sampledEntries.length} responses, got ${responses.length}`);
                    return; // finally 块会重置 sampleBusy
                }
                for (let i = 0; i < sampledEntries.length; i += 1) {
                    const entry = sampledEntries[i];
                    const raw = parseOpenocdResponse(responses[i], entry.dataType);
                    if (raw === undefined) {
                        continue;
                    }
                    const parsed = interpretBytes(raw, entry.dataType);
                    values.set(entry.name, parsed);
                }
            }
            if (values.size > 0) {
                for (const [name, value] of values) {
                    this.lastReadValues.set(name, value);
                }
                if (this.livePlotting && this.dataBuffer.getChannels().length > 0) {
                    const nowNs = process.hrtime.bigint();
                    this.dataBuffer.pushAll(values, nowNs);
                    this.sampleCount += 1;
                    this.sampleRateMeter.mark(nowNs);
                    this.lastError = undefined;
                    this.lastNonPlotPreviewPushAt = 0;
                    if (this.sampleCount <= 3) {
                        const sampleStr = [...values.entries()].slice(0, 3).map(([k, v]) => `${k}=${v}`).join(', ');
                        console.log(`[waveform-plotter] sampleOnce #${this.sampleCount}: ${sampleStr}`);
                    }
                    this.onData();
                }
                else {
                    const nowMs = Date.now();
                    if (nowMs - this.lastNonPlotPreviewPushAt >= LiveWatchService.PREVIEW_PUSH_INTERVAL_MS) {
                        this.lastNonPlotPreviewPushAt = nowMs;
                        this.onData();
                    }
                }
            }
            else {
                console.warn(`[waveform-plotter] sampleOnce #${this.sampleCount}: no values read`);
            }
        }
        catch (err) {
            this.lastError = toErrMsg(err);
        }
        finally {
            this.sampleBusy = false;
        }
    }
    async resolveSingle(session, varName, frameId) {
        try {
            const expression = this.knownExpressions.get(varName) ?? varName;
            const addrResult = (await session.customRequest('evaluate', {
                expression: `print/x (unsigned long)&(${expression})`,
                frameId,
                context: 'repl'
            }));
            const address = parseAddressFromPrint(addrResult.result ?? '');
            if (address === undefined) {
                return undefined;
            }
            const dataType = await this.queryDataType(session, expression, frameId);
            if (!dataType) {
                return undefined;
            }
            const declaredTypeText = await this.resolveExpressionTypeText(session, expression, frameId);
            return {
                name: varName,
                address,
                dataType,
                byteSize: byteSize(dataType),
                declaredTypeText: declaredTypeText ? normalizeDeclaredTypeText(declaredTypeText) : undefined
            };
        }
        catch {
            return undefined;
        }
    }
    /**
     * 递归展开 struct/class/union 变量的所有基本类型成员。
     * 对每个叶子成员使用 GDB 获取独立地址和类型。
     */
    async expandStructMembers(session, varName, frameId) {
        const declaredTypeText = await this.resolveExpressionTypeText(session, varName, frameId);
        if (declaredTypeText && isCompositePointerType(declaredTypeText)) {
            const derefTree = await this.resolveCompositeTypeTreeViaDebugger(session, declaredTypeText, composePointerDerefExpression(varName), frameId, new Set());
            if (derefTree) {
                await this.hydrateParsedWatchTreeViaDebugger(session, derefTree, frameId, new Set());
                const derefLeaves = (0, watchTreeParser_1.flattenParsedWatchLeaves)(varName, derefTree);
                const derefEntries = await this.buildEntriesForParsedLeaves(session, derefLeaves, frameId);
                if (derefEntries.length > 0) {
                    this.removeResolvedEntriesByPrefix(varName);
                    this.registerParsedWatchTree(varName, derefTree);
                    return derefEntries;
                }
            }
        }
        if (this.elfResolver.isLoaded()) {
            const miTree = await this.elfResolver.resolveCompositeWatchTree(varName);
            if (miTree) {
                const parsedLeaves = (0, watchTreeParser_1.flattenParsedWatchLeaves)(varName, miTree);
                const parsedEntries = await this.buildEntriesForParsedLeaves(session, parsedLeaves, frameId);
                if (parsedEntries.length > 0) {
                    this.removeResolvedEntriesByPrefix(varName);
                    this.registerParsedWatchTree(varName, miTree);
                    return parsedEntries;
                }
                // batch GDB 无法解析地址（如结构体含指针成员），让 session 实时解析
                console.log(`[waveform-plotter] expandStructMembers: batch GDB gave tree but no entries for "${varName}", trying live ptype`);
            }
        }
        const layoutText = (await this.safeEval(session, ptypeLayoutExpressionCommand(varName), frameId))
            ?? (await this.safeEval(session, ptypeExpressionCommand(varName), frameId));
        if (!layoutText || !isStructOrClass(layoutText)) {
            return [];
        }
        const parsedTree = (0, watchTreeParser_1.parsePtypeWatchTree)(layoutText, varName);
        if (parsedTree) {
            await this.hydrateParsedWatchTreeViaDebugger(session, parsedTree, frameId, new Set());
            const parsedLeaves = (0, watchTreeParser_1.flattenParsedWatchLeaves)(varName, parsedTree);
            const parsedEntries = await this.buildEntriesForParsedLeaves(session, parsedLeaves, frameId);
            if (parsedEntries.length > 0) {
                this.removeResolvedEntriesByPrefix(varName);
                this.registerParsedWatchTree(varName, parsedTree);
                return parsedEntries;
            }
        }
        const elfLeafInfos = (this.elfResolver.isLoaded() ? await this.elfResolver.resolveCompositeLeafInfos(varName) : [])
            || [];
        const debuggerLeafInfos = await this.resolveCompositeLeafInfosViaDebugger(session, varName, frameId);
        let chosenLeafInfos = elfLeafInfos;
        let chosenEntries = await this.buildEntriesForLeafInfos(session, varName, elfLeafInfos, frameId);
        if (debuggerLeafInfos.length > 0) {
            const debuggerEntries = await this.buildEntriesForLeafInfos(session, varName, debuggerLeafInfos, frameId);
            const preferDebugger = chosenEntries.length === 0
                || debuggerEntries.length > chosenEntries.length
                || (debuggerEntries.length === chosenEntries.length && debuggerLeafInfos.length > chosenLeafInfos.length);
            if (preferDebugger) {
                chosenLeafInfos = debuggerLeafInfos;
                chosenEntries = debuggerEntries;
            }
        }
        if (chosenEntries.length === 0) {
            return [];
        }
        this.removeResolvedEntriesByPrefix(varName);
        this.registerCompositeLeafInfos(varName, chosenLeafInfos);
        return chosenEntries;
    }
    async buildEntriesForLeafInfos(session, rootName, leafInfos, frameId) {
        if (leafInfos.length === 0) {
            return [];
        }
        const entries = [];
        for (const leafInfo of leafInfos) {
            const fullName = joinCompositePath(rootName, leafInfo.path);
            const addrText = await this.safeEval(session, `print/x (unsigned long)&${fullName}`, frameId);
            if (!addrText) {
                continue;
            }
            const address = parseAddressFromPrint(addrText);
            if (address === undefined) {
                continue;
            }
            const dt = await this.queryDataType(session, fullName, frameId)
                ?? (0, compositeLayout_1.inferDataTypeFromTypeText)(leafInfo.typeText, leafInfo.byteSize);
            if (!dt) {
                continue;
            }
            entries.push({
                name: fullName,
                address,
                dataType: dt,
                byteSize: byteSize(dt),
                declaredTypeText: normalizeDeclaredTypeText(leafInfo.typeText)
            });
        }
        return dedupeWatchEntries(entries);
    }
    async buildEntriesForParsedLeaves(session, leaves, frameId) {
        const entries = [];
        for (const leaf of leaves) {
            let address = leaf.address;
            if (address === undefined) {
                const addrText = await this.safeEval(session, `print/x (unsigned long)&(${leaf.expression})`, frameId);
                if (!addrText) {
                    continue;
                }
                address = parseAddressFromPrint(addrText);
            }
            if (address === undefined) {
                continue;
            }
            const dt = await this.queryDataType(session, leaf.expression, frameId)
                ?? (0, compositeLayout_1.inferDataTypeFromTypeText)(leaf.declaredTypeText, leaf.byteSize);
            if (!dt) {
                continue;
            }
            entries.push({
                name: leaf.fullName,
                address,
                dataType: dt,
                byteSize: byteSize(dt),
                declaredTypeText: normalizeDeclaredTypeText(leaf.declaredTypeText)
            });
        }
        return dedupeWatchEntries(entries);
    }
    async hydrateParsedWatchTreeViaDebugger(session, node, frameId, seenTypes) {
        for (const child of node.children) {
            if (child.children.length > 0) {
                await this.hydrateParsedWatchTreeViaDebugger(session, child, frameId, new Set(seenTypes));
                continue;
            }
            const expanded = await this.resolveCompositeTypeTreeViaDebugger(session, child.declaredTypeText, child.expression, frameId, new Set(seenTypes));
            if (!expanded || expanded.children.length === 0) {
                continue;
            }
            child.children = expanded.children;
            child.byteSize = expanded.byteSize || child.byteSize;
            await this.hydrateParsedWatchTreeViaDebugger(session, child, frameId, new Set(seenTypes));
        }
    }
    async resolveCompositeTypeTreeViaDebugger(session, typeText, expression, frameId, seenTypes) {
        const normalizedType = normalizeCompositeTypeName(typeText);
        if (!normalizedType || seenTypes.has(normalizedType)) {
            return undefined;
        }
        seenTypes.add(normalizedType);
        const layoutText = (await this.safeEval(session, `ptype /o ${normalizedType}`, frameId))
            ?? (await this.safeEval(session, `ptype ${normalizedType}`, frameId));
        if (!layoutText || !isStructOrClass(layoutText)) {
            return undefined;
        }
        return (0, watchTreeParser_1.parsePtypeWatchTree)(layoutText, expression);
    }
    async resolveCompositeLeafInfosViaDebugger(session, expression, frameId) {
        const typeText = await this.resolveExpressionTypeText(session, expression, frameId);
        if (!typeText) {
            return [];
        }
        return this.resolveCompositeLeafInfosForTypeViaDebugger(session, typeText, frameId, new Set());
    }
    async resolveCompositeLeafInfosForTypeViaDebugger(session, typeText, frameId, seenTypes) {
        const normalizedType = normalizeCompositeTypeName(typeText);
        if (!normalizedType || seenTypes.has(normalizedType)) {
            return [];
        }
        seenTypes.add(normalizedType);
        const layoutText = (await this.safeEval(session, `ptype /o ${normalizedType}`, frameId))
            ?? (await this.safeEval(session, `ptype ${normalizedType}`, frameId));
        if (!layoutText || !isStructOrClass(layoutText)) {
            return [];
        }
        const directFields = (0, compositeLayout_1.parseCompositeFieldInfos)(layoutText);
        if (directFields.length === 0) {
            return dedupeCompositeLeafInfos((0, compositeLayout_1.parseCompositeLeafInfos)(layoutText));
        }
        const leafInfos = [];
        for (const field of directFields) {
            const expanded = await this.expandCompositeFieldViaDebugger(session, field, frameId, new Set(seenTypes));
            if (expanded.length > 0) {
                leafInfos.push(...expanded);
                continue;
            }
            const elementPaths = expandCompositeFieldPaths(field);
            const elementSize = computeCompositeFieldElementByteSize(field);
            const dt = (0, compositeLayout_1.inferDataTypeFromTypeText)(field.typeText, elementSize);
            if (!dt) {
                continue;
            }
            for (const path of elementPaths) {
                leafInfos.push({
                    path,
                    typeText: field.typeText,
                    byteSize: elementSize
                });
            }
        }
        return dedupeCompositeLeafInfos(leafInfos);
    }
    async expandCompositeFieldViaDebugger(session, field, frameId, seenTypes) {
        const nestedLeafInfos = await this.resolveCompositeLeafInfosForTypeViaDebugger(session, field.typeText, frameId, new Set(seenTypes));
        if (nestedLeafInfos.length === 0) {
            return [];
        }
        const prefixes = expandCompositeFieldPaths(field);
        const expanded = [];
        for (const prefix of prefixes) {
            for (const leafInfo of nestedLeafInfos) {
                expanded.push({
                    path: joinCompositePath(prefix, leafInfo.path),
                    typeText: leafInfo.typeText,
                    byteSize: leafInfo.byteSize
                });
            }
        }
        return expanded;
    }
    async resolveExpressionTypeText(session, expression, frameId) {
        const result = await this.safeEval(session, `whatis (${expression})`, frameId);
        const match = result?.match(/type\s*=\s*(.+)/i);
        return match?.[1]?.trim();
    }
    async safeEval(session, expression, frameId) {
        try {
            const result = (await session.customRequest('evaluate', {
                expression,
                frameId,
                context: 'repl'
            }));
            return result?.result?.trim();
        }
        catch {
            return undefined;
        }
    }
    async queryDataType(session, varName, frameId) {
        try {
            const typeResult = (await session.customRequest('evaluate', {
                expression: `whatis (${varName})`,
                frameId,
                context: 'repl'
            }));
            const sizeResult = (await session.customRequest('evaluate', {
                expression: `print (int)sizeof(${varName})`,
                frameId,
                context: 'repl'
            }));
            const inferred = inferDataType(typeResult.result ?? '', sizeResult.result ?? '');
            if (inferred) {
                return inferred;
            }
            if (!isCompoundExpression(varName)) {
                const fallbackTypeResult = (await session.customRequest('evaluate', {
                    expression: ptypeExpressionCommand(varName),
                    frameId,
                    context: 'repl'
                }));
                return inferDataType(fallbackTypeResult.result ?? '', sizeResult.result ?? '');
            }
            return undefined;
        }
        catch {
            return undefined;
        }
    }
    async refreshCortexLiveCache(session) {
        try {
            await session.customRequest('liveCacheRefresh', { deleteAll: false });
        }
        catch {
            // Some adapter states do not support cache refresh; liveEvaluate/liveVariables still work.
        }
    }
    async buildCortexLiveTree(session, expression, fullName, displayName = fullName) {
        const evaluated = await this.evaluateLiveNode(session, expression, fullName, displayName);
        if (!evaluated) {
            return undefined;
        }
        await this.populateLiveNodeChildrenFromVariables(session, evaluated);
        await this.populateLiveNodePointerChildren(session, evaluated);
        return evaluated;
    }
    async evaluateLiveNode(session, expression, fullName, displayName) {
        const result = await this.safeLiveEvaluate(session, expression);
        if (!result) {
            return undefined;
        }
        return {
            name: displayName,
            fullName,
            expression,
            value: result.result ?? '',
            typeText: sanitizeLiveTypeText(result.type ?? ''),
            variablesReference: result.variablesReference ?? 0,
            children: []
        };
    }
    async listLiveChildren(session, variablesReference) {
        try {
            const result = (await session.customRequest('liveVariables', {
                variablesReference
            }));
            return result.variables ?? [];
        }
        catch {
            return [];
        }
    }
    async populateLiveNodeChildrenFromVariables(session, node) {
        if (!node.variablesReference) {
            await this.populateLiveNodePointerChildren(session, node);
            return;
        }
        const children = await this.listLiveChildren(session, node.variablesReference);
        node.children = [];
        for (const childInfo of children) {
            const childName = childInfo.name?.trim();
            if (!childName) {
                continue;
            }
            const childFullName = joinCompositePath(node.fullName, childName);
            const childExpression = childInfo.evaluateName?.trim() || childFullName;
            const childNode = {
                name: childName,
                fullName: childFullName,
                expression: childExpression,
                value: childInfo.value ?? '',
                typeText: sanitizeLiveTypeText(childInfo.type ?? ''),
                variablesReference: childInfo.variablesReference ?? 0,
                children: []
            };
            await this.populateLiveNodeChildrenFromVariables(session, childNode);
            node.children.push(childNode);
        }
    }
    async populateLiveNodePointerChildren(session, node) {
        if (node.children.length > 0 || !isCompositePointerType(node.typeText)) {
            return;
        }
        const derefExpression = composePointerDerefExpression(node.expression);
        const derefNode = await this.evaluateLiveNode(session, derefExpression, node.fullName, node.name);
        if (!derefNode) {
            return;
        }
        await this.populateLiveNodeChildrenFromVariables(session, derefNode);
        if (derefNode.children.length === 0) {
            return;
        }
        node.children = derefNode.children;
        node.variablesReference = derefNode.variablesReference;
    }
    async safeLiveEvaluate(session, expression) {
        try {
            return (await session.customRequest('liveEvaluate', {
                expression,
                context: 'hover'
            }));
        }
        catch {
            return undefined;
        }
    }
    async buildEntriesForLiveTree(session, root) {
        const leaves = flattenLiveLeafNodes(root);
        const entries = [];
        for (const leaf of leaves) {
            const entry = await this.buildEntryForLiveLeaf(session, leaf);
            if (entry) {
                entries.push(entry);
            }
        }
        return dedupeWatchEntries(entries);
    }
    async buildEntryForLiveLeaf(session, leaf) {
        const declaredTypeText = await this.resolveLiveLeafDeclaredType(session, leaf);
        if (!declaredTypeText) {
            return undefined;
        }
        const address = await this.resolveLiveNodeAddress(session, leaf.expression);
        if (address === undefined) {
            return undefined;
        }
        const byteSizeValue = await this.resolveLiveNodeByteSize(session, leaf.expression, declaredTypeText);
        const dataType = (0, compositeLayout_1.inferDataTypeFromTypeText)(declaredTypeText, byteSizeValue);
        if (!dataType) {
            return undefined;
        }
        return {
            name: leaf.fullName,
            address,
            dataType,
            byteSize: byteSize(dataType),
            declaredTypeText
        };
    }
    async resolveLiveLeafDeclaredType(session, leaf) {
        const direct = normalizeDeclaredTypeText(leaf.typeText);
        if (direct) {
            return direct;
        }
        const threadId = await this.pickThreadId(session);
        if (!threadId) {
            return undefined;
        }
        const frameId = await this.getTopFrameId(session, threadId);
        if (frameId === undefined) {
            return undefined;
        }
        const fallback = await this.resolveExpressionTypeText(session, leaf.expression, frameId);
        return fallback ? normalizeDeclaredTypeText(fallback) : undefined;
    }
    async resolveLiveNodeAddress(session, expression) {
        const result = await this.safeLiveEvaluate(session, `&(${expression})`);
        return parseAddressFromPrint(result?.result ?? '');
    }
    async resolveLiveNodeByteSize(session, expression, declaredTypeText) {
        const inferred = inferByteSizeFromDeclaredType(declaredTypeText);
        if (inferred !== undefined) {
            return inferred;
        }
        const result = await this.safeLiveEvaluate(session, `sizeof(${expression})`);
        const parsed = (0, passiveCollector_1.parseDebuggerNumber)(result?.result ?? '');
        if (parsed !== undefined && Number.isFinite(parsed) && parsed > 0) {
            return Math.max(1, Math.round(parsed));
        }
        return 4;
    }
    registerLiveNodeTree(rootName, root) {
        this.removeKnownNodesByPrefix(rootName);
        const rootIsLeaf = root.children.length === 0 && root.variablesReference === 0;
        const walk = (node) => {
            this.knownTreeNodes.add(node.fullName);
            if (node.typeText) {
                this.knownDeclaredTypes.set(node.fullName, normalizeDeclaredTypeText(node.typeText));
            }
            if (node.expression) {
                this.knownExpressions.set(node.fullName, node.expression);
            }
            if (node.value !== undefined) {
                this.knownDisplayValues.set(node.fullName, node.value);
            }
            if (node.children.length === 0 && node.variablesReference === 0 && (node.fullName !== rootName || rootIsLeaf)) {
                this.knownLeafNodes.add(node.fullName);
            }
            for (const child of node.children) {
                walk(child);
            }
        };
        walk(root);
    }
    async pickThreadId(session) {
        try {
            const r = (await session.customRequest('threads'));
            return r.threads?.[0]?.id;
        }
        catch {
            return undefined;
        }
    }
    async getTopFrameId(session, threadId) {
        try {
            const result = (await session.customRequest('stackTrace', {
                threadId,
                startFrame: 0,
                levels: 1
            }));
            return result.stackFrames?.[0]?.id;
        }
        catch {
            return undefined;
        }
    }
    async connectOpenOcd(preferredPort) {
        // cortex-debug 常用的自定义端口：50002、4444
        const hintPorts = [50002, 4444];
        const detectedTelnetPort = await this.portDetector.findTelnetPort(preferredPort, hintPorts);
        if (detectedTelnetPort !== undefined) {
            try {
                const client = new telnetClient_1.TelnetClient();
                await client.connect('127.0.0.1', detectedTelnetPort);
                this.client = client;
                this.clientMode = 'telnet';
                this.endpointLabel = `telnet:${detectedTelnetPort}`;
                return;
            }
            catch {
                // Fall through to the legacy mixed attempt list below.
            }
        }
        const attempts = buildConnectionAttempts(preferredPort);
        const errors = [];
        for (const attempt of attempts) {
            try {
                if (attempt.mode === 'tcl') {
                    const client = new openOcdTclClient_1.OpenOcdTclClient('127.0.0.1', attempt.port);
                    await client.connect();
                    this.client = client;
                    this.clientMode = 'tcl';
                    this.endpointLabel = `tcl:${attempt.port}`;
                    return;
                }
                const client = new telnetClient_1.TelnetClient();
                await client.connect('127.0.0.1', attempt.port);
                this.client = client;
                this.clientMode = 'telnet';
                this.endpointLabel = `telnet:${attempt.port}`;
                return;
            }
            catch (err) {
                errors.push(`${attempt.mode}:${attempt.port} ${toErrMsg(err)}`);
            }
        }
        throw new Error(`Cannot connect to OpenOCD live interface. Tried ${errors.join(' | ')}`);
    }
    async closeClient() {
        if (!this.client) {
            this.clientMode = undefined;
            this.endpointLabel = '';
            return;
        }
        if (this.clientMode === 'tcl') {
            this.client.disconnect();
        }
        else {
            await this.client.close();
        }
        this.client = undefined;
        this.clientMode = undefined;
        this.endpointLabel = '';
    }
    async readViaTcl(client, entry) {
        switch (entry.dataType) {
            case 'BOOL':
            case 'INT8':
            case 'UINT8': {
                const values = await client.readMemory8(entry.address, 1);
                return interpretBytes(BigInt(values[0] ?? 0), entry.dataType);
            }
            case 'INT16':
            case 'UINT16': {
                const values = await client.readMemory16(entry.address, 1);
                return interpretBytes(BigInt(values[0] ?? 0), entry.dataType);
            }
            case 'ENUM':
            case 'INT32':
            case 'UINT32':
            case 'FLOAT': {
                const values = await client.readMemory32(entry.address, 1);
                return interpretBytes(BigInt(values[0] ?? 0), entry.dataType);
            }
            case 'INT64':
            case 'UINT64':
            case 'DOUBLE': {
                const values = await client.readMemory32(entry.address, 2);
                if (values.length < 2) {
                    return undefined;
                }
                const raw = (BigInt(values[1] >>> 0) << 32n) | BigInt(values[0] >>> 0);
                return interpretBytes(raw, entry.dataType);
            }
        }
    }
    async writeViaTcl(client, entry, value) {
        switch (entry.dataType) {
            case 'BOOL':
            case 'INT8':
            case 'UINT8':
                await client.writeMemory8(entry.address, value);
                return;
            case 'INT16':
            case 'UINT16':
                await client.writeMemory16(entry.address, value);
                return;
            case 'ENUM':
            case 'INT32':
            case 'UINT32':
                await client.writeMemory32(entry.address, value);
                return;
            case 'FLOAT': {
                const buf = new ArrayBuffer(4);
                const dv = new DataView(buf);
                dv.setFloat32(0, value, true);
                await client.writeMemory32(entry.address, dv.getUint32(0, true));
                return;
            }
            case 'INT64':
            case 'UINT64':
            case 'DOUBLE': {
                const buf = new ArrayBuffer(8);
                const dv = new DataView(buf);
                if (entry.dataType === 'DOUBLE') {
                    dv.setFloat64(0, value, true);
                }
                else {
                    dv.setBigInt64(0, BigInt(Math.round(value)), true);
                }
                await client.writeMemory32(entry.address, dv.getUint32(0, true));
                await client.writeMemory32(entry.address + 4, dv.getUint32(4, true));
                return;
            }
        }
    }
    registerCompositeLeafInfos(rootName, leafInfos) {
        this.knownTreeNodes.add(rootName);
        for (const leafInfo of leafInfos) {
            const fullName = joinCompositePath(rootName, leafInfo.path);
            this.knownLeafNodes.add(fullName);
            this.registerKnownPath(fullName);
            this.knownDeclaredTypes.set(fullName, normalizeDeclaredTypeText(leafInfo.typeText));
            const dt = (0, compositeLayout_1.inferDataTypeFromTypeText)(leafInfo.typeText, leafInfo.byteSize);
            if (dt) {
                this.knownLeafTypes.set(fullName, dt);
            }
        }
    }
    registerEntriesFromParsedLeaves(leaves) {
        for (const leaf of leaves) {
            if (leaf.address === undefined) {
                continue;
            }
            const dt = (0, compositeLayout_1.inferDataTypeFromTypeText)(leaf.declaredTypeText, leaf.byteSize);
            if (!dt) {
                continue;
            }
            this.watchEntries.set(leaf.fullName, {
                name: leaf.fullName,
                address: leaf.address,
                dataType: dt,
                byteSize: byteSize(dt),
                declaredTypeText: normalizeDeclaredTypeText(leaf.declaredTypeText)
            });
            this.knownLeafTypes.set(leaf.fullName, dt);
        }
    }
    registerParsedWatchTree(rootName, rootTree) {
        if (!rootTree) {
            return;
        }
        this.removeKnownNodesByPrefix(rootName);
        const nodes = (0, watchTreeParser_1.flattenParsedWatchNodes)(rootName, rootTree);
        this.knownTreeNodes.add(rootName);
        for (const node of nodes) {
            const fullName = node.relativePath || rootName;
            this.knownTreeNodes.add(fullName);
            if (node.declaredTypeText) {
                this.knownDeclaredTypes.set(fullName, normalizeDeclaredTypeText(node.declaredTypeText));
            }
            if (node.children.length === 0 && fullName !== rootName) {
                this.knownLeafNodes.add(fullName);
            }
        }
    }
    registerKnownPath(fullName) {
        const parts = fullName.split('.');
        let current = '';
        for (let i = 0; i < parts.length; i += 1) {
            current = i === 0 ? parts[i] : `${current}.${parts[i]}`;
            this.knownTreeNodes.add(current);
        }
    }
    removeKnownNodesByPrefix(prefix) {
        for (const name of [...this.knownTreeNodes]) {
            if (name === prefix || name.startsWith(`${prefix}.`)) {
                this.knownTreeNodes.delete(name);
            }
        }
        for (const name of [...this.knownLeafNodes]) {
            if (name === prefix || name.startsWith(`${prefix}.`)) {
                this.knownLeafNodes.delete(name);
            }
        }
        for (const name of [...this.knownLeafTypes.keys()]) {
            if (name === prefix || name.startsWith(`${prefix}.`)) {
                this.knownLeafTypes.delete(name);
            }
        }
        for (const name of [...this.knownDeclaredTypes.keys()]) {
            if (name === prefix || name.startsWith(`${prefix}.`)) {
                this.knownDeclaredTypes.delete(name);
            }
        }
        for (const name of [...this.knownExpressions.keys()]) {
            if (name === prefix || name.startsWith(`${prefix}.`)) {
                this.knownExpressions.delete(name);
            }
        }
        for (const name of [...this.knownDisplayValues.keys()]) {
            if (name === prefix || name.startsWith(`${prefix}.`)) {
                this.knownDisplayValues.delete(name);
            }
        }
    }
}
exports.LiveWatchService = LiveWatchService;
LiveWatchService.PREVIEW_PUSH_INTERVAL_MS = 120;
function sanitizeLiveTypeText(typeText) {
    const firstLine = typeText.split(/\r?\n/, 1)[0] ?? '';
    return firstLine.replace(/\s+/g, ' ').trim();
}
function flattenLiveLeafNodes(root) {
    const leaves = [];
    const walk = (node) => {
        if (node.children.length === 0 && node.variablesReference === 0) {
            leaves.push(node);
            return;
        }
        for (const child of node.children) {
            walk(child);
        }
    };
    walk(root);
    return leaves;
}
function inferByteSizeFromDeclaredType(typeText) {
    const lower = typeText.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!lower) {
        return undefined;
    }
    if (/\bdouble\b/.test(lower)) {
        return 8;
    }
    if (/\bfloat\b/.test(lower)) {
        return 4;
    }
    if (/\bbool\b|\b(?:u?int8_t|char|signed char|unsigned char|std::byte)\b/.test(lower)) {
        return 1;
    }
    if (/\b(?:u?int16_t|short|short int|unsigned short|unsigned short int)\b/.test(lower)) {
        return 2;
    }
    if (/\b(?:u?int32_t|int|unsigned int|long|unsigned long|long int|unsigned long int)\b/.test(lower)) {
        return 4;
    }
    if (/\b(?:u?int64_t|long long|unsigned long long|long long int|unsigned long long int)\b/.test(lower)) {
        return 8;
    }
    return undefined;
}
function buildTelnetReadCommand(entry) {
    const addr = `0x${entry.address.toString(16)}`;
    switch (entry.dataType) {
        case 'BOOL':
        case 'INT8':
        case 'UINT8':
            return `mdb ${addr} 1`;
        case 'INT16':
        case 'UINT16':
            return `mdh ${addr} 1`;
        case 'ENUM':
        case 'INT32':
        case 'UINT32':
        case 'FLOAT':
            return `mdw ${addr} 1`;
        case 'INT64':
        case 'UINT64':
        case 'DOUBLE':
            return `mdw ${addr} 2`;
    }
}
function buildConnectionAttempts(preferredPort) {
    const unique = new Set();
    const attempts = [];
    const push = (mode, port) => {
        const key = `${mode}:${port}`;
        if (unique.has(key)) {
            return;
        }
        unique.add(key);
        attempts.push({ mode, port });
    };
    push('telnet', preferredPort);
    push('tcl', 50001);
    push('tcl', 6666);
    if (preferredPort === 6666) {
        push('tcl', preferredPort);
    }
    push('telnet', 50002);
    push('telnet', 4444);
    return attempts;
}
function hzToIntervalNs(frequencyHz) {
    const hz = Math.max(1, frequencyHz);
    return BigInt(Math.max(1, Math.round(1_000_000_000 / hz)));
}
function buildTclReadBlocks(entries) {
    const sorted = [...entries].sort((a, b) => a.address - b.address);
    const blocks = [];
    for (const entry of sorted) {
        const startAddress = alignDown4(entry.address);
        const endAddressExclusive = alignUp4(entry.address + Math.max(1, entry.byteSize));
        const last = blocks[blocks.length - 1];
        if (last && startAddress <= last.endAddressExclusive) {
            last.endAddressExclusive = Math.max(last.endAddressExclusive, endAddressExclusive);
            last.entries.push(entry);
            continue;
        }
        blocks.push({
            startAddress,
            endAddressExclusive,
            entries: [entry]
        });
    }
    return blocks.map((block) => ({
        startAddress: block.startAddress,
        wordCount: Math.max(1, (block.endAddressExclusive - block.startAddress) >>> 2),
        entries: block.entries
    }));
}
function extractEntryRawFromWords(rawWords, blockStartAddress, entry) {
    const byteOffset = entry.address - blockStartAddress;
    let raw = 0n;
    for (let i = 0; i < Math.max(1, entry.byteSize); i += 1) {
        const absoluteByte = byteOffset + i;
        const word = rawWords[absoluteByte >>> 2] ?? 0;
        const byteValue = (word >>> ((absoluteByte & 0x3) * 8)) & 0xFF;
        raw |= BigInt(byteValue) << BigInt(i * 8);
    }
    return raw;
}
function alignDown4(value) {
    return value & ~0x3;
}
function alignUp4(value) {
    return (value + 3) & ~0x3;
}
function parseOpenocdResponse(response, dt) {
    const m = response.match(RESPONSE_PATTERN);
    if (!m) {
        return undefined;
    }
    const low = BigInt(`0x${m[1]}`);
    if ((dt === 'DOUBLE' || dt === 'UINT64' || dt === 'INT64') && m[2]) {
        const high = BigInt(`0x${m[2]}`);
        return (high << 32n) | low;
    }
    return low;
}
function interpretBytes(rawValue, dataType) {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    switch (dataType) {
        case 'BOOL':
            return Number(rawValue !== 0n ? 1 : 0);
        case 'UINT8':
            return Number(rawValue & 0xffn);
        case 'INT8': {
            const v = Number(rawValue & 0xffn);
            return v > 127 ? v - 256 : v;
        }
        case 'UINT16':
            return Number(rawValue & 0xffffn);
        case 'INT16': {
            const v = Number(rawValue & 0xffffn);
            return v > 0x7fff ? v - 0x10000 : v;
        }
        case 'ENUM':
        case 'UINT32':
            return Number(rawValue & 0xffffffffn);
        case 'INT32': {
            const v = Number(rawValue & 0xffffffffn);
            return v > 0x7fffffff ? v - 0x100000000 : v;
        }
        case 'FLOAT':
            view.setUint32(0, Number(rawValue & 0xffffffffn), true);
            return view.getFloat32(0, true);
        case 'UINT64':
            return Number(rawValue & 0xffffffffffffffffn);
        case 'INT64': {
            const v = rawValue & 0xffffffffffffffffn;
            return v > 0x7fffffffffffffffn ? Number(v - 0x10000000000000000n) : Number(v);
        }
        case 'DOUBLE':
            view.setBigUint64(0, rawValue, true);
            return view.getFloat64(0, true);
    }
}
function parseAddressFromPrint(result) {
    const plainHex = result.match(/\b0x([0-9a-fA-F]+)\b/);
    if (plainHex) {
        return Number.parseInt(plainHex[1], 16);
    }
    const hex = result.match(/\$\d+\s*=\s*0x([0-9a-fA-F]+)/);
    if (hex) {
        return Number.parseInt(hex[1], 16);
    }
    const dec = result.match(/\$\d+\s*=\s*(\d+)/);
    if (dec) {
        return Number.parseInt(dec[1], 10);
    }
    const plainDec = result.match(/\b(\d+)\b/);
    if (plainDec) {
        return Number.parseInt(plainDec[1], 10);
    }
    const fallback = (0, passiveCollector_1.parseDebuggerNumber)(result);
    if (fallback !== undefined) {
        return Math.floor(fallback);
    }
    return undefined;
}
function inferDataType(ptypeResult, sizeResult) {
    const lower = ptypeResult.toLowerCase();
    // 检测 struct/class/union 类型，无法映射为单一基本类型
    if (isStructOrClass(ptypeResult)) {
        return undefined;
    }
    const size = (0, passiveCollector_1.parseDebuggerNumber)(sizeResult) ?? 4;
    const byteSizeValue = Math.max(1, Math.round(size));
    const isFloat = /\bfloat\b/.test(lower);
    const isDouble = /\bdouble\b/.test(lower);
    const isUnsigned = /\bunsigned\b|\buint\d*_t\b|\bbool\b/.test(lower);
    const isExplicitSigned = /\bsigned\b|\bint\d*_t\b/.test(lower);
    const isCharLike = /\bchar\b|\bint8_t\b|\buint8_t\b/.test(lower);
    if (isDouble) {
        return 'DOUBLE';
    }
    if (isFloat) {
        return 'FLOAT';
    }
    if (byteSizeValue === 1) {
        if (isCharLike && !isUnsigned && !isExplicitSigned) {
            return 'INT8';
        }
        return isUnsigned ? 'UINT8' : 'INT8';
    }
    if (byteSizeValue === 2) {
        return isUnsigned ? 'UINT16' : 'INT16';
    }
    if (byteSizeValue === 8) {
        if (isDouble) {
            return 'DOUBLE';
        }
        return isUnsigned ? 'UINT64' : 'INT64';
    }
    return isUnsigned ? 'UINT32' : 'INT32';
}
function normalizeCompositeTypeName(typeText) {
    return typeText
        .replace(/^type\s*=\s*/i, '')
        .replace(/\bconst\b|\bvolatile\b/g, ' ')
        .replace(/^(class|struct|union)\s+/i, '')
        .replace(/\s*:\s*(?:public|private|protected)\s+.*$/, '')
        .replace(/\s*[&*]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
function normalizeDeclaredTypeText(typeText) {
    return typeText
        .replace(/^type\s*=\s*/i, '')
        .replace(/\s*:\s*(?:public|private|protected)\s+.*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
}
function ptypeExpressionCommand(expression) {
    return `ptype (${expression})`;
}
function ptypeLayoutExpressionCommand(expression) {
    return `ptype /o (${expression})`;
}
function isCompoundExpression(expression) {
    return expression.includes('.')
        || expression.includes('->')
        || expression.includes('[');
}
function isCompositePointerType(typeText) {
    const normalized = typeText.replace(/^type\s*=\s*/i, '').replace(/\s+/g, ' ').trim();
    return /^(class|struct|union)\b/i.test(normalized) && /\*\s*$/.test(normalized);
}
function composePointerDerefExpression(expression) {
    return `*(${expression})`;
}
function expandCompositeFieldPaths(field) {
    if (!field.arrayDims.length) {
        return [field.path];
    }
    const MAX_EXPANDED_ARRAY_ELEMENTS = 128;
    let suffixes = [''];
    for (const dim of field.arrayDims) {
        if (suffixes.length * dim > MAX_EXPANDED_ARRAY_ELEMENTS) {
            return [field.path];
        }
        const next = [];
        for (const suffix of suffixes) {
            for (let index = 0; index < dim; index += 1) {
                next.push(`${suffix}[${index}]`);
            }
        }
        suffixes = next;
    }
    return suffixes.map((suffix) => `${field.path}${suffix}`);
}
function computeCompositeFieldElementByteSize(field) {
    if (!field.arrayDims.length) {
        return field.byteSize;
    }
    const totalCount = field.arrayDims.reduce((acc, dim) => acc * dim, 1);
    return totalCount > 0 ? Math.max(1, Math.floor(field.byteSize / totalCount)) : field.byteSize;
}
function dedupeCompositeLeafInfos(leafInfos) {
    const seen = new Set();
    const unique = [];
    for (const leafInfo of leafInfos) {
        if (!leafInfo.path || seen.has(leafInfo.path)) {
            continue;
        }
        seen.add(leafInfo.path);
        unique.push(leafInfo);
    }
    return unique;
}
function dedupeWatchEntries(entries) {
    const seen = new Set();
    const unique = [];
    for (const entry of entries) {
        if (!entry.name || seen.has(entry.name)) {
            continue;
        }
        seen.add(entry.name);
        unique.push(entry);
    }
    return unique;
}
/** 从 GDB ptype 输出中检测是否为 struct/class/union */
function isStructOrClass(ptypeText) {
    // 移除开头的 "type = "
    const stripped = ptypeText.replace(/^type\s*=\s*/i, '').trim();
    return /^(struct|class|union)\b/i.test(stripped);
}
function parseCompositeLeafPaths(ptypeOutput) {
    const lines = ptypeOutput.split(/\r?\n/);
    const headerIndex = lines.findIndex((line) => line.includes('{'));
    if (headerIndex < 0) {
        return parseFlatMemberNames(ptypeOutput);
    }
    const parsed = parseCompositeBlock(lines, headerIndex + 1);
    const unique = [...new Set(parsed.leafPaths.filter(Boolean))];
    if (unique.length > 0) {
        return unique;
    }
    return parseFlatMemberNames(ptypeOutput);
}
function parseCompositeBlock(lines, startLine) {
    const leafPaths = [];
    let i = startLine;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed || /^(public|private|protected)\s*:\s*$/i.test(trimmed) || /total size \(bytes\)/i.test(trimmed)) {
            i += 1;
            continue;
        }
        const nestedStart = stripPtypeLayoutComment(line).match(/^(struct|class|union)\b.*\{\s*$/i);
        if (nestedStart) {
            const nested = parseCompositeBlock(lines, i + 1);
            const childPaths = nested.leafPaths;
            if (nested.fieldName && !isLiveCompositeBaseClass(line, nested.fieldName)) {
                const basePaths = expandArrayFieldPaths(nested.fieldName, nested.arraySuffix);
                for (const basePath of basePaths) {
                    if (childPaths.length === 0) {
                        leafPaths.push(basePath);
                        continue;
                    }
                    for (const childPath of childPaths) {
                        leafPaths.push(joinCompositePath(basePath, childPath));
                    }
                }
            }
            else {
                leafPaths.push(...childPaths);
            }
            i = nested.endLine + 1;
            continue;
        }
        const closing = parseCompositeClosing(line);
        if (closing) {
            return {
                leafPaths,
                endLine: i,
                fieldName: closing.fieldName,
                arraySuffix: closing.arraySuffix
            };
        }
        leafPaths.push(...parseLeafFieldPaths(line));
        i += 1;
    }
    return { leafPaths, endLine: i, arraySuffix: '' };
}
function parseCompositeClosing(line) {
    const stripped = stripPtypeLayoutComment(line).trim();
    const match = stripped.match(/^\}\s*([a-zA-Z_]\w*)?\s*((?:\[[^\]]+\]\s*)*)\s*;?\s*$/);
    if (!match) {
        return undefined;
    }
    return {
        fieldName: match[1],
        arraySuffix: match[2]?.trim() ?? ''
    };
}
function parseLeafFieldPaths(line) {
    const declaration = stripPtypeLayoutComment(line).trim();
    if (!declaration || !declaration.endsWith(';')) {
        return [];
    }
    if (/^(public|private|protected)\s*:\s*$/i.test(declaration)
        || /^static\b/i.test(declaration)
        || /^typedef\b/i.test(declaration)
        || declaration.startsWith('}')
        || declaration.includes('{')) {
        return [];
    }
    if (declaration.includes('(')) {
        return [];
    }
    const fieldMatch = declaration
        .replace(/;\s*$/, '')
        .match(/([a-zA-Z_]\w*)((?:\s*\[[^\]]+\]\s*)*)\s*(?::\s*\d+)?\s*$/);
    if (!fieldMatch) {
        return [];
    }
    return expandArrayFieldPaths(fieldMatch[1], fieldMatch[2]?.trim() ?? '');
}
function expandArrayFieldPaths(fieldName, arraySuffix) {
    if (!arraySuffix) {
        return [fieldName];
    }
    const dims = [...arraySuffix.matchAll(/\[([^\]]+)\]/g)]
        .map((match) => match[1].trim())
        .map((value) => (/^\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN));
    if (!dims.length || dims.some((dim) => !Number.isFinite(dim) || dim <= 0)) {
        return [fieldName];
    }
    const MAX_EXPANDED_ARRAY_ELEMENTS = 64;
    let suffixes = [''];
    for (const dim of dims) {
        if (suffixes.length * dim > MAX_EXPANDED_ARRAY_ELEMENTS) {
            return [fieldName];
        }
        const next = [];
        for (const suffix of suffixes) {
            for (let index = 0; index < dim; index += 1) {
                next.push(`${suffix}[${index}]`);
            }
        }
        suffixes = next;
    }
    return suffixes.map((suffix) => `${fieldName}${suffix}`);
}
function parseFlatMemberNames(ptypeOutput) {
    const braceStart = ptypeOutput.indexOf('{');
    const braceEnd = ptypeOutput.lastIndexOf('}');
    if (braceStart < 0 || braceEnd < 0 || braceStart >= braceEnd) {
        return [];
    }
    const names = [];
    let depth = 0;
    let current = '';
    for (let i = braceStart + 1; i < braceEnd; i += 1) {
        const ch = ptypeOutput[i];
        if (ch === '{') {
            depth += 1;
        }
        else if (ch === '}') {
            depth -= 1;
        }
        else if (ch === ';' && depth === 0) {
            const name = extractFlatMemberName(current);
            if (name) {
                names.push(name);
            }
            current = '';
        }
        else if (depth === 0) {
            current += ch;
        }
    }
    return names;
}
function extractFlatMemberName(declaration) {
    const trimmed = declaration.trim();
    if (!trimmed || trimmed.endsWith('}') || /^(public|private|protected)\s*:\s*$/i.test(trimmed)) {
        return undefined;
    }
    const tokens = trimmed.split(/\s+/);
    let last = tokens[tokens.length - 1];
    const bracket = last.indexOf('[');
    if (bracket > 0) {
        last = last.substring(0, bracket);
    }
    const colon = last.indexOf(':');
    if (colon > 0) {
        last = last.substring(0, colon);
    }
    if (last && /^[a-zA-Z_]\w*$/.test(last)) {
        return last;
    }
    return undefined;
}
function stripPtypeLayoutComment(line) {
    return line.replace(/^\s*\/\*.*?\*\/\s*/, '').trimStart();
}
function joinCompositePath(basePath, childPath) {
    if (!childPath) {
        return basePath;
    }
    return childPath.startsWith('[') ? `${basePath}${childPath}` : `${basePath}.${childPath}`;
}
function byteSize(dataType) {
    switch (dataType) {
        case 'BOOL':
        case 'INT8':
        case 'UINT8':
            return 1;
        case 'INT16':
        case 'UINT16':
            return 2;
        case 'ENUM':
        case 'INT32':
        case 'UINT32':
        case 'FLOAT':
            return 4;
        case 'INT64':
        case 'UINT64':
        case 'DOUBLE':
            return 8;
    }
}
function toErrMsg(err) {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}
function clampInt(v, min, max) {
    return Math.max(min, Math.min(max, Math.round(v)));
}
function clampUint(v, min, max) {
    if (!Number.isFinite(v))
        return 0;
    const clamped = Math.max(min, Math.min(max, Math.round(v)));
    return clamped >>> 0;
}
/**
 * 检测 ptype /o 输出中的嵌套闭合是否为继承基类子对象。
 * 基类子对象中，} 后的名称是类型名（如 Class_Matrix_f32）而非字段名。
 */
function isLiveCompositeBaseClass(startLine, closingFieldName) {
    const stripped = stripPtypeLayoutComment(startLine).trim();
    const match = stripped.match(/^(?:struct|class|union)\s+(.+?)\s*\{\s*$/i);
    if (!match) {
        return false;
    }
    const inlineTypeName = match[1].trim();
    // 去除模板参数后比较
    const strippedType = inlineTypeName.replace(/<[^>]*>/g, '').trim();
    return strippedType === closingFieldName;
}
//# sourceMappingURL=liveWatchService.js.map