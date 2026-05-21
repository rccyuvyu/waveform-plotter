import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DataType, WatchEntry } from '../core/types';
import { CompositeFieldInfo, CompositeLeafInfo, inferDataTypeFromTypeText, parseCompositeFieldInfos, parseCompositeLeafInfos } from './compositeLayout';
import { GdbMiTreeResolver } from './gdbMiTreeResolver';
import { ParsedWatchNode, flattenParsedWatchLeaves, parsePtypeWatchTree } from './watchTreeParser';

interface SymbolInfo {
  name: string;
  address: number;
  size: number;
  section: string;
}

interface ResolvedSymbolMatch {
  symbolName: string;
  info: SymbolInfo;
}

export class ElfSymbolResolver {
  private symbolCache = new Map<string, SymbolInfo>();
  private shortNameIndex = new Map<string, string[]>();
  private typeCache = new Map<string, DataType | null>();
  private compositeLeafCache = new Map<string, CompositeLeafInfo[]>();
  private compositeTreeCache = new Map<string, ParsedWatchNode | null>();
  /** typeName → value → enum constant name */
  private enumConstantMaps = new Map<string, Map<number, string>>();
  lastElfPath: string | undefined;
  private lastModified = 0;

  async loadSymbols(elfPath: string): Promise<boolean> {
    if (!fs.existsSync(elfPath)) {
      return false;
    }
    const stat = fs.statSync(elfPath);
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
    this.compositeLeafCache.clear();
    this.compositeTreeCache.clear();
    this.parseNmOutput(output);
    this.buildShortNameIndex();
    this.lastElfPath = elfPath;
    this.lastModified = stat.mtimeMs;
    return this.symbolCache.size > 0;
  }

  async resolveVariable(varName: string): Promise<WatchEntry | undefined> {
    const match = this.findSymbol(varName);
    if (match) {
      return this.buildEntry(varName, match);
    }
    return this.resolveExpressionEntry(varName);
  }

  async resolveDeclaredTypeText(expression: string): Promise<string | undefined> {
    if (!this.lastElfPath || !fs.existsSync(this.lastElfPath)) {
      return undefined;
    }
    const gdb = await this.findGdbTool();
    if (!gdb) {
      return undefined;
    }
    return this.resolveExpressionTypeText(gdb, this.lastElfPath, expression);
  }

  async resolveCompositeLeafPaths(varName: string): Promise<string[]> {
    const infos = await this.resolveCompositeLeafInfos(varName);
    return infos.map((info) => info.path);
  }

  async resolveCompositeLeafInfos(varName: string): Promise<CompositeLeafInfo[]> {
    const tree = await this.resolveCompositeWatchTree(varName);
    if (!tree) {
      return [];
    }
    return flattenParsedWatchLeaves(varName, tree).map((leaf) => ({
      path: leaf.fullName === varName ? '' : leaf.fullName.slice(varName.length + 1),
      typeText: leaf.declaredTypeText,
      byteSize: leaf.byteSize
    })).filter((leaf) => !!leaf.path);
  }

  async resolveCompositeWatchTree(varName: string): Promise<ParsedWatchNode | undefined> {
    if (!this.lastElfPath || !fs.existsSync(this.lastElfPath)) {
      return undefined;
    }

    const match = this.findSymbol(varName);
    const expr = match?.symbolName ?? varName;
    const cacheKey = `${this.lastElfPath}:${this.lastModified}:tree:${expr}`;
    if (this.compositeTreeCache.has(cacheKey)) {
      return this.cloneParsedWatchNode(this.compositeTreeCache.get(cacheKey) ?? undefined);
    }

    const gdb = await this.findGdbTool();
    if (!gdb) {
      return undefined;
    }

    const declaredTypeText = await this.resolveExpressionTypeText(gdb, this.lastElfPath, expr);
    if (declaredTypeText && isCompositePointerTypeText(declaredTypeText)) {
      const derefExpression = composePointerDerefExpression(expr);
      const derefTree = await this.resolveCompositeTypeTreeForElf(
        gdb,
        this.lastElfPath,
        declaredTypeText,
        derefExpression,
        new Set<string>()
      );
      if (derefTree) {
        await this.hydrateParsedWatchTreeForElf(gdb, this.lastElfPath, derefTree, new Set<string>());
        await this.resolvePtypeLeafAddresses(gdb, this.lastElfPath, derefTree);
        this.compositeTreeCache.set(cacheKey, this.cloneParsedWatchNode(derefTree) ?? null);
        return this.cloneParsedWatchNode(derefTree);
      }
    }

    // 优先使用 GDB MI 方式：spawn("gdb", ["--interpreter=mi2", "-q", "-nx", elfPath])
    // 此方式只打开 ELF 文件读取 DWARF 调试信息，不连接任何远程目标，不影响调试器
    try {
      const miResolver = new GdbMiTreeResolver(gdb, this.lastElfPath);
      const miTree = await miResolver.resolve(expr);
      if (miTree) {
        this.compositeTreeCache.set(cacheKey, this.cloneParsedWatchNode(miTree) ?? null);
        return this.cloneParsedWatchNode(miTree);
      }
    } catch {
      // Fall back to ptype-based resolution below.
    }

    const layoutText = await this.runGdbPtype(gdb, this.lastElfPath, expr);
    if (!layoutText) {
      return undefined;
    }

    const root = parsePtypeWatchTree(layoutText, expr);
    if (!root) {
      return undefined;
    }

    // ptype /o 对继承类表达式返回空体，检测继承信息并解析基类类型
    if (root.children.length === 0) {
      const headerMatch = layoutText.match(/type\s*=\s*(class|struct|union)\s+(.+?)\s*\{/);
      if (headerMatch) {
        const typeText = `${headerMatch[1]} ${headerMatch[2]}`;
        if (hasInheritance(typeText)) {
          const baseName = extractBaseTypeName(typeText);
          if (baseName) {
            const baseTree = await this.resolveCompositeTypeTreeForElf(gdb, this.lastElfPath, baseName, expr, new Set<string>());
            if (baseTree && baseTree.children.length > 0) {
              root.children = baseTree.children;
            }
          }
        }
      }
    }

    await this.hydrateParsedWatchTreeForElf(gdb, this.lastElfPath, root, new Set<string>());
    // ptype /o 解析的节点不含地址，通过 GDB 批量解析所有叶节点的地址
    await this.resolvePtypeLeafAddresses(gdb, this.lastElfPath, root);
    this.compositeTreeCache.set(cacheKey, this.cloneParsedWatchNode(root) ?? null);
    return this.cloneParsedWatchNode(root);
  }

  private findSymbol(varName: string): ResolvedSymbolMatch | undefined {
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

    // 大小写不敏感回退：全局变量在 ELF 中可能全小写，但用户输入首字母大写（如类名）
    const lowerVarName = varName.toLowerCase();
    for (const [key, info] of this.symbolCache) {
      if (key !== varName && key.toLowerCase() === lowerVarName) {
        console.log(`[waveform-plotter] findSymbol: "${varName}" case-insensitive matched "${key}"`);
        return { symbolName: key, info };
      }
    }

    console.log(`[waveform-plotter] findSymbol: "${varName}" not found in ${this.symbolCache.size} symbols`);

    return undefined;
  }

  private async buildEntry(name: string, match: ResolvedSymbolMatch): Promise<WatchEntry | undefined> {
    const { symbolName, info } = match;
    const exactType = await this.inferDataTypeFromDebug(symbolName, info.size);
    const dt = exactType ?? this.inferDataTypeFromSize(info.size);
    if (!dt) {
      // nm 中有该符号但无法推断类型（如大结构体/类/联合体）：
      // 仍创建 UINT8 类型条目，byteSize 设为符号实际大小，采样时按原始字节读取
      return { name, address: info.address, dataType: 'UINT8', byteSize: info.size };
    }
    if (dt === 'ENUM') {
      await this.resolveEnumConstants(symbolName);
    }
    return { name, address: info.address, dataType: dt, byteSize: this.byteSize(dt) };
  }

  private async resolveExpressionEntry(expression: string): Promise<WatchEntry | undefined> {
    if (!this.lastElfPath || !fs.existsSync(this.lastElfPath)) {
      return undefined;
    }

    const gdb = await this.findGdbTool();
    if (!gdb) {
      return undefined;
    }

    const output = await this.runGdbExpressionInspect(gdb, this.lastElfPath, expression);
    if (!output) {
      return undefined;
    }

    const typeMatch = output.match(/type\s*=\s*(.+)/i);
    const sizeMatch = output.match(/\$\d+\s*=\s*(\d+)/);
    const addressMatch = output.match(/\$\d+\s*=\s*0x([0-9a-fA-F]+)/);
    const size = Number.parseInt(sizeMatch?.[1] ?? '', 10);
    const dataType = inferDataTypeFromTypeText(typeMatch?.[1]?.trim() ?? '', Number.isFinite(size) ? size : 0);
    const address = addressMatch ? Number.parseInt(addressMatch[1], 16) : Number.NaN;
    if (!dataType || !Number.isFinite(address)) {
      return undefined;
    }
    if (dataType === 'ENUM') {
      await this.resolveEnumConstants(expression);
    }

    return {
      name: expression,
      address,
      dataType,
      byteSize: this.byteSize(dataType)
    };
  }

  private async resolveExpressionTypeText(gdbPath: string, elfPath: string, expression: string): Promise<string | undefined> {
    const output = await this.runGdbWhatis(gdbPath, elfPath, expression);
    const typeMatch = output?.match(/type\s*=\s*(.+)/i);
    return typeMatch?.[1]?.trim();
  }

  private async resolveCompositeLeafInfosForType(
    gdbPath: string,
    elfPath: string,
    typeText: string,
    seenTypes: Set<string>
  ): Promise<CompositeLeafInfo[]> {
    const normalizedType = normalizeTypeName(typeText);
    if (!normalizedType || seenTypes.has(normalizedType)) {
      return [];
    }
    seenTypes.add(normalizedType);

    const output = await this.runGdbPtype(gdbPath, elfPath, normalizedType);
    if (!output) {
      return [];
    }

    const directFields = parseCompositeFieldInfos(output);
    if (directFields.length === 0) {
      return dedupeLeafInfos(parseCompositeLeafInfos(output));
    }

    const leaves: CompositeLeafInfo[] = [];
    for (const field of directFields) {
      const expanded = await this.expandFieldInfos(gdbPath, elfPath, field, seenTypes);
      if (expanded.length > 0) {
        leaves.push(...expanded);
      } else {
        const elementPaths = expandFieldElementPaths(field);
        const elementSize = computeElementByteSize(field);
        const dataType = inferDataTypeFromTypeText(field.typeText, elementSize);
        if (!dataType) {
          continue;
        }
        for (const path of elementPaths) {
          leaves.push({
            path,
            typeText: field.typeText,
            byteSize: elementSize
          });
        }
      }
    }

    return dedupeLeafInfos(leaves);
  }

  private async expandFieldInfos(
    gdbPath: string,
    elfPath: string,
    field: CompositeFieldInfo,
    seenTypes: Set<string>
  ): Promise<CompositeLeafInfo[]> {
    const nestedLeaves = await this.resolveCompositeLeafInfosForType(
      gdbPath,
      elfPath,
      field.typeText,
      new Set(seenTypes)
    );
    if (nestedLeaves.length === 0) {
      return [];
    }

    const prefixes = expandFieldElementPaths(field);
    const expanded: CompositeLeafInfo[] = [];
    for (const prefix of prefixes) {
      for (const leaf of nestedLeaves) {
        expanded.push({
          path: joinCompositePath(prefix, leaf.path),
          typeText: leaf.typeText,
          byteSize: leaf.byteSize
        });
      }
    }
    return expanded;
  }

  /** 根据 nm 输出判断符号大小。返回 undefined 表示未找到符号（可能为表达式）。 */
  getSymbolByteSize(varName: string): number | undefined {
    const match = this.findSymbol(varName);
    return match ? match.info.size : undefined;
  }

  getSymbolCount(): number {
    return this.symbolCache.size;
  }

  isLoaded(): boolean {
    return this.symbolCache.size > 0;
  }

  clear(): void {
    this.symbolCache.clear();
    this.shortNameIndex.clear();
    this.typeCache.clear();
    this.compositeLeafCache.clear();
    this.compositeTreeCache.clear();
    this.lastElfPath = undefined;
    this.lastModified = 0;
  }

  private async hydrateParsedWatchTreeForElf(
    gdbPath: string,
    elfPath: string,
    node: ParsedWatchNode,
    seenTypes: Set<string>
  ): Promise<void> {
    for (const child of node.children) {
      if (child.children.length > 0) {
        await this.hydrateParsedWatchTreeForElf(gdbPath, elfPath, child, new Set(seenTypes));
        continue;
      }

      const expanded = await this.resolveCompositeTypeTreeForElf(
        gdbPath,
        elfPath,
        child.declaredTypeText,
        child.expression,
        new Set(seenTypes)
      );
      if (expanded && expanded.children.length > 0) {
        child.children = expanded.children;
        child.byteSize = expanded.byteSize || child.byteSize;
        await this.hydrateParsedWatchTreeForElf(gdbPath, elfPath, child, new Set(seenTypes));
        continue;
      }

      // 处理继承类：通过 GDB 表达式探测基类数组成员
      if (hasInheritance(child.declaredTypeText) && child.byteSize > 0) {
        await this.hydrateInheritedLeaf(gdbPath, elfPath, child);
      }
    }
  }

  /** 对 ptype 解析的树中所有叶节点，通过 GDB 批量解析地址并回填到节点上 */
  private async resolvePtypeLeafAddresses(
    gdbPath: string,
    elfPath: string,
    root: ParsedWatchNode
  ): Promise<void> {
    // 收集所有叶节点的表达式
    const leafNodes: ParsedWatchNode[] = [];
    const walk = (node: ParsedWatchNode) => {
      if (node.children.length === 0 && node.expression) {
        leafNodes.push(node);
        return;
      }
      for (const child of node.children) {
        if (child.children.length === 0 && child.expression) {
          leafNodes.push(child);
        } else {
          walk(child);
        }
      }
    };
    walk(root);

    if (leafNodes.length === 0) {
      return;
    }

    // 用一个 GDB 批处理调用同时获取所有叶节点的地址
    // 用 GDB batch 模式执行多个 print/x &(expr) 命令
    const args = ['-q', '--batch', elfPath, '-ex', 'set pagination off'];
    for (const leaf of leafNodes) {
      args.push('-ex', `print/x (unsigned long)&(${leaf.expression})`);
    }

    const output = await this.runGdbCapture(gdbPath, args);
    if (!output) {
      return;
    }

    // 解析输出：每行格式 $N = 0xADDRESS
    const addrMatches = [...output.matchAll(/\$(\d+)\s*=\s*0x([0-9a-fA-F]+)/g)];
    if (addrMatches.length === 0) {
      return;
    }

    // GDB 分配变量号从 $1 开始，按 -ex 顺序递增
    for (let i = 0; i < Math.min(addrMatches.length, leafNodes.length); i += 1) {
      const addr = Number.parseInt(addrMatches[i][2], 16);
      if (Number.isFinite(addr) && addr > 0) {
        leafNodes[i].address = addr;
      }
    }
  }

  private async hydrateInheritedLeaf(
    gdbPath: string,
    elfPath: string,
    node: ParsedWatchNode
  ): Promise<void> {
    // 先用 ptype 获取完整成员列表（含继承成员），解析出所有基类数组字段
    const ptypeOutput = await this.runGdbPtype(gdbPath, elfPath, node.expression);
    if (!ptypeOutput) {
      return;
    }
    const flatMembers = parseFlatInheritedMembers(ptypeOutput);
    for (const member of flatMembers) {
      if (!/^float\s/.test(member.type) || member.arrayDims.length === 0) {
        continue;
      }
      const totalCount = member.arrayDims.reduce((a, d) => a * d, 1);
      if (totalCount < 1 || totalCount > 128) {
        continue;
      }
      const elemSize = member.byteSize / totalCount;
      if (elemSize < 1) {
        continue;
      }
      const memberExpr = `${node.expression}.${member.name}`;
      const fieldNode: ParsedWatchNode = {
        name: member.name,
        relativePath: joinCompositePath(node.relativePath, member.name),
        expression: memberExpr,
        declaredTypeText: member.type,
        byteSize: member.byteSize,
        children: []
      };
      for (let i = 0; i < totalCount; i += 1) {
        fieldNode.children.push({
          name: `[${i}]`,
          relativePath: `${fieldNode.relativePath}[${i}]`,
          expression: `(${memberExpr})[${i}]`,
          declaredTypeText: /double\b/i.test(member.type) ? 'double' : 'float',
          byteSize: elemSize,
          children: []
        });
      }
      node.children.push(fieldNode);
      return;
    }
  }

  private async resolveCompositeTypeTreeForElf(
    gdbPath: string,
    elfPath: string,
    typeText: string,
    expression: string,
    seenTypes: Set<string>
  ): Promise<ParsedWatchNode | undefined> {
    const normalizedType = normalizeTypeName(typeText);
    if (!normalizedType || seenTypes.has(normalizedType)) {
      return undefined;
    }
    seenTypes.add(normalizedType);

    for (const candidate of buildCompositeTypeCandidates(normalizedType)) {
      const layoutText = await this.runGdbPtype(gdbPath, elfPath, candidate);
      if (!layoutText) {
        continue;
      }
      const parsed = parsePtypeWatchTree(layoutText, expression);
      if (parsed) {
        // 如果解析结果没有子成员，且类型有基类，尝试解析基类的成员
        // 使用原始 typeText（未标准化）以保留继承信息供 extractBaseTypeName 提取基类名
        if (parsed.children.length === 0) {
          const baseName = extractBaseTypeName(typeText);
          if (baseName && !seenTypes.has(baseName)) {
            seenTypes.add(baseName);
            const baseResult = await this.resolveCompositeTypeTreeForElf(gdbPath, elfPath, baseName, expression, seenTypes);
            if (baseResult && baseResult.children.length > 0) {
              parsed.children = baseResult.children;
            }
          }
        }
        return parsed;
      }
    }
    return undefined;
  }

  private cloneParsedWatchNode(node: ParsedWatchNode | undefined): ParsedWatchNode | undefined {
    if (!node) {
      return undefined;
    }
    return {
      ...node,
      children: node.children.map((child) => this.cloneParsedWatchNode(child) as ParsedWatchNode)
    };
  }

  private parseNmOutput(output: string): void {
    const withSize = /^([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([A-Za-z])\s+(\S+)$/gm;
    const withoutSize = /^([0-9a-fA-F]+)\s+([A-Za-z])\s+(\S+)$/gm;
    const dataSections = new Set(['B', 'b', 'D', 'd', 'G', 'g', 'S', 's', 'R', 'r', 'C']);

    let m: RegExpExecArray | null;
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

  private buildShortNameIndex(): void {
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

  private inferDataTypeFromSize(size: number): DataType | undefined {
    switch (size) {
      case 1:
        return 'UINT8';
      case 2:
        return 'INT16';
      case 4:
        return 'INT32';
      default:
        return undefined;
    }
  }

  private byteSize(dt: DataType): number {
    switch (dt) {
      case 'INT8':
      case 'UINT8':
      case 'BOOL':
        return 1;
      case 'INT16':
      case 'UINT16':
        return 2;
      case 'INT32':
      case 'UINT32':
      case 'FLOAT':
      case 'ENUM':
        return 4;
      case 'DOUBLE':
        return 8;
      case 'INT64':
      case 'UINT64':
        return 8;
    }
  }

  private async runNm(nmPath: string, elfPath: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const proc = spawn(nmPath, ['-C', '--print-size', elfPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 10000);

      proc.stdout.on('data', (buf: Buffer) => chunks.push(buf));
      proc.stderr.on('data', (buf: Buffer) => errChunks.push(buf));
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

  private async inferDataTypeFromDebug(symbolName: string, fallbackSize: number): Promise<DataType | undefined> {
    if (!this.lastElfPath || !fs.existsSync(this.lastElfPath)) {
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
      return undefined;
    }

    const whatisMatch = output.match(/type\s*=\s*(.+)/i);
    const sizeMatch = output.match(/\$\d+\s*=\s*(\d+)/);
    const size = Number.parseInt(sizeMatch?.[1] ?? String(fallbackSize), 10);
    const dataType = inferDataTypeFromTypeText(whatisMatch?.[1]?.trim() ?? '', Number.isFinite(size) ? size : fallbackSize);
    if (dataType) {
      this.typeCache.set(cacheKey, dataType);
      return dataType;
    }
    return undefined;
  }

  private async runGdbInspect(gdbPath: string, elfPath: string, symbolName: string): Promise<string | undefined> {
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
      const proc = spawn(gdbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 10000);

      proc.stdout.on('data', (buf: Buffer) => stdoutChunks.push(buf));
      proc.stderr.on('data', (buf: Buffer) => stderrChunks.push(buf));
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

  private async runGdbWhatis(gdbPath: string, elfPath: string, expression: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const args = [
        '-q',
        '--batch',
        elfPath,
        '-ex',
        'set pagination off',
        '-ex',
        `whatis (${expression})`
      ];
      const proc = spawn(gdbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdoutChunks: Buffer[] = [];
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 10000);

      proc.stdout.on('data', (buf: Buffer) => stdoutChunks.push(buf));
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

  /**
   * 运行 GDB batch 命令并捕获 stdout 输出。
   * @param gdbPath GDB 工具路径
   * @param args GDB 命令行参数（不含程序名），如 ['-q', '--batch', elfPath, '-ex', ...]
   */
  private async runGdbCapture(gdbPath: string, args: string[]): Promise<string | undefined> {
    if (!gdbPath || !args.length) {
      return undefined;
    }
    return new Promise((resolve) => {
      const proc = spawn(gdbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdoutChunks: Buffer[] = [];
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 10000);

      proc.stdout.on('data', (buf: Buffer) => stdoutChunks.push(buf));
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

  private async runGdbPtype(gdbPath: string, elfPath: string, symbolName: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const args = [
        '-q',
        '--batch',
        elfPath,
        '-ex',
        'set pagination off',
        '-ex',
        ptypeLayoutExpressionCommand(symbolName)
      ];
      const proc = spawn(gdbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdoutChunks: Buffer[] = [];
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 10000);

      proc.stdout.on('data', (buf: Buffer) => stdoutChunks.push(buf));
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

  /**
   * 解析枚举类型常量：运行 ptype（不带 /o）获取枚举常量名→值映射并缓存。
   */
  private async resolveEnumConstants(symbolName: string): Promise<boolean> {
    const gdb = await this.findGdbTool();
    if (!gdb || !this.lastElfPath) {
      return false;
    }
    return new Promise((resolve) => {
      const args = [
        '-q', '--batch', this.lastElfPath!,
        '-ex', 'set pagination off',
        '-ex', `ptype ${symbolName}`
      ];
      const proc = spawn(gdb, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      const timeout = setTimeout(() => proc.kill('SIGKILL'), 10000);
      proc.stdout.on('data', (buf: Buffer) => chunks.push(buf));
      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) { resolve(false); return; }
        const out = Buffer.concat(chunks).toString('utf8');
        const constants = this.parseEnumConstants(out);
        if (constants.size === 0) { resolve(false); return; }
        // 从 ptype 输出中提取类型名作为缓存 key
        const typeLine = out.match(/type\s*=\s*enum\s+(\S+)/);
        const key = typeLine?.[1] ?? symbolName;
        this.enumConstantMaps.set(key, constants);
        resolve(true);
      });
      proc.on('error', () => { clearTimeout(timeout); resolve(false); });
    });
  }

  /** 从 GDB ptype 输出中解析枚举常量：{ VAL_A = 0, VAL_B = 1, ... } */
  private parseEnumConstants(ptypeOutput: string): Map<number, string> {
    const map = new Map<number, string>();
    const braceStart = ptypeOutput.indexOf('{');
    const braceEnd = ptypeOutput.lastIndexOf('}');
    if (braceStart < 0 || braceEnd < 0) { return map; }
    const body = ptypeOutput.substring(braceStart + 1, braceEnd);
    let implicitValue = 0;
    for (const entry of body.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) { continue; }
      const explicitMatch = trimmed.match(/^(\w+)\s*=\s*(\d+)/);
      if (explicitMatch) {
        const val = Number.parseInt(explicitMatch[2], 10);
        map.set(val, explicitMatch[1]);
        implicitValue = val + 1;
      } else if (/^\w+$/.test(trimmed)) {
        map.set(implicitValue, trimmed);
        implicitValue++;
      }
    }
    return map;
  }

  /** 根据原始类型文本和值查询枚举常量名，如 getEnumConstantName("enum MyEnum", 1) → "VAL_B" */
  getEnumConstantName(typeText: string, value: number): string | undefined {
    const typeName = typeText.replace(/^enum\s+/, '').trim();
    const constants = this.enumConstantMaps.get(typeName);
    return constants?.get(value);
  }

  /**
   * 当变量名不是独立全局符号时，尝试在所有已知的全局结构体/类实例中查找其作为成员的存在。
   * 例如：用户输入 "lqr_r_"，扫描全局 struct Motor lqr; 后找到 lqr.lqr_r_，返回完整路径。
   */
  async resolveMemberExpression(memberName: string): Promise<string | undefined> {
    if (!this.lastElfPath || !fs.existsSync(this.lastElfPath)) {
      return undefined;
    }
    const gdb = await this.findGdbTool();
    if (!gdb) {
      return undefined;
    }

    // 收集候选父符号：数据段、非函数、size>8 的结构体/类实例
    const candidates: string[] = [];
    for (const [name, info] of this.symbolCache) {
      if (info.size > 8 && /^[a-zA-Z_]/.test(name) && !name.includes('::')) {
        candidates.push(name);
      }
    }
    if (candidates.length === 0) {
      return undefined;
    }
    // 最多检查 200 个候选，避免 GDB 命令行过长
    const limited = candidates.slice(0, 200);

    // 单次 GDB batch 调用检查所有候选的 whatis parent.memberName
    // 用 printf 作标记以精确回映射结果
    const args: string[] = ['-q', '--batch', this.lastElfPath, '-ex', 'set pagination off'];
    for (let i = 0; i < limited.length; i++) {
      args.push('-ex', `printf ">MBRCHK:%d\\n", ${i}`);
      args.push('-ex', `whatis ${limited[i]}.${memberName}`);
    }

    const output = await this.runGdbCapture(gdb, args);
    if (!output) {
      return undefined;
    }

    // 解析输出：>MBRCHK:N 之后紧跟 whatis 结果
    const markerRegex = />MBRCHK:(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = markerRegex.exec(output)) !== null) {
      const idx = Number.parseInt(m[1], 10);
      if (idx < 0 || idx >= limited.length) {
        continue;
      }
      // 提取标记之后到下一个标记或结尾之间的文本
      const startPos = m.index + m[0].length;
      const nextMarker = output.indexOf('>MBRCHK:', startPos);
      const section = nextMarker >= 0 ? output.substring(startPos, nextMarker) : output.substring(startPos);

      // 如果 whatis 输出了 "type = ..."，说明成员存在
      if (section.includes('type = ')) {
        const fullPath = `${limited[idx]}.${memberName}`;
        console.log(`[waveform-plotter] resolveAsMember: "${memberName}" -> "${fullPath}"`);
        return fullPath;
      }
    }

    return undefined;
  }

  async resolveAsMember(memberName: string): Promise<WatchEntry | undefined> {
    const fullPath = await this.resolveMemberExpression(memberName);
    if (!fullPath) {
      return undefined;
    }
    return this.resolveExpressionEntry(fullPath);
  }

  private async runGdbExpressionInspect(gdbPath: string, elfPath: string, expression: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const args = [
        '-q',
        '--batch',
        elfPath,
        '-ex',
        'set pagination off',
        '-ex',
        `whatis (${expression})`,
        '-ex',
        `print (int)sizeof(${expression})`,
        '-ex',
        `print/x (unsigned long)&(${expression})`
      ];
      const proc = spawn(gdbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdoutChunks: Buffer[] = [];
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 10000);

      proc.stdout.on('data', (buf: Buffer) => stdoutChunks.push(buf));
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

  private async findNmTool(): Promise<string | undefined> {
    const candidates = ['arm-none-eabi-nm', 'arm-none-eabi-nm.exe'];
    for (const cmd of candidates) {
      const ok = await this.checkTool(cmd);
      if (ok) {
        console.log(`[waveform-plotter] findNmTool: found "${cmd}" in PATH`);
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
      if (fs.existsSync(p)) {
        console.log(`[waveform-plotter] findNmTool: found at "${p}"`);
        return p;
      }
    }

    const fromEnv = process.env.ARM_NONE_EABI_NM;
    if (fromEnv && fs.existsSync(fromEnv)) {
      console.log(`[waveform-plotter] findNmTool: found via env at "${fromEnv}"`);
      return fromEnv;
    }

    if (this.lastElfPath) {
      const elfDir = path.dirname(this.lastElfPath);
      const localCandidate = path.join(elfDir, 'arm-none-eabi-nm');
      if (fs.existsSync(localCandidate)) {
        console.log(`[waveform-plotter] findNmTool: found locally at "${localCandidate}"`);
        return localCandidate;
      }
    }

    console.error('[waveform-plotter] findNmTool: arm-none-eabi-nm NOT FOUND');
    return undefined;
  }

  private async findGdbTool(): Promise<string | undefined> {
    const candidates = ['arm-none-eabi-gdb', 'arm-none-eabi-gdb.exe'];
    for (const cmd of candidates) {
      const ok = await this.checkTool(cmd);
      if (ok) {
        console.log(`[waveform-plotter] findGdbTool: found "${cmd}" in PATH`);
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
      if (fs.existsSync(p)) {
        console.log(`[waveform-plotter] findGdbTool: found at "${p}"`);
        return p;
      }
    }

    const fromEnv = process.env.ARM_NONE_EABI_GDB;
    if (fromEnv && fs.existsSync(fromEnv)) {
      console.log(`[waveform-plotter] findGdbTool: found via env at "${fromEnv}"`);
      return fromEnv;
    }

    console.error('[waveform-plotter] findGdbTool: arm-none-eabi-gdb NOT FOUND');
    return undefined;
  }

  private async checkTool(cmd: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(cmd, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
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

function ptypeLayoutExpressionCommand(expression: string): string {
  return `ptype /o (${expression})`;
}

function normalizeTypeName(typeText: string): string {
  return typeText
    .replace(/^type\s*=\s*/i, '')
    .replace(/\bconst\b|\bvolatile\b/g, ' ')
    .replace(/^(class|struct|union)\s+/i, '')
    .replace(/\s*:\s*(?:public|private|protected)\s+.*$/, '')
    .replace(/\s*[&*]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCompositePointerTypeText(typeText: string): boolean {
  const normalized = typeText.replace(/^type\s*=\s*/i, '').replace(/\s+/g, ' ').trim();
  return /^(class|struct|union)\b/i.test(normalized) && /\*\s*$/.test(normalized);
}

function composePointerDerefExpression(expression: string): string {
  return `*(${expression})`;
}

function buildCompositeTypeCandidates(typeText: string): string[] {
  const normalized = normalizeTypeName(typeText);
  const raw = normalized.replace(/^(class|struct|union)\s+/, '').trim();
  const candidates = [
    normalized,
    raw,
    `struct ${raw}`,
    `class ${raw}`,
    `union ${raw}`
  ];

  // 剥离继承信息，尝试裸类型名（如 "Class_Quaternion_f32 : public Class_Matrix_f32<4, 1>" → "Class_Quaternion_f32"）
  const strippedInheritance = raw.replace(/\s*:\s*(?:public|private|protected)\s+.*$/, '').trim();
  if (strippedInheritance && strippedInheritance !== raw) {
    candidates.push(strippedInheritance);
    candidates.push(`struct ${strippedInheritance}`);
    candidates.push(`class ${strippedInheritance}`);
    candidates.push(`union ${strippedInheritance}`);
  }

  // 提取基类名并加入候选
  const baseMatch = raw.match(/(?:public|private|protected)\s+(.+)$/);
  if (baseMatch) {
    const baseType = baseMatch[1].trim();
    candidates.push(baseType);
    candidates.push(`struct ${baseType}`);
    candidates.push(`class ${baseType}`);
    candidates.push(`union ${baseType}`);
  }

  return [...new Set(candidates.filter(Boolean))];
}

function expandFieldElementPaths(field: CompositeFieldInfo): string[] {
  if (!field.arrayDims.length) {
    return [field.path];
  }

  const MAX_EXPANDED_ARRAY_ELEMENTS = 128;
  let suffixes = [''];
  for (const dim of field.arrayDims) {
    if (suffixes.length * dim > MAX_EXPANDED_ARRAY_ELEMENTS) {
      return [field.path];
    }
    const next: string[] = [];
    for (const suffix of suffixes) {
      for (let index = 0; index < dim; index += 1) {
        next.push(`${suffix}[${index}]`);
      }
    }
    suffixes = next;
  }
  return suffixes.map((suffix) => `${field.path}${suffix}`);
}

function computeElementByteSize(field: CompositeFieldInfo): number {
  if (!field.arrayDims.length) {
    return field.byteSize;
  }
  const totalCount = field.arrayDims.reduce((acc, dim) => acc * dim, 1);
  return totalCount > 0 ? Math.max(1, Math.floor(field.byteSize / totalCount)) : field.byteSize;
}

function joinCompositePath(basePath: string, childPath: string): string {
  if (!childPath) {
    return basePath;
  }
  return childPath.startsWith('[') ? `${basePath}${childPath}` : `${basePath}.${childPath}`;
}

function dedupeLeafInfos(leaves: CompositeLeafInfo[]): CompositeLeafInfo[] {
  const seen = new Set<string>();
  const out: CompositeLeafInfo[] = [];
  for (const leaf of leaves) {
    if (!leaf.path || seen.has(leaf.path)) {
      continue;
    }
    seen.add(leaf.path);
    out.push(leaf);
  }
  return out;
}

function extractBaseTypeName(typeText: string): string | undefined {
  const match = typeText.match(/(?:public|private|protected)\s+(.+)$/);
  if (match) {
    return match[1].trim();
  }
  return undefined;
}

function hasInheritance(typeText: string): boolean {
  return /:\s*(?:public|private|protected)\s/.test(typeText);
}

interface FlatMemberInfo {
  name: string;
  type: string;
  arrayDims: number[];
  byteSize: number;
}

/**
 * 解析 ptype /o 输出，提取所有顶层非嵌套成员（含继承成员）。
 * 返回扁平成员列表，供 hydrateInheritedLeaf 使用。
 */
function parseFlatInheritedMembers(ptypeOutput: string): FlatMemberInfo[] {
  const members: FlatMemberInfo[] = [];
  const lines = ptypeOutput.split(/\r?\n/);

  let inBody = false;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // 找到类型体起始 { 的位置
    if (!inBody) {
      if (line.includes('{')) {
        inBody = true;
        const open = (line.match(/\{/g) || []).length;
        const close = (line.match(/\}/g) || []).length;
        braceDepth = open - close;
      }
      continue;
    }

    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;
    braceDepth += openBraces - closeBraces;

    // 类型体结束
    if (braceDepth <= 0) {
      break;
    }

    // 只处理顶层成员（braceDepth === 1），跳过嵌套结构体/类的内部
    if (braceDepth !== 1) {
      continue;
    }

    // 跳过访问限定符、total size 行、static 成员、空行
    if (/^\s*(public|private|protected)\s*:\s*$/.test(line)) {
      continue;
    }
    if (/total size \(bytes\)/i.test(line)) {
      continue;
    }
    if (/^\s*static\b/.test(line)) {
      continue;
    }
    if (/^\s*$/.test(line)) {
      continue;
    }

    // 匹配字段行: /* offset | size */ [type] [ptr*] name[array];
    const fieldMatch = line.match(/\/\*\s+\d+\s+\|\s+(\d+)\s+\*\/\s+(.+?)\s*([*&]+)?\s*(\w+)(\[(\d+)\])?\s*;/);
    if (!fieldMatch) {
      continue;
    }

    const size = Number.parseInt(fieldMatch[1], 10);
    let typeName = fieldMatch[2].trim();
    const ptrOrRef = fieldMatch[3] ? fieldMatch[3].trim() : '';
    const fieldName = fieldMatch[4];
    const arraySize = fieldMatch[6] ? Number.parseInt(fieldMatch[6], 10) : 0;

    if (ptrOrRef) {
      typeName = `${typeName} ${ptrOrRef}`.trim();
    }

    members.push({
      name: fieldName,
      type: normalizeTypeText(typeName),
      arrayDims: arraySize > 0 ? [arraySize] : [],
      byteSize: size
    });
  }

  return members;
}

function normalizeTypeText(typeText: string): string {
  return typeText.replace(/\s+/g, ' ').trim();
}
