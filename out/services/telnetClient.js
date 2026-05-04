"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelnetClient = void 0;
const net_1 = __importDefault(require("net"));
class TelnetClient {
    constructor() {
        this.buffer = '';
    }
    async connect(host, port) {
        await this.close();
        await new Promise((resolve, reject) => {
            const socket = net_1.default.createConnection({ host, port }, () => resolve());
            this.socket = socket;
            socket.setEncoding('utf8');
            socket.setNoDelay(true);
            socket.on('data', (chunk) => {
                this.buffer += chunk.toString();
                this.tryResolvePending();
            });
            socket.on('error', (err) => {
                if (this.pending) {
                    const p = this.pending;
                    this.pending = undefined;
                    clearTimeout(p.timer);
                    p.reject(err);
                }
            });
            socket.on('close', () => {
                if (this.pending) {
                    const p = this.pending;
                    this.pending = undefined;
                    clearTimeout(p.timer);
                    p.reject(new Error('Telnet socket closed'));
                }
            });
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error(`Telnet connect timeout: ${host}:${port}`));
            }, 2000);
            socket.once('connect', () => {
                clearTimeout(timer);
            });
            socket.once('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
        await this.sleep(100);
        this.buffer = '';
    }
    async sendBatch(commands, timeoutMs = 800) {
        const socket = this.socket;
        if (!socket) {
            throw new Error('Telnet not connected');
        }
        if (this.pending) {
            throw new Error('Telnet busy');
        }
        if (!commands.length) {
            return [];
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending) {
                    this.pending = undefined;
                    reject(new Error('Telnet response timeout'));
                }
            }, timeoutMs);
            this.pending = {
                expectedPrompts: commands.length,
                resolve,
                reject,
                timer
            };
            const payload = commands.map((cmd) => `${cmd.trim()}\n`).join('');
            socket.write(payload);
            this.tryResolvePending();
        });
    }
    async close() {
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending.reject(new Error('Telnet closed'));
            this.pending = undefined;
        }
        if (!this.socket) {
            return;
        }
        const s = this.socket;
        this.socket = undefined;
        this.buffer = '';
        await new Promise((resolve) => {
            s.once('close', () => resolve());
            s.end();
            setTimeout(() => {
                s.destroy();
                resolve();
            }, 200);
        });
    }
    tryResolvePending() {
        if (!this.pending) {
            return;
        }
        const segments = this.buffer.split('> ');
        const promptCount = segments.length - 1;
        if (promptCount < this.pending.expectedPrompts) {
            return;
        }
        const done = this.pending;
        this.pending = undefined;
        clearTimeout(done.timer);
        const responses = segments.slice(0, done.expectedPrompts).map((s) => s.trim());
        this.buffer = segments.slice(done.expectedPrompts).join('> ');
        done.resolve(responses);
    }
    async sleep(ms) {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }
}
exports.TelnetClient = TelnetClient;
//# sourceMappingURL=telnetClient.js.map