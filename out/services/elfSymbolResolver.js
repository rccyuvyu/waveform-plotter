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
        this.typeCache = new Map();
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
        this.typeCache.clear();
        this.parseNmOutput(output);
        this.buildShortNameIndex();
        this.lastElfPath = elfPath;
        this.lastModified = stat.mtimeMs;
        return this.symbolCache.size > 0;
    }
    async resolveVariable(varName) {
        const match = this.findSymbol(varName);
        if (!match) {
            return undefined;
        }
        return this.buildEntry(varName, match);
    }
    findSymbol(varName) {
        const direct = this.symbolCache.get(varName);
        if (direct) {
            return { symbolName: varName, info: direct };
        }
        const candidates = this.shortNameIndex.get(varName);
        if (candidates && candidates.length > 0) {
            const matchedName = candidates[0];
            const matched = this.symbolCache.get(matchedName);
            if (matched) {
                return { symbolName: matchedName, info: matched };
            }
        }
        return undefined;
    }
    async buildEntry(name, match) {
        const { symbolName, info } = match;
        const exactType = await this.inferDataTypeFromDebug(symbolName, info.size);
        const dt = exactType ?? this.inferDataTypeFromSize(info.size);
        if (!dt) {
            return undefined;
        }
        return { name, address: info.address, dataType: dt, byteSize: this.byteSize(dt) };
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
        this.typeCache.clear();
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
                return 'INT32';
            case 8:
                return 'DOUBLE';
            default:
                return undefined;
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
    async inferDataTypeFromDebug(symbolName, fallbackSize) {
        if (!this.lastElfPath || !fs_1.default.existsSync(this.lastElfPath)) {
            return undefined;
        }
        const cacheKey = `${this.lastElfPath}:${this.lastModified}:${symbolName}`;
        if (this.typeCache.has(cacheKey)) {
            return this.typeCache.get(cacheKey) ?? undefined;
        }
        const gdb = await this.findGdbTool();
        if (!gdb) {
            return undefined;
        }
        const output = await this.runGdbInspect(gdb, this.lastElfPath, symbolName);
        if (!output) {
            this.typeCache.set(cacheKey, null);
            return undefined;
        }
        const whatisMatch = output.match(/type\s*=\s*(.+)/i);
        const sizeMatch = output.match(/\$\d+\s*=\s*(\d+)/);
        const dataType = inferDataType(whatisMatch?.[1]?.trim() ?? '', sizeMatch?.[1] ?? String(fallbackSize));
        this.typeCache.set(cacheKey, dataType ?? null);
        return dataType ?? undefined;
    }
    async runGdbInspect(gdbPath, elfPath, symbolName) {
        return new Promise((resolve) => {
            const args = [
                '-q',
                '--batch',
                elfPath,
                '-ex',
                'set pagination off',
                '-ex',
                `whatis ${symbolName}`,
                '-ex',
                `print (int)sizeof(${symbolName})`
            ];
            const proc = (0, child_process_1.spawn)(gdbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            const stdoutChunks = [];
            const stderrChunks = [];
            const timeout = setTimeout(() => {
                proc.kill('SIGKILL');
            }, 10000);
            proc.stdout.on('data', (buf) => stdoutChunks.push(buf));
            proc.stderr.on('data', (buf) => stderrChunks.push(buf));
            proc.on('close', (code) => {
                clearTimeout(timeout);
                if (code === 0) {
                    resolve(Buffer.concat(stdoutChunks).toString('utf8'));
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
    async findGdbTool() {
        const candidates = ['arm-none-eabi-gdb', 'arm-none-eabi-gdb.exe'];
        for (const cmd of candidates) {
            const ok = await this.checkTool(cmd);
            if (ok) {
                return cmd;
            }
        }
        const common = [
            '/usr/bin/arm-none-eabi-gdb',
            '/usr/local/bin/arm-none-eabi-gdb',
            'C:\\Program Files (x86)\\GNU Arm Embedded Toolchain\\bin\\arm-none-eabi-gdb.exe',
            'C:\\Program Files\\GNU Arm Embedded Toolchain\\bin\\arm-none-eabi-gdb.exe'
        ];
        for (const p of common) {
            if (fs_1.default.existsSync(p)) {
                return p;
            }
        }
        const fromEnv = process.env.ARM_NONE_EABI_GDB;
        if (fromEnv && fs_1.default.existsSync(fromEnv)) {
            return fromEnv;
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
function inferDataType(typeText, sizeText) {
    const lower = typeText.toLowerCase();
    if (/^(struct|class|union)\b/.test(lower)) {
        return undefined;
    }
    const size = Number.parseInt(sizeText, 10);
    const byteSize = Number.isFinite(size) && size > 0 ? size : 0;
    const isFloat = /\bfloat\b/.test(lower);
    const isDouble = /\bdouble\b/.test(lower);
    const isUnsigned = /\bunsigned\b|\buint\d*_t\b|\bbool\b/.test(lower);
    if (isDouble) {
        return 'DOUBLE';
    }
    if (isFloat) {
        return 'FLOAT';
    }
    if (byteSize === 1) {
        return isUnsigned ? 'UINT8' : 'INT8';
    }
    if (byteSize === 2) {
        return isUnsigned ? 'UINT16' : 'INT16';
    }
    if (byteSize === 4) {
        return isUnsigned ? 'UINT32' : 'INT32';
    }
    if (byteSize === 8) {
        return 'DOUBLE';
    }
    return undefined;
}
//# sourceMappingURL=elfSymbolResolver.js.map