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
    async findTelnetPort(preferredPort, hintPorts = [], maxRounds = 4) {
        const candidates = this.buildCandidates(preferredPort, hintPorts);
        for (let round = 0; round < maxRounds; round += 1) {
            for (const port of candidates) {
                const ok = await this.isOpenOcdTelnetPort(port);
                if (ok) {
                    return port;
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
        const push = (p) => {
            if (Number.isInteger(p) && p >= MIN_PORT && p <= MAX_PORT) {
                unique.add(p);
            }
        };
        const addAround = (center, delta) => {
            for (let d = -delta; d <= delta; d += 1) {
                push(center + d);
            }
        };
        push(preferredPort);
        push(4444);
        for (const h of hints) {
            push(h);
        }
        addAround(preferredPort, 5);
        addAround(4444, 40);
        for (const h of hints) {
            addAround(h, 3);
        }
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
            }, 1200);
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
    looksLikeOpenOcd(text) {
        const lower = text.toLowerCase();
        const hasPrompt = /(^|\r|\n)>\s*$/.test(text);
        return (lower.includes('open on-chip debugger') ||
            lower.includes('openocd') ||
            lower.includes('telnet_port') ||
            lower.includes('telnet port') ||
            hasPrompt);
    }
    async sleep(ms) {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }
}
exports.OpenOcdPortDetector = OpenOcdPortDetector;
//# sourceMappingURL=openocdPortDetector.js.map