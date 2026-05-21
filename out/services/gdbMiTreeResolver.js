"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GdbMiTreeResolver = void 0;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
class GdbResolveFailure extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'GdbResolveFailure';
    }
}
class GdbMiTreeResolver {
    constructor(gdbPath, elfPath) {
        this.gdbPath = gdbPath;
        this.elfPath = elfPath;
        this.resolvedGdbCache = null;
        this.tempVarCounter = 0;
        this.stdoutBuf = '';
    }
    async resolve(variableName) {
        this.assertExpressionIsSafe(variableName);
        const resolvedGdb = this.resolveGdbPath();
        const child = this.spawnGdb(resolvedGdb);
        if (!child) {
            return undefined;
        }
        try {
            const rootMiName = 'v0';
            const createResult = await this.execSync(child, `-var-create ${rootMiName} @ ${this.quoteMiString(variableName)}`);
            if (createResult.cls === 'error') {
                const msg = createResult.message || '';
                if (this.isSymbolMissingMessage(msg) || this.isExpressionInvalidMessage(msg)) {
                    return undefined;
                }
                return undefined;
            }
            const tree = await this.buildTreeFromVarobj(child, rootMiName, variableName, variableName, true);
            await this.execSync(child, `-var-delete ${rootMiName}`);
            return tree;
        }
        catch (err) {
            if (err instanceof GdbResolveFailure && (err.code === 'symbol_not_found' || err.code === 'expression_invalid')) {
                return undefined;
            }
            throw err;
        }
        finally {
            if (child.stdin) {
                child.stdin.end();
            }
            const killTimer = setTimeout(() => { child.kill(); }, 2000);
            child.on('close', () => clearTimeout(killTimer));
        }
    }
    /**
     * 从 MI varobj 名称递归构建树。
     * 对于继承基类子对象（子节点 exp 等于其类型名），跳过该层级，
     * 直接提升其子节点到当前层级，并使用父表达式的路径构建有效 GDB 表达式。
     */
    async buildTreeFromVarobj(gdb, miName, expression, nodeName, isRoot) {
        // 获取类型名
        const createResult = await this.execSync(gdb, `-var-create x @ ${this.quoteMiString(expression)}`);
        const typeName = createResult.cls === 'done'
            ? (this.getMiField(createResult.rawResult, 'type') ?? 'unknown')
            : 'unknown';
        if (createResult.cls === 'done') {
            await this.execSync(gdb, `-var-delete x`);
        }
        // 地址和大小
        const addrResult = await this.execSync(gdb, `-data-evaluate-expression &(${expression})`);
        const address = addrResult.cls === 'done' ? (this.parseAddressFromMiValue(addrResult.value) ?? 0) : 0;
        const sizeResult = await this.execSync(gdb, `-data-evaluate-expression sizeof(${expression})`);
        const parsedSize = sizeResult.cls === 'done' ? this.parseIntegerFromMiValue(sizeResult.value) : null;
        const byteSize = parsedSize !== null ? Math.max(0, parsedSize) : this.guessSize(typeName);
        const node = {
            name: nodeName,
            relativePath: isRoot ? '' : nodeName,
            expression,
            declaredTypeText: this.normalizeTypeName(typeName),
            byteSize,
            address,
            children: []
        };
        // 列出子节点
        const listResult = await this.execSync(gdb, `-var-list-children --all-values ${this.quoteMiString(miName)}`);
        if (listResult.cls !== 'done') {
            await this.populatePointerChildren(gdb, node);
            return node;
        }
        const children = this.parseMiChildren(listResult.rawResult);
        if (children.length === 0 || this.isPointerType(typeName)) {
            await this.populatePointerChildren(gdb, node);
            return node;
        }
        for (const childInfo of children) {
            if (this.isCompositePointerType(childInfo.typeName)) {
                const childExpr = this.composeChildExpr(expression, childInfo.exp);
                const childName = this.displayNameFromMiChildExp(childInfo.exp);
                try {
                    const childNode = await this.buildTreeFromExpression(gdb, childExpr, childName, false);
                    node.children.push(childNode);
                }
                catch {
                    const childAddress = await this.resolveAddress(gdb, childExpr);
                    node.children.push({
                        name: childName,
                        relativePath: childName,
                        expression: childExpr,
                        declaredTypeText: this.normalizeTypeName(childInfo.typeName),
                        byteSize: this.guessSize(childInfo.typeName),
                        address: childAddress,
                        children: []
                    });
                }
                continue;
            }
            if (childInfo.numChild <= 0 || this.isPointerType(childInfo.typeName)) {
                // 叶子节点：直接创建，并解析地址
                const childExpr = this.composeChildExpr(expression, childInfo.exp);
                const childName = this.displayNameFromMiChildExp(childInfo.exp);
                const childAddress = await this.resolveAddress(gdb, childExpr);
                node.children.push({
                    name: childName,
                    relativePath: childName,
                    expression: childExpr,
                    declaredTypeText: this.normalizeTypeName(childInfo.typeName),
                    byteSize: this.guessSize(childInfo.typeName),
                    address: childAddress,
                    children: []
                });
                continue;
            }
            // 检测是否为基类子对象：子节点的 exp 匹配其类型名（去除 class/struct 前缀和模板参数后）
            if (this.isBaseClassSubobject(childInfo)) {
                // 基类子对象：跳过此层级，递归列出其子节点并提升到当前层级
                const gcListResult = await this.execSync(gdb, `-var-list-children --all-values ${this.quoteMiString(childInfo.name)}`);
                if (gcListResult.cls !== 'done') {
                    continue;
                }
                const gcs = this.parseMiChildren(gcListResult.rawResult);
                for (const gc of gcs) {
                    // 使用父节点表达式构造子表达式（跳过基类名）
                    const gcExpr = this.composeChildExpr(expression, gc.exp);
                    const gcName = this.displayNameFromMiChildExp(gc.exp);
                    if (gc.numChild <= 0 || this.isPointerType(gc.typeName)) {
                        const gcAddr = await this.resolveAddress(gdb, gcExpr);
                        node.children.push({
                            name: gcName,
                            relativePath: gcName,
                            expression: gcExpr,
                            declaredTypeText: this.normalizeTypeName(gc.typeName),
                            byteSize: this.guessSize(gc.typeName),
                            address: gcAddr,
                            children: []
                        });
                    }
                    else {
                        const gcNode = await this.buildTreeFromVarobj(gdb, gc.name, gcExpr, gcName, false);
                        node.children.push(gcNode);
                    }
                }
            }
            else {
                // 普通子节点：递归构建
                const childExpr = this.composeChildExpr(expression, childInfo.exp);
                const childName = this.displayNameFromMiChildExp(childInfo.exp);
                try {
                    const childNode = await this.buildTreeFromVarobj(gdb, childInfo.name, childExpr, childName, false);
                    node.children.push(childNode);
                }
                catch {
                    node.children.push({
                        name: childName,
                        relativePath: childName,
                        expression: childExpr,
                        declaredTypeText: this.normalizeTypeName(childInfo.typeName),
                        byteSize: this.guessSize(childInfo.typeName),
                        children: []
                    });
                }
            }
        }
        return node;
    }
    async buildTreeFromExpression(gdb, expression, nodeName, isRoot) {
        const miName = `tmp${++this.tempVarCounter}`;
        const createResult = await this.execSync(gdb, `-var-create ${miName} @ ${this.quoteMiString(expression)}`);
        if (createResult.cls === 'error') {
            throw new GdbResolveFailure('gdb_failed', createResult.message || `Failed to create varobj for ${expression}`);
        }
        try {
            return await this.buildTreeFromVarobj(gdb, miName, expression, nodeName, isRoot);
        }
        finally {
            await this.execSync(gdb, `-var-delete ${miName}`).catch(() => undefined);
        }
    }
    async populatePointerChildren(gdb, node) {
        if (!this.isCompositePointerType(node.declaredTypeText) || node.children.length > 0) {
            return;
        }
        const derefExpr = this.composePointerDerefExpr(node.expression);
        try {
            const derefNode = await this.buildTreeFromExpression(gdb, derefExpr, node.name, false);
            if (derefNode.children.length > 0) {
                node.children = derefNode.children;
            }
        }
        catch {
            // Keep pointer node as leaf if dereference fails.
        }
    }
    /** 检测 MI 子节点是否为基类子对象 */
    isBaseClassSubobject(child) {
        const typeStripped = child.typeName
            .replace(/^(class|struct|union)\s+/i, '')
            .replace(/\s*:\s*(?:public|private|protected)\s+.*$/, '')
            .replace(/<[^>]*>/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const expStripped = child.exp.replace(/<[^>]*>/g, '').trim();
        return typeStripped.length > 0 && typeStripped === expStripped && child.numChild > 0;
    }
    /**
     * 在已有 GDB 会话中同步执行一条 MI 命令，等待结果。
     */
    execSync(gdb, command) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new GdbResolveFailure('gdb_failed', `GDB timed out on command: ${command}`));
            }, GdbMiTreeResolver.GDB_TIMEOUT_MS);
            const onData = (chunk) => {
                // 追加到累积缓冲区
                this.stdoutBuf += chunk.toString('utf8');
                if (this.stdoutBuf.length > GdbMiTreeResolver.GDB_MAX_OUTPUT_BYTES) {
                    clearTimeout(timeout);
                    gdb.stdout.removeListener('data', onData);
                    reject(new GdbResolveFailure('gdb_failed', 'GDB output exceeded buffer limit'));
                    return;
                }
                // 尝试解析一条完整的结果
                const result = this.tryExtractOneResult();
                if (result) {
                    clearTimeout(timeout);
                    gdb.stdout.removeListener('data', onData);
                    resolve(result);
                }
            };
            gdb.stdout.on('data', onData);
            if (gdb.stdin) {
                gdb.stdin.write(command + '\n');
            }
            else {
                clearTimeout(timeout);
                reject(new GdbResolveFailure('gdb_failed', 'GDB stdin not available'));
            }
        });
    }
    /** 尝试从缓冲区中提取一条 MI 结果记录 */
    tryExtractOneResult() {
        // MI 结果以 ^done / ^error / ^running 等开头，后跟 (gdb) 提示符
        const promptIdx = this.stdoutBuf.indexOf('\n(gdb) \n');
        if (promptIdx < 0) {
            return null;
        }
        const block = this.stdoutBuf.slice(0, promptIdx).trim();
        this.stdoutBuf = this.stdoutBuf.slice(promptIdx + 8); // 跳过 '\n(gdb) \n'
        const lines = block.split(/\r?\n/);
        let resultLine = '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('^')) {
                resultLine = trimmed;
                break;
            }
        }
        if (!resultLine) {
            return null;
        }
        const clsMatch = resultLine.match(/^\^([a-zA-Z-]+)/);
        const cls = clsMatch ? clsMatch[1] : 'unknown';
        return {
            cls,
            message: this.getMiField(resultLine, 'msg') ?? '',
            value: this.getMiField(resultLine, 'value') ?? '',
            rawResult: resultLine
        };
    }
    spawnGdb(resolvedGdb) {
        const args = ['--interpreter=mi2', '-q', '-nx'];
        if (this.elfPath) {
            args.push(this.elfPath);
        }
        const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];
        const currentPath = process.env.PATH || '';
        const env = {
            ...process.env,
            PATH: `${extraPaths.join(':')}:${currentPath}`
        };
        try {
            const child = (0, child_process_1.spawn)(resolvedGdb, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            return child;
        }
        catch {
            return undefined;
        }
    }
    parseMiChildren(rawResult) {
        const start = rawResult.indexOf('children=[');
        if (start < 0) {
            return [];
        }
        const openIdx = rawResult.indexOf('[', start);
        if (openIdx < 0) {
            return [];
        }
        const endIdx = this.findMatchingBracket(rawResult, openIdx, '[', ']');
        if (endIdx < 0) {
            return [];
        }
        const body = rawResult.slice(openIdx + 1, endIdx);
        const children = [];
        let i = 0;
        while (i < body.length) {
            const childStart = body.indexOf('child={', i);
            if (childStart < 0) {
                break;
            }
            const braceOpen = body.indexOf('{', childStart);
            if (braceOpen < 0) {
                break;
            }
            const braceClose = this.findMatchingBracket(body, braceOpen, '{', '}');
            if (braceClose < 0) {
                break;
            }
            const fragment = body.slice(braceOpen + 1, braceClose);
            const name = this.getMiField(fragment, 'name') ?? '';
            const exp = this.getMiField(fragment, 'exp') ?? '';
            const typeName = this.normalizeTypeName(this.getMiField(fragment, 'type') ?? 'unknown');
            const numChild = this.parseIntField(this.getMiField(fragment, 'numchild')) ?? 0;
            const value = this.getMiField(fragment, 'value') ?? '';
            if (name && exp) {
                children.push({ name, exp, typeName, numChild, value });
            }
            i = braceClose + 1;
        }
        return children;
    }
    resolveGdbPath() {
        if (this.resolvedGdbCache) {
            return this.resolvedGdbCache;
        }
        if (this.gdbPath.startsWith('/') && fs_1.default.existsSync(this.gdbPath)) {
            this.resolvedGdbCache = this.gdbPath;
            return this.gdbPath;
        }
        const candidates = [
            `/opt/homebrew/bin/${this.gdbPath}`,
            `/usr/local/bin/${this.gdbPath}`,
            `/opt/local/bin/${this.gdbPath}`,
            `/usr/bin/${this.gdbPath}`
        ];
        for (const candidate of candidates) {
            if (fs_1.default.existsSync(candidate)) {
                this.resolvedGdbCache = candidate;
                return candidate;
            }
        }
        try {
            const result = (0, child_process_1.execFileSync)('/usr/bin/env', ['which', this.gdbPath], {
                timeout: 3000,
                env: {
                    ...process.env,
                    PATH: `/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:${process.env.PATH || ''}`
                }
            }).toString().trim();
            if (result && fs_1.default.existsSync(result)) {
                this.resolvedGdbCache = result;
                return result;
            }
        }
        catch {
            // ignore
        }
        return this.gdbPath;
    }
    getMiField(resultRecord, key) {
        const fieldRegex = new RegExp(`${key}=\"((?:\\\\.|[^\"\\\\])*)\"`);
        const match = resultRecord.match(fieldRegex);
        if (!match) {
            return null;
        }
        return this.decodeMiCString(match[1]);
    }
    parseIntField(value) {
        if (value === null || value === '') {
            return null;
        }
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : null;
    }
    parseIntegerFromMiValue(value) {
        const match = value.match(/-?0x[0-9a-fA-F]+|-?\d+/);
        if (!match) {
            return null;
        }
        const token = match[0];
        const parsed = token.startsWith('-0x')
            ? -Number.parseInt(token.slice(3), 16)
            : token.startsWith('0x')
                ? Number.parseInt(token, 16)
                : Number.parseInt(token, 10);
        return Number.isFinite(parsed) ? parsed : null;
    }
    parseAddressFromMiValue(value) {
        const addrMatch = value.match(/0x[0-9a-fA-F]+/);
        if (!addrMatch) {
            return null;
        }
        const parsed = Number.parseInt(addrMatch[0], 16);
        return Number.isFinite(parsed) ? parsed : null;
    }
    decodeMiCString(value) {
        try {
            return JSON.parse(`"${value}"`);
        }
        catch {
            return value
                .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(Number.parseInt(oct, 8)))
                .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '\r')
                .replace(/\\t/g, '\t')
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\');
        }
    }
    assertExpressionIsSafe(expression) {
        if (/[\r\n\x1a]/.test(expression)) {
            throw new GdbResolveFailure('expression_invalid', 'Expression contains disallowed control characters');
        }
    }
    /** 将字符串编码为 GDB MI 双引号 C 字符串 */
    quoteMiString(value) {
        return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
    }
    findMatchingBracket(input, openIdx, openCh, closeCh) {
        let depth = 0;
        let inQuote = false;
        let escaped = false;
        for (let i = openIdx; i < input.length; i += 1) {
            const ch = input[i];
            if (inQuote) {
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (ch === '\\') {
                    escaped = true;
                    continue;
                }
                if (ch === '"') {
                    inQuote = false;
                }
                continue;
            }
            if (ch === '"') {
                inQuote = true;
                continue;
            }
            if (ch === openCh) {
                depth += 1;
                continue;
            }
            if (ch === closeCh) {
                depth -= 1;
                if (depth === 0) {
                    return i;
                }
            }
        }
        return -1;
    }
    composeChildExpr(parentExpr, childExp) {
        if (/^\d+$/.test(childExp)) {
            return `(${parentExpr})[${childExp}]`;
        }
        return `(${parentExpr}).${childExp}`;
    }
    displayNameFromMiChildExp(childExp) {
        return /^\d+$/.test(childExp) ? `[${childExp}]` : childExp;
    }
    normalizeTypeName(typeName) {
        return typeName.replace(/\s+/g, ' ').trim();
    }
    isPointerType(typeName) {
        return this.normalizeTypeName(typeName).includes('*');
    }
    isCompositePointerType(typeName) {
        const normalized = this.normalizeTypeName(typeName);
        return /^(class|struct|union)\b/i.test(normalized) && /\*\s*$/.test(normalized);
    }
    composePointerDerefExpr(expr) {
        return `*(${expr})`;
    }
    isSymbolMissingMessage(message) {
        return /no symbol\b|there is no member or method named\b|no type\b/i.test(message);
    }
    isExpressionInvalidMessage(message) {
        return /syntax error|parse error|junk after end of expression|unexpected token/i.test(message);
    }
    guessSize(typeName) {
        const type = typeName.toLowerCase().replace(/\s+/g, ' ').trim();
        if (type === 'float') {
            return 4;
        }
        if (type === 'double') {
            return 8;
        }
        if (type === 'bool' || type === '_bool') {
            return 1;
        }
        if (type.includes('int8') || type === 'char' || type === 'unsigned char' || type === 'signed char') {
            return 1;
        }
        if (type.includes('int16') || type === 'short' || type === 'unsigned short') {
            return 2;
        }
        if (type.includes('int64') || type === 'long long' || type === 'unsigned long long') {
            return 8;
        }
        if (type.includes('*')) {
            return 4;
        }
        return 4;
    }
    /** 在 GDB 会话中解析表达式地址 */
    async resolveAddress(gdb, expression) {
        try {
            const result = await this.execSync(gdb, `-data-evaluate-expression &(${expression})`);
            if (result.cls === 'done') {
                return this.parseAddressFromMiValue(result.value) ?? 0;
            }
        }
        catch {
            // ignore
        }
        return 0;
    }
}
exports.GdbMiTreeResolver = GdbMiTreeResolver;
GdbMiTreeResolver.GDB_TIMEOUT_MS = 30000;
GdbMiTreeResolver.GDB_MAX_OUTPUT_BYTES = 1024 * 1024;
//# sourceMappingURL=gdbMiTreeResolver.js.map