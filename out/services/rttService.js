"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RttService = void 0;
const net_1 = __importDefault(require("net"));
const telnetClient_1 = require("./telnetClient");
class RttService {
    constructor(dataBuffer, onData) {
        this.dataBuffer = dataBuffer;
        this.onData = onData;
        this.isRunning = { value: false };
        this.sampleCount = 0;
        this.readerBuffer = '';
        this.channelNames = [];
        this.lastCallbackNs = 0n;
        this.defaultRamRegions = [
            ['0x20000000', '0x10000'],
            ['0x24000000', '0x18000'],
            ['0x20010000', '0x10000'],
            ['0x30000000', '0x10000']
        ];
    }
    async initOpenOcdRtt(telnetPort, rttPort, ramStart, ramSize) {
        const client = new telnetClient_1.TelnetClient();
        try {
            await client.connect('127.0.0.1', telnetPort);
            await client.sendBatch(['rtt stop'], 500);
            const regions = this.buildRegionCandidates(ramStart, ramSize);
            let found = false;
            for (const [start, size] of regions) {
                await client.sendBatch([`rtt setup ${start} ${size} "SEGGER RTT"`], 500);
                const [startResp] = await client.sendBatch(['rtt start'], 900);
                if (/not found|error/i.test(startResp)) {
                    await client.sendBatch(['rtt stop'], 300);
                    continue;
                }
                const [channelsResp] = await client.sendBatch(['rtt channels'], 700);
                if (/up=0/i.test(channelsResp)) {
                    await client.sendBatch(['rtt stop'], 300);
                    await sleep(250);
                    await client.sendBatch(['rtt start'], 900);
                    const [retryResp] = await client.sendBatch(['rtt channels'], 700);
                    if (/up=0/i.test(retryResp)) {
                        await client.sendBatch(['rtt stop'], 300);
                        continue;
                    }
                }
                found = true;
                this.lastFoundRegion = [start, size];
                break;
            }
            if (!found) {
                this.lastError = 'RTT control block not found in candidate RAM regions';
                return false;
            }
            await client.sendBatch([`rtt server start ${rttPort} 0`], 600);
            await client.sendBatch(['rtt polling_interval 1'], 300);
            this.lastError = undefined;
            return true;
        }
        catch (err) {
            this.lastError = `RTT init failed: ${toErrMsg(err)}`;
            return false;
        }
        finally {
            await client.close();
        }
    }
    async stopOpenOcdRtt(telnetPort) {
        const client = new telnetClient_1.TelnetClient();
        try {
            await client.connect('127.0.0.1', telnetPort);
            await client.sendBatch(['rtt stop'], 300);
        }
        catch {
            // ignore
        }
        finally {
            await client.close();
        }
    }
    async startRtt(host, port, channelNames) {
        if (this.isRunning.value) {
            return;
        }
        this.channelNames = [...channelNames];
        this.sampleCount = 0;
        this.lastError = undefined;
        this.readerBuffer = '';
        this.lastCallbackNs = 0n;
        try {
            const socket = net_1.default.createConnection({ host, port });
            this.socket = socket;
            socket.setEncoding('utf8');
            socket.setNoDelay(true);
            socket.setTimeout(2000);
            socket.on('timeout', () => {
                // expected for low traffic
            });
            await new Promise((resolve, reject) => {
                socket.once('connect', () => resolve());
                socket.once('error', (err) => reject(err));
            });
            this.isRunning.value = true;
            socket.on('data', (chunk) => {
                this.readerBuffer += chunk.toString();
                this.consumeLines();
            });
            socket.on('error', (err) => {
                if (this.isRunning.value) {
                    this.lastError = `RTT read error: ${err.message}`;
                }
            });
            socket.on('close', () => {
                this.isRunning.value = false;
            });
        }
        catch (err) {
            this.lastError = `RTT connect failed: ${toErrMsg(err)}`;
            this.isRunning.value = false;
            this.socket?.destroy();
            this.socket = undefined;
        }
    }
    async stopRtt() {
        this.isRunning.value = false;
        const s = this.socket;
        this.socket = undefined;
        this.readerBuffer = '';
        if (!s) {
            return;
        }
        await new Promise((resolve) => {
            s.once('close', () => resolve());
            s.end();
            setTimeout(() => {
                s.destroy();
                resolve();
            }, 250);
        });
    }
    buildRegionCandidates(ramStart, ramSize) {
        if (ramStart.trim() && ramSize.trim()) {
            return [[ramStart.trim(), ramSize.trim()]];
        }
        const out = [];
        if (this.lastFoundRegion) {
            out.push(this.lastFoundRegion);
        }
        for (const r of this.defaultRamRegions) {
            if (!this.lastFoundRegion || r[0] !== this.lastFoundRegion[0] || r[1] !== this.lastFoundRegion[1]) {
                out.push(r);
            }
        }
        return out;
    }
    consumeLines() {
        while (true) {
            const idx = this.readerBuffer.indexOf('\n');
            if (idx < 0) {
                return;
            }
            const line = this.readerBuffer.slice(0, idx);
            this.readerBuffer = this.readerBuffer.slice(idx + 1);
            this.parseLine(line.trim());
        }
    }
    parseLine(line) {
        if (!line) {
            return;
        }
        const parts = line.split(',');
        const values = new Map();
        for (let i = 0; i < parts.length && i < this.channelNames.length; i += 1) {
            const n = Number(parts[i].trim());
            if (Number.isFinite(n)) {
                values.set(this.channelNames[i], n);
            }
        }
        if (values.size === 0) {
            return;
        }
        for (const name of values.keys()) {
            if (!this.dataBuffer.getChannels().some((c) => c.name === name)) {
                this.dataBuffer.addChannel(name);
            }
        }
        this.dataBuffer.pushAll(values, process.hrtime.bigint());
        this.sampleCount += 1;
        const now = process.hrtime.bigint();
        if (now - this.lastCallbackNs >= 16000000n) {
            this.lastCallbackNs = now;
            this.onData();
        }
    }
}
exports.RttService = RttService;
function toErrMsg(err) {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}
async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=rttService.js.map