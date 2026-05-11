"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenOcdTclClient = void 0;
const net_1 = __importDefault(require("net"));
class OpenOcdTclClient {
    constructor(host = '127.0.0.1', port = 6666) {
        this.host = host;
        this.port = port;
        this.socket = null;
        this.connected = false;
        this.pendingResolve = null;
        this.pendingReject = null;
        this.pendingCommand = null;
        this.pendingTimer = null;
        this.recvBuffer = '';
        this.commandQueue = [];
        this.busy = false;
        this.commandStyle = 'unknown';
    }
    get endpoint() {
        return `${this.host}:${this.port}`;
    }
    async connect() {
        if (this.connected && this.socket) {
            return;
        }
        this.disconnect();
        await new Promise((resolve, reject) => {
            let settled = false;
            const socket = new net_1.default.Socket();
            socket.setEncoding('utf8');
            socket.setTimeout(3000);
            const safeResolve = () => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve();
            };
            const safeReject = (err) => {
                if (settled) {
                    return;
                }
                settled = true;
                reject(err);
            };
            socket.on('connect', () => {
                this.connected = true;
                this.commandStyle = 'unknown';
                socket.setTimeout(0);
                safeResolve();
            });
            socket.on('data', (data) => {
                this.recvBuffer += data;
                let eom = this.recvBuffer.indexOf('\x1a');
                while (eom !== -1) {
                    const response = this.recvBuffer.substring(0, eom);
                    this.recvBuffer = this.recvBuffer.substring(eom + 1);
                    this.resolvePendingCommand(response);
                    eom = this.recvBuffer.indexOf('\x1a');
                }
            });
            socket.on('error', (err) => {
                this.connected = false;
                if (this.pendingReject) {
                    this.rejectPendingCommand(err);
                }
                safeReject(new Error(`Failed to connect to OpenOCD TCL at ${this.endpoint}: ${err.message}`));
            });
            socket.on('close', () => {
                this.connected = false;
                this.socket = null;
                if (this.pendingReject) {
                    this.rejectPendingCommand(new Error('OpenOCD TCL connection closed'));
                }
                while (this.commandQueue.length > 0) {
                    this.commandQueue.shift()?.reject(new Error('OpenOCD TCL connection closed'));
                }
                this.busy = false;
            });
            socket.on('timeout', () => {
                socket.destroy();
                safeReject(new Error(`Connection timeout to OpenOCD TCL at ${this.endpoint}`));
            });
            socket.connect(this.port, this.host);
            this.socket = socket;
        });
    }
    disconnect() {
        if (this.pendingReject) {
            this.rejectPendingCommand(new Error('OpenOCD TCL disconnected'));
        }
        while (this.commandQueue.length > 0) {
            this.commandQueue.shift()?.reject(new Error('OpenOCD TCL disconnected'));
        }
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
        this.recvBuffer = '';
        this.pendingResolve = null;
        this.pendingReject = null;
        this.pendingCommand = null;
        this.clearPendingTimer();
        this.busy = false;
        this.commandStyle = 'unknown';
    }
    async readMemory32(address, wordCount) {
        const response = await this.executeOcd(`mdw 0x${address.toString(16)} ${wordCount}`);
        return this.parseMemoryReadResponse(response, address, wordCount, 4);
    }
    async readMemory16(address, halfwordCount) {
        const response = await this.executeOcd(`mdh 0x${address.toString(16)} ${halfwordCount}`);
        return this.parseMemoryReadResponse(response, address, halfwordCount, 2);
    }
    async readMemory8(address, byteCount) {
        const response = await this.executeOcd(`mdb 0x${address.toString(16)} ${byteCount}`);
        return this.parseMemoryReadResponse(response, address, byteCount, 1);
    }
    async writeMemory32(address, value) {
        await this.executeOcd(`mww 0x${address.toString(16)} 0x${(value >>> 0).toString(16)}`);
    }
    async writeMemory16(address, value) {
        await this.executeOcd(`mwh 0x${address.toString(16)} 0x${(value & 0xffff).toString(16)}`);
    }
    async writeMemory8(address, value) {
        await this.executeOcd(`mwb 0x${address.toString(16)} 0x${(value & 0xff).toString(16)}`);
    }
    execute(command) {
        return new Promise((resolve, reject) => {
            if (!this.connected || !this.socket) {
                reject(new Error('OpenOCD TCL not connected'));
                return;
            }
            this.commandQueue.push({ cmd: command, resolve, reject });
            this.drainQueue();
        });
    }
    async executeOcd(commandWithoutPrefix) {
        if (this.commandStyle === 'ocd') {
            return this.execute(`ocd_${commandWithoutPrefix}`);
        }
        if (this.commandStyle === 'capture') {
            return this.executeCaptureCommand(commandWithoutPrefix);
        }
        const ocdResponse = await this.execute(`ocd_${commandWithoutPrefix}`);
        if (!this.isInvalidCommandResponse(ocdResponse, 'ocd_')) {
            this.commandStyle = 'ocd';
            return ocdResponse;
        }
        const captureResponse = await this.executeCaptureCommand(commandWithoutPrefix);
        if (!this.isInvalidCommandResponse(captureResponse, 'capture')) {
            this.commandStyle = 'capture';
            return captureResponse;
        }
        throw new Error(`OpenOCD TCL at ${this.endpoint} does not support quiet memory commands (ocd_* / capture).`);
    }
    executeCaptureCommand(commandWithoutPrefix) {
        const marker = `__waveform_${++OpenOcdTclClient.captureMarkerSeq}__`;
        return this.execute(`capture {echo ${marker}; ${commandWithoutPrefix}}`)
            .then((response) => this.stripCaptureMarker(response, marker, commandWithoutPrefix));
    }
    stripCaptureMarker(response, marker, command) {
        const idx = response.indexOf(marker);
        if (idx < 0) {
            throw new Error(`Missing capture marker for OpenOCD command "${command}". Raw: ${response.trim()}`);
        }
        let payload = response.substring(idx + marker.length);
        payload = payload.replace(/^\r?\n/, '');
        return payload;
    }
    isInvalidCommandResponse(resp, marker) {
        const lower = (resp || '').toLowerCase();
        if (marker && lower.includes(`invalid command name "${marker.toLowerCase()}`)) {
            return true;
        }
        return (lower.includes('invalid command name') ||
            lower.includes('unknown command') ||
            lower.includes('unknown or ambiguous command') ||
            lower.includes('wrong # args'));
    }
    drainQueue() {
        if (this.busy || this.commandQueue.length === 0 || !this.socket || !this.connected) {
            return;
        }
        const item = this.commandQueue.shift();
        this.busy = true;
        this.pendingCommand = item.cmd;
        this.pendingResolve = item.resolve;
        this.pendingReject = item.reject;
        this.pendingTimer = setTimeout(() => {
            const message = this.pendingCommand
                ? `OpenOCD TCL command timed out after ${OpenOcdTclClient.COMMAND_TIMEOUT_MS} ms: ${this.pendingCommand}`
                : `OpenOCD TCL command timed out after ${OpenOcdTclClient.COMMAND_TIMEOUT_MS} ms`;
            this.rejectPendingCommand(new Error(message));
            this.disconnect();
        }, OpenOcdTclClient.COMMAND_TIMEOUT_MS);
        this.socket.write(item.cmd + '\x1a');
    }
    resolvePendingCommand(response) {
        if (!this.pendingResolve) {
            return;
        }
        const resolve = this.pendingResolve;
        this.pendingResolve = null;
        this.pendingReject = null;
        this.pendingCommand = null;
        this.clearPendingTimer();
        this.busy = false;
        resolve(response);
        this.drainQueue();
    }
    rejectPendingCommand(err) {
        if (!this.pendingReject) {
            this.pendingResolve = null;
            this.pendingCommand = null;
            this.clearPendingTimer();
            this.busy = false;
            return;
        }
        const reject = this.pendingReject;
        this.pendingResolve = null;
        this.pendingReject = null;
        this.pendingCommand = null;
        this.clearPendingTimer();
        this.busy = false;
        reject(err);
    }
    clearPendingTimer() {
        if (this.pendingTimer) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }
    }
    parseMemoryReadResponse(response, requestAddress, requestCount, unitBytes) {
        if (/invalid command name/i.test(response)) {
            throw new Error(response.trim());
        }
        const valueByAddress = new Map();
        const lines = response.trim().split('\n');
        const memLineRegex = /^\s*0x([0-9a-fA-F]+)\s*:\s*(.+)$/;
        let firstLineAddr = null;
        for (const line of lines) {
            const match = line.match(memLineRegex);
            if (!match) {
                continue;
            }
            let lineAddr = Number.parseInt(match[1], 16) >>> 0;
            if (firstLineAddr === null) {
                firstLineAddr = lineAddr;
            }
            const items = match[2].trim().split(/\s+/);
            for (const item of items) {
                const token = item.replace(/^0x/i, '');
                if (!/^[0-9a-fA-F]+$/.test(token)) {
                    lineAddr = (lineAddr + unitBytes) >>> 0;
                    continue;
                }
                valueByAddress.set(lineAddr, Number.parseInt(token, 16) >>> 0);
                lineAddr = (lineAddr + unitBytes) >>> 0;
            }
        }
        const normalizedRequestAddr = requestAddress >>> 0;
        if (firstLineAddr === null || firstLineAddr !== normalizedRequestAddr) {
            throw new Error(`Unexpected OpenOCD read start address (expected 0x${normalizedRequestAddr.toString(16)}, got ${firstLineAddr === null ? 'none' : `0x${firstLineAddr.toString(16)}`}). Raw: ${response.trim()}`);
        }
        const ordered = [];
        for (let i = 0; i < requestCount; i += 1) {
            const addr = (requestAddress + i * unitBytes) >>> 0;
            const value = valueByAddress.get(addr);
            if (value === undefined) {
                throw new Error(`Incomplete OpenOCD read response at 0x${addr.toString(16)} (requested ${requestCount} x ${unitBytes}-byte units from 0x${requestAddress.toString(16)}). Raw: ${response.trim()}`);
            }
            ordered.push(value);
        }
        return ordered;
    }
}
exports.OpenOcdTclClient = OpenOcdTclClient;
OpenOcdTclClient.COMMAND_TIMEOUT_MS = 3000;
OpenOcdTclClient.captureMarkerSeq = 0;
//# sourceMappingURL=openOcdTclClient.js.map