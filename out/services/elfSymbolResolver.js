"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ElfSymbolResolver = void 0;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
class ElfSymbolResolver {
    constructor() {
        this.symbolCache = new Map();
        this.shortNameIndex = new Map();
        this.lastModified = 0;
    }
    async loadSymbols(elfPath) {
        if (!fs_1.default.existsSync(elfPath)) {
            return false;
        }
        const stat = fs_1.default.statSync(elfPath);
        if (this.lastElfPath === elfPath && this.lastModified === stat.mtimeMs && this.symbolCache.size > 0) {
            return true;
        }
        const nm = await this.findNmTool();
        if (!nm) {
            return false;
        }
        const output = await this.runNm(nm, elfPath);
        if (!output) {
            return false;
        }
        this.symbolCache.clear();
        this.shortNameIndex.clear();
        this.parseNmOutput(output);
        this.buildShortNameIndex();
        this.lastElfPath = elfPath;
        this.lastModified = stat.mtimeMs;
        return this.symbolCache.size > 0;
    }
    resolveVariable(varName) {
        const direct = this.symbolCache.get(varName);
        if (direct) {
            const dt = this.inferDataTypeFromSize(direct.size);
            return { name: varName, address: direct.address, dataType: dt, byteSize: this.byteSize(dt) };
        }
        const candidates = this.shortNameIndex.get(varName);
        if (candidates && candidates.length > 0) {
            const matched = this.symbolCache.get(candidates[0]);
            if (matched) {
                const dt = this.inferDataTypeFromSize(matched.size);
                return { name: varName, address: matched.address, dataType: dt, byteSize: this.byteSize(dt) };
            }
        }
        return undefined;
    }
    getSymbolCount() {
        return this.symbolCache.size;
    }
    isLoaded() {
        return this.symbolCache.size > 0;
    }
    clear() {
        this.symbolCache.clear();
        this.shortNameIndex.clear();
        this.lastElfPath = undefined;
        this.lastModified = 0;
    }
    parseNmOutput(output) {
        const withSize = /^([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([A-Za-z])\s+(\S+)$/gm;
        const withoutSize = /^([0-9a-fA-F]+)\s+([A-Za-z])\s+(\S+)$/gm;
        const dataSections = new Set(['B', 'b', 'D', 'd', 'G', 'g', 'S', 's', 'R', 'r', 'C']);
        let m;
        while ((m = withSize.exec(output)) !== null) {
            const addr = Number.parseInt(m[1], 16);
            const size = Number.parseInt(m[2], 16);
            const section = m[3];
            const name = m[4];
            if (!Number.isNaN(addr) && !Number.isNaN(size) && dataSections.has(section) && size > 0) {
                this.symbolCache.set(name, { name, address: addr, size, section });
            }
        }
        while ((m = withoutSize.exec(output)) !== null) {
            const addr = Number.parseInt(m[1], 16);
            const section = m[2];
            const name = m[3];
            if (!Number.isNaN(addr) && dataSections.has(section) && !this.symbolCache.has(name)) {
                this.symbolCache.set(name, { name, address: addr, size: 4, section });
            }
        }
    }
    buildShortNameIndex() {
        for (const fullName of this.symbolCache.keys()) {
            const idx = fullName.lastIndexOf('::');
            if (idx >= 0) {
                const shortName = fullName.slice(idx + 2);
                const list = this.shortNameIndex.get(shortName) ?? [];
                list.push(fullName);
                this.shortNameIndex.set(shortName, list);
            }
        }
    }
    inferDataTypeFromSize(size) {
        switch (size) {
            case 1:
                return 'UINT8';
            case 2:
                return 'INT16';
            case 4:
                return 'FLOAT';
            case 8:
                return 'DOUBLE';
            default:
                return 'INT32';
        }
    }
    byteSize(dt) {
        switch (dt) {
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
    async runNm(nmPath, elfPath) {
        return new Promise((resolve) => {
            const proc = (0, child_process_1.spawn)(nmPath, ['-C', '--print-size', elfPath], { stdio: ['ignore', 'pipe', 'pipe'] });
            const chunks = [];
            const errChunks = [];
            const timeout = setTimeout(() => {
                proc.kill('SIGKILL');
            }, 10000);
            proc.stdout.on('data', (buf) => chunks.push(buf));
            proc.stderr.on('data', (buf) => errChunks.push(buf));
            proc.on('close', (code) => {
                clearTimeout(timeout);
                if (code === 0) {
                    resolve(Buffer.concat(chunks).toString('utf8'));
                    return;
                }
                resolve(undefined);
            });
            proc.on('error', () => {
                clearTimeout(timeout);
                resolve(undefined);
            });
        });
    }
    async findNmTool() {
        const candidates = ['arm-none-eabi-nm', 'arm-none-eabi-nm.exe'];
        for (const cmd of candidates) {
            const ok = await this.checkTool(cmd);
            if (ok) {
                return cmd;
            }
        }
        const common = [
            '/usr/bin/arm-none-eabi-nm',
            '/usr/local/bin/arm-none-eabi-nm',
            'C:\\Program Files (x86)\\GNU Arm Embedded Toolchain\\bin\\arm-none-eabi-nm.exe',
            'C:\\Program Files\\GNU Arm Embedded Toolchain\\bin\\arm-none-eabi-nm.exe'
        ];
        for (const p of common) {
            if (fs_1.default.existsSync(p)) {
                return p;
            }
        }
        const fromEnv = process.env.ARM_NONE_EABI_NM;
        if (fromEnv && fs_1.default.existsSync(fromEnv)) {
            return fromEnv;
        }
        if (this.lastElfPath) {
            const elfDir = path_1.default.dirname(this.lastElfPath);
            const localCandidate = path_1.default.join(elfDir, 'arm-none-eabi-nm');
            if (fs_1.default.existsSync(localCandidate)) {
                return localCandidate;
            }
        }
        return undefined;
    }
    async checkTool(cmd) {
        return new Promise((resolve) => {
            const proc = (0, child_process_1.spawn)(cmd, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
            const t = setTimeout(() => {
                proc.kill('SIGKILL');
                resolve(false);
            }, 3000);
            proc.on('close', (code) => {
                clearTimeout(t);
                resolve(code === 0);
            });
            proc.on('error', () => {
                clearTimeout(t);
                resolve(false);
            });
        });
    }
}
exports.ElfSymbolResolver = ElfSymbolResolver;
//# sourceMappingURL=elfSymbolResolver.js.map