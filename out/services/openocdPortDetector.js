"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenOcdPortDetector = void 0;
const net_1 = __importDefault(require("net"));
const MIN_PORT = 1;
const MAX_PORT = 65535;
class OpenOcdPortDetector {
    constructor(host = '127.0.0.1') {
        this.host = host;
    }
    async findTelnetPort(preferredPort, hintPorts = [], maxRounds = 2) {
        const candidates = this.buildCandidates(preferredPort, hintPorts);
        for (let round = 0; round < maxRounds; round += 1) {
            for (const port of candidates) {
                const ok = await this.isOpenOcdTelnetPort(port);
                if (ok) {
                    // 检测到 OpenOCD 后，验证目标连接是否可用
                    const usable = await this.verifyTargetAccess(port);
                    if (usable) {
                        return port;
                    }
                }
            }
            if (round < maxRounds - 1) {
                await this.sleep(250);
            }
        }
        return undefined;
    }
    buildCandidates(preferredPort, hints) {
        const unique = new Set();
        const push = (port) => {
            if (Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT) {
                unique.add(port);
            }
        };
        push(preferredPort);
        // 提示端口（如 cortex-debug 自定义端口）优先于默认 4444
        for (const hint of hints) {
            push(hint);
        }
        push(4444);
        return [...unique];
    }
    async isOpenOcdTelnetPort(port) {
        return new Promise((resolve) => {
            const socket = net_1.default.createConnection({ host: this.host, port });
            let settled = false;
            let buffer = '';
            let connected = false;
            const done = (ok) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                socket.removeAllListeners();
                try {
                    socket.end();
                    socket.destroy();
                }
                catch {
                    // ignore
                }
                resolve(ok);
            };
            const timer = setTimeout(() => {
                done(this.looksLikeOpenOcd(buffer));
            }, 500);
            socket.setEncoding('utf8');
            socket.setNoDelay(true);
            socket.on('connect', () => {
                connected = true;
            });
            socket.on('data', (chunk) => {
                buffer += chunk;
                if (this.looksLikeOpenOcd(buffer)) {
                    done(true);
                }
            });
            socket.on('error', () => done(false));
            socket.on('close', () => done(connected && this.looksLikeOpenOcd(buffer)));
        });
    }
    /** 验证目标连接：发送 targets 命令检查是否有已连接的目标 */
    async verifyTargetAccess(port) {
        return new Promise((resolve) => {
            const socket = net_1.default.createConnection({ host: this.host, port });
            let settled = false;
            let buffer = '';
            const done = (ok) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                socket.removeAllListeners();
                try {
                    socket.end();
                    socket.destroy();
                }
                catch { /* ignore */ }
                resolve(ok);
            };
            const timer = setTimeout(() => done(false), 2000);
            socket.setEncoding('utf8');
            socket.setNoDelay(true);
            socket.on('connect', () => {
                // OpenOCD telnet 连接后立即出现提示符，发送 targets 命令
                setTimeout(() => {
                    try {
                        socket.write('targets\n');
                    }
                    catch {
                        done(false);
                    }
                }, 100);
            });
            socket.on('data', (chunk) => {
                buffer += chunk;
                // 如果包含目标名称（如 "cortex-m"、"stm32" 等）或显示 "halted"，
                // 说明有目标连接
                if (/[a-zA-Z0-9_]+/.test(buffer) && buffer.includes('> ')) {
                    const hasTarget = !buffer.toLowerCase().includes('no target') &&
                        !buffer.includes('Error connecting DP') &&
                        !buffer.includes('Failed to read memory');
                    done(hasTarget);
                }
            });
            socket.on('error', () => done(false));
            socket.on('close', () => done(false));
        });
    }
    looksLikeOpenOcd(text) {
        const lower = text.toLowerCase();
        return (lower.includes('open on-chip debugger') ||
            lower.includes('openocd'));
    }
    async sleep(ms) {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }
}
exports.OpenOcdPortDetector = OpenOcdPortDetector;
//# sourceMappingURL=openocdPortDetector.js.map