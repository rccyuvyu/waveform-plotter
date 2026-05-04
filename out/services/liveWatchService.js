"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LiveWatchService = void 0;
const passiveCollector_1 = require("./passiveCollector");
const telnetClient_1 = require("./telnetClient");
const elfSymbolResolver_1 = require("./elfSymbolResolver");
const sampleRateMeter_1 = require("./sampleRateMeter");
const RESPONSE_PATTERN = /0x[0-9a-fA-F]+:\s+([0-9a-fA-F]+)(?:\s+([0-9a-fA-F]+))?/;
class LiveWatchService {
    constructor(dataBuffer, onData) {
        this.dataBuffer = dataBuffer;
        this.onData = onData;
        this.isRunning = { value: false };
        this.elfResolver = new elfSymbolResolver_1.ElfSymbolResolver();
        this.sampleCount = 0;
        this.sampleRateMeter = new sampleRateMeter_1.SampleRateMeter();
        this.watchEntries = new Map();
        this.sampleBusy = false;
        this.loopGeneration = 0;
    }
    getResolvedEntries() {
        return Object.fromEntries(this.watchEntries.entries());
    }
    clearResolvedEntries() {
        this.watchEntries.clear();
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
        }
    }
    dumpResolvedEntries() {
        const out = {};
        for (const [name, entry] of this.watchEntries.entries()) {
            out[name] = `0x${entry.address.toString(16)}:${entry.dataType}`;
        }
        return out;
    }
    async resolveFromElf(elfPath, varNames) {
        const ok = await this.elfResolver.loadSymbols(elfPath);
        if (!ok) {
            return 0;
        }
        let count = 0;
        for (const name of varNames) {
            if (this.watchEntries.has(name)) {
                count += 1;
                continue;
            }
            const entry = this.elfResolver.resolveVariable(name);
            if (entry) {
                this.watchEntries.set(name, entry);
                count += 1;
            }
        }
        return count;
    }
    async resolveVariables(session, varNames, threadId) {
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
            if (this.watchEntries.has(name)) {
                count += 1;
                continue;
            }
            const entry = await this.resolveSingle(session, name, frameId);
            if (entry) {
                this.watchEntries.set(name, entry);
                count += 1;
            }
        }
        return count;
    }
    /**
     * 对已解析变量进行类型复核（地址保持不变），用于修正 ELF 仅按 size 猜类型导致的误判。
     */
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
            const type = await this.queryDataType(session, name, frameId);
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
        const client = new telnetClient_1.TelnetClient();
        try {
            await client.connect('127.0.0.1', telnetPort);
            this.client = client;
        }
        catch (err) {
            this.lastError = `Cannot connect OpenOCD telnet:${telnetPort} (${toErrMsg(err)})`;
            this.isRunning.value = false;
            await client.close();
            return;
        }
        const intervalMs = Math.max(1, Math.floor(1000 / Math.max(1, frequencyHz)));
        const generation = ++this.loopGeneration;
        void this.runLoop(intervalMs, generation);
    }
    async stopLiveWatch() {
        this.isRunning.value = false;
        this.loopGeneration += 1;
        if (this.client) {
            await this.client.close();
            this.client = undefined;
        }
        this.sampleBusy = false;
        this.sampleRateMeter.reset();
    }
    getActualFrequencyHz() {
        return this.sampleRateMeter.getHz();
    }
    async runLoop(intervalMs, generation) {
        while (this.isRunning.value && generation === this.loopGeneration) {
            const startNs = process.hrtime.bigint();
            await this.sampleOnce();
            const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
            const waitMs = Math.max(0, intervalMs - elapsedMs);
            if (waitMs > 0) {
                await sleep(waitMs);
            }
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
        if (entries.length === 0) {
            return;
        }
        this.sampleBusy = true;
        try {
            const commands = entries.map((entry) => buildTelnetReadCommand(entry));
            const responses = await client.sendBatch(commands, 700);
            if (responses.length !== entries.length) {
                return;
            }
            const values = new Map();
            for (let i = 0; i < entries.length; i += 1) {
                const entry = entries[i];
                const raw = parseOpenocdResponse(responses[i], entry.dataType);
                if (raw === undefined) {
                    continue;
                }
                const parsed = interpretBytes(raw, entry.dataType);
                values.set(entry.name, parsed);
            }
            if (values.size > 0) {
                for (const name of values.keys()) {
                    if (!this.dataBuffer.getChannels().some((c) => c.name === name)) {
                        this.dataBuffer.addChannel(name);
                    }
                }
                const nowNs = process.hrtime.bigint();
                this.dataBuffer.pushAll(values, nowNs);
                this.sampleCount += 1;
                this.sampleRateMeter.mark(nowNs);
                this.lastError = undefined;
                this.onData();
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
            const addrResult = (await session.customRequest('evaluate', {
                expression: `print/x (unsigned long)&${varName}`,
                frameId,
                context: 'repl'
            }));
            const address = parseAddressFromPrint(addrResult.result ?? '');
            if (address === undefined) {
                return undefined;
            }
            const dataType = await this.queryDataType(session, varName, frameId);
            if (!dataType) {
                return undefined;
            }
            return {
                name: varName,
                address,
                dataType,
                byteSize: byteSize(dataType)
            };
        }
        catch {
            return undefined;
        }
    }
    async queryDataType(session, varName, frameId) {
        try {
            const typeResult = (await session.customRequest('evaluate', {
                expression: `ptype ${varName}`,
                frameId,
                context: 'repl'
            }));
            const sizeResult = (await session.customRequest('evaluate', {
                expression: `print (int)sizeof(${varName})`,
                frameId,
                context: 'repl'
            }));
            return inferDataType(typeResult.result ?? '', sizeResult.result ?? '');
        }
        catch {
            return undefined;
        }
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
}
exports.LiveWatchService = LiveWatchService;
async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
function buildTelnetReadCommand(entry) {
    const addr = `0x${entry.address.toString(16)}`;
    switch (entry.dataType) {
        case 'INT8':
        case 'UINT8':
            return `mdb ${addr} 1`;
        case 'INT16':
        case 'UINT16':
            return `mdh ${addr} 1`;
        case 'INT32':
        case 'UINT32':
        case 'FLOAT':
            return `mdw ${addr} 1`;
        case 'DOUBLE':
            return `mdw ${addr} 2`;
    }
}
function parseOpenocdResponse(response, dt) {
    const m = response.match(RESPONSE_PATTERN);
    if (!m) {
        return undefined;
    }
    const low = BigInt(`0x${m[1]}`);
    if (dt === 'DOUBLE' && m[2]) {
        const high = BigInt(`0x${m[2]}`);
        return (high << 32n) | low;
    }
    return low;
}
function interpretBytes(rawValue, dataType) {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    switch (dataType) {
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
        case 'UINT32':
            return Number(rawValue & 0xffffffffn);
        case 'INT32': {
            const v = Number(rawValue & 0xffffffffn);
            return v > 0x7fffffff ? v - 0x100000000 : v;
        }
        case 'FLOAT':
            view.setUint32(0, Number(rawValue & 0xffffffffn), true);
            return view.getFloat32(0, true);
        case 'DOUBLE':
            view.setBigUint64(0, rawValue, true);
            return view.getFloat64(0, true);
    }
}
function parseAddressFromPrint(result) {
    const hex = result.match(/\$\d+\s*=\s*0x([0-9a-fA-F]+)/);
    if (hex) {
        return Number.parseInt(hex[1], 16);
    }
    const dec = result.match(/\$\d+\s*=\s*(\d+)/);
    if (dec) {
        return Number.parseInt(dec[1], 10);
    }
    const fallback = (0, passiveCollector_1.parseDebuggerNumber)(result);
    if (fallback !== undefined) {
        return Math.floor(fallback);
    }
    return undefined;
}
function inferDataType(ptypeResult, sizeResult) {
    const lower = ptypeResult.toLowerCase();
    const size = (0, passiveCollector_1.parseDebuggerNumber)(sizeResult) ?? 4;
    const byteSizeValue = Math.max(1, Math.round(size));
    const isFloat = lower.includes('float');
    const isDouble = lower.includes('double');
    const isUnsigned = lower.includes('unsigned');
    if (isDouble || byteSizeValue === 8) {
        return 'DOUBLE';
    }
    if (isFloat) {
        return 'FLOAT';
    }
    if (byteSizeValue === 1) {
        return isUnsigned ? 'UINT8' : 'INT8';
    }
    if (byteSizeValue === 2) {
        return isUnsigned ? 'UINT16' : 'INT16';
    }
    return isUnsigned ? 'UINT32' : 'INT32';
}
function byteSize(dataType) {
    switch (dataType) {
        case 'INT8':
        case 'UINT8':
            return 1;
        case 'INT16':
        case 'UINT16':
            return 2;
        case 'INT32':
        case 'UINT32':
        case 'FLOAT':
            return 4;
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
//# sourceMappingURL=liveWatchService.js.map