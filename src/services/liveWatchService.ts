import * as vscode from 'vscode';
import { DataBuffer } from '../core/dataBuffer';
import { DataType, WatchEntry } from '../core/types';
import { parseDebuggerNumber } from './passiveCollector';
import { OpenOcdTclClient } from './openOcdTclClient';
import { TelnetClient } from './telnetClient';
import { ElfSymbolResolver } from './elfSymbolResolver';
import { SampleRateMeter } from './sampleRateMeter';

const RESPONSE_PATTERN = /0x[0-9a-fA-F]+:\s+([0-9a-fA-F]+)(?:\s+([0-9a-fA-F]+))?/;

export class LiveWatchService {
  readonly isRunning = { value: false };
  readonly elfResolver = new ElfSymbolResolver();

  sampleCount = 0;
  lastError: string | undefined;
  private readonly sampleRateMeter = new SampleRateMeter();

  private watchEntries = new Map<string, WatchEntry>();
  private client: TelnetClient | OpenOcdTclClient | undefined;
  private clientMode: 'telnet' | 'tcl' | undefined;
  private endpointLabel = '';
  private sampleBusy = false;
  private loopGeneration = 0;

  constructor(private readonly dataBuffer: DataBuffer, private readonly onData: () => void) {}

  getResolvedEntries(): Record<string, WatchEntry> {
    return Object.fromEntries(this.watchEntries.entries());
  }

  clearResolvedEntries(): void {
    this.watchEntries.clear();
  }

  removeResolvedEntry(name: string): void {
    this.watchEntries.delete(name);
  }

  removeResolvedEntriesByPrefix(prefix: string): void {
    for (const name of [...this.watchEntries.keys()]) {
      if (name === prefix || name.startsWith(`${prefix}.`)) {
        this.watchEntries.delete(name);
      }
    }
  }

  hydrateResolvedEntries(entries: Record<string, string>): void {
    for (const [name, value] of Object.entries(entries)) {
      const m = value.match(/^0x([0-9a-fA-F]+):(\w+)$/);
      if (!m) {
        continue;
      }
      const dataType = (m[2].toUpperCase() as DataType);
      this.watchEntries.set(name, {
        name,
        address: Number.parseInt(m[1], 16),
        dataType,
        byteSize: byteSize(dataType)
      });
    }
  }

  dumpResolvedEntries(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, entry] of this.watchEntries.entries()) {
      out[name] = `0x${entry.address.toString(16)}:${entry.dataType}`;
    }
    return out;
  }

  getLiveEndpointLabel(): string {
    return this.endpointLabel;
  }

  async resolveFromElf(elfPath: string, varNames: string[]): Promise<number> {
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
      const entry = await this.elfResolver.resolveVariable(name);
      if (entry) {
        this.watchEntries.set(name, entry);
        count += 1;
      }
    }
    return count;
  }

  async resolveVariables(session: vscode.DebugSession, varNames: string[], threadId?: number): Promise<number> {
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
      // 先检测是否为 struct/class，直接展开
      const expanded = await this.expandStructMembers(session, name, frameId);
      if (expanded && expanded.length > 0) {
        // 移除之前可能由 ELF 解析的父条目
        this.watchEntries.delete(name);
        for (const e of expanded) {
          this.watchEntries.set(e.name, e);
          count += 1;
        }
        continue;
      }
      // 基本类型：正常解析
      const entry = await this.resolveSingle(session, name, frameId);
      if (entry) {
        this.watchEntries.set(name, entry);
        count += 1;
      }
    }
    return count;
  }

  async refineResolvedTypes(session: vscode.DebugSession, varNames: string[], threadId?: number): Promise<number> {
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
      const ptype = await this.safeEval(session, `ptype ${name}`, frameId);
      if (!ptype) {
        continue;
      }
      // 发现之前被 ELF 错误解析为基本类型的结构体 — 展开为成员
      if (isStructOrClass(ptype)) {
        this.watchEntries.delete(name);
        const expanded = await this.expandStructMembers(session, name, frameId);
        if (expanded && expanded.length > 0) {
          for (const e of expanded) {
            this.watchEntries.set(e.name, e);
          }
          updated += expanded.length;
        }
        continue;
      }
      const sizeResult = await this.safeEval(session, `print (int)sizeof(${name})`, frameId);
      const type = inferDataType(ptype, sizeResult ?? '');
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

  async startLiveWatch(telnetPort: number, frequencyHz: number): Promise<void> {
    if (this.isRunning.value) {
      return;
    }
    this.isRunning.value = true;
    this.sampleCount = 0;
    this.lastError = undefined;
    this.sampleRateMeter.reset();

    try {
      await this.connectOpenOcd(telnetPort);
    } catch (err) {
      this.lastError = toErrMsg(err);
      this.isRunning.value = false;
      await this.closeClient();
      return;
    }

    const intervalMs = Math.max(1, Math.floor(1000 / Math.max(1, frequencyHz)));
    const generation = ++this.loopGeneration;
    void this.runLoop(intervalMs, generation);
  }

  async stopLiveWatch(): Promise<void> {
    this.isRunning.value = false;
    this.loopGeneration += 1;
    await this.closeClient();
    this.sampleBusy = false;
    this.sampleRateMeter.reset();
  }

  getActualFrequencyHz(): number {
    return this.sampleRateMeter.getHz();
  }

  /** 将用户输入的字符串解析为与 dataType 匹配的原始数值（整数类型返回无符号值，FLOAT 返回 uint32 位模式，DOUBLE 返回浮点数自身） */
  parseUserValue(input: string, dataType: DataType): number | null {
    const trimmed = input.trim();
    if (/^[-+]?0x[0-9a-fA-F]+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 16);
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num)) {
      return null;
    }
    switch (dataType) {
      case 'UINT8':
        return clampInt(num, 0, 255);
      case 'INT8':
        return clampInt(num, -128, 127) & 0xFF;
      case 'UINT16':
        return clampInt(num, 0, 65535);
      case 'INT16':
        return clampInt(num, -32768, 32767) & 0xFFFF;
      case 'UINT32':
        return clampUint(num, 0, 0xFFFFFFFF);
      case 'INT32':
        return (clampInt(num, -2147483648, 2147483647) >>> 0);
      case 'FLOAT': {
        const buf = new ArrayBuffer(4);
        const dv = new DataView(buf);
        dv.setFloat32(0, num, true);
        return dv.getUint32(0, true);
      }
      case 'DOUBLE':
        return num;
    }
  }

  /** 构建 OpenOCD 内存写命令数组 */
  private buildTelnetWriteCommand(entry: WatchEntry, value: number): string[] {
    const addr = `0x${entry.address.toString(16)}`;
    switch (entry.dataType) {
      case 'INT8':
      case 'UINT8':
        return [`mwb ${addr} ${value}`];
      case 'INT16':
      case 'UINT16':
        return [`mwh ${addr} ${value}`];
      case 'INT32':
      case 'UINT32':
        return [`mww ${addr} ${value}`];
      case 'FLOAT': {
        const buf = new ArrayBuffer(4);
        const dv = new DataView(buf);
        dv.setFloat32(0, value, true);
        return [`mww ${addr} ${dv.getUint32(0, true)}`];
      }
      case 'DOUBLE': {
        const buf = new ArrayBuffer(8);
        const dv = new DataView(buf);
        dv.setFloat64(0, value, true);
        const low = dv.getUint32(0, true);
        const high = dv.getUint32(4, true);
        const addrHigh = `0x${(entry.address + 4).toString(16)}`;
        return [`mww ${addr} ${low}`, `mww ${addrHigh} ${high}`];
      }
    }
  }

  /** 通过 OpenOCD 修改变量内存值 */
  async writeMemory(name: string, value: number): Promise<boolean> {
    const entry = this.watchEntries.get(name);
    if (!entry || !this.client) {
      return false;
    }
    try {
      if (this.clientMode === 'tcl') {
        await this.writeViaTcl(this.client as OpenOcdTclClient, entry, value);
        return true;
      }
      const commands = this.buildTelnetWriteCommand(entry, value);
      const responses = await (this.client as TelnetClient).sendBatch(commands, 500);
      return responses.length === commands.length;
    } catch {
      return false;
    }
  }

  private async runLoop(intervalMs: number, generation: number): Promise<void> {
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

  private async sampleOnce(): Promise<void> {
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
      const values = new Map<string, number>();
      if (this.clientMode === 'tcl') {
        for (const entry of entries) {
          const parsed = await this.readViaTcl(client as OpenOcdTclClient, entry);
          if (parsed !== undefined) {
            values.set(entry.name, parsed);
          }
        }
      } else {
        const commands = entries.map((entry) => buildTelnetReadCommand(entry));
        const responses = await (client as TelnetClient).sendBatch(commands, 700);
        if (responses.length !== entries.length) {
          return;
        }
        for (let i = 0; i < entries.length; i += 1) {
          const entry = entries[i];
          const raw = parseOpenocdResponse(responses[i], entry.dataType);
          if (raw === undefined) {
            continue;
          }
          const parsed = interpretBytes(raw, entry.dataType);
          values.set(entry.name, parsed);
        }
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
    } catch (err) {
      this.lastError = toErrMsg(err);
    } finally {
      this.sampleBusy = false;
    }
  }

  private async resolveSingle(session: vscode.DebugSession, varName: string, frameId: number): Promise<WatchEntry | undefined> {
    try {
      const addrResult = (await session.customRequest('evaluate', {
        expression: `print/x (unsigned long)&${varName}`,
        frameId,
        context: 'repl'
      })) as { result?: string };

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
    } catch {
      return undefined;
    }
  }

  /**
   * 递归展开 struct/class/union 变量的所有基本类型成员。
   * 对每个叶子成员使用 GDB 获取独立地址和类型。
   */
  private async expandStructMembers(
    session: vscode.DebugSession,
    varName: string,
    frameId: number
  ): Promise<WatchEntry[]> {
    const ptypeText = await this.safeEval(session, `ptype ${varName}`, frameId);
    if (!ptypeText || !isStructOrClass(ptypeText)) {
      return [];
    }

    const memberNames = parseMemberNames(ptypeText);
    if (memberNames.length === 0) {
      return [];
    }

    const entries: WatchEntry[] = [];
    for (const member of memberNames) {
      const fullName = `${varName}.${member}`;
      // 递归展开嵌套结构体
      const nested = await this.expandStructMembers(session, fullName, frameId);
      if (nested.length > 0) {
        entries.push(...nested);
      } else {
        // 基本类型成员：获取地址和类型
        const addrText = await this.safeEval(session, `print/x (unsigned long)&${fullName}`, frameId);
        if (!addrText) {
          continue;
        }
        const address = parseAddressFromPrint(addrText);
        if (address === undefined) {
          continue;
        }
        const dt = await this.queryDataType(session, fullName, frameId);
        if (!dt) {
          continue;
        }
        entries.push({
          name: fullName,
          address,
          dataType: dt,
          byteSize: byteSize(dt)
        });
      }
    }
    return entries;
  }

  private async safeEval(session: vscode.DebugSession, expression: string, frameId: number): Promise<string | undefined> {
    try {
      const result = (await session.customRequest('evaluate', {
        expression,
        frameId,
        context: 'repl'
      })) as { result?: string };
      return result?.result?.trim();
    } catch {
      return undefined;
    }
  }

  private async queryDataType(
    session: vscode.DebugSession,
    varName: string,
    frameId: number
  ): Promise<DataType | undefined> {
    try {
      const typeResult = (await session.customRequest('evaluate', {
        expression: `ptype ${varName}`,
        frameId,
        context: 'repl'
      })) as { result?: string };

      const sizeResult = (await session.customRequest('evaluate', {
        expression: `print (int)sizeof(${varName})`,
        frameId,
        context: 'repl'
      })) as { result?: string };

      return inferDataType(typeResult.result ?? '', sizeResult.result ?? '');
    } catch {
      return undefined;
    }
  }

  private async pickThreadId(session: vscode.DebugSession): Promise<number | undefined> {
    try {
      const r = (await session.customRequest('threads')) as { threads?: Array<{ id: number }> };
      return r.threads?.[0]?.id;
    } catch {
      return undefined;
    }
  }

  private async getTopFrameId(session: vscode.DebugSession, threadId: number): Promise<number | undefined> {
    try {
      const result = (await session.customRequest('stackTrace', {
        threadId,
        startFrame: 0,
        levels: 1
      })) as { stackFrames?: Array<{ id: number }> };
      return result.stackFrames?.[0]?.id;
    } catch {
      return undefined;
    }
  }

  private async connectOpenOcd(preferredPort: number): Promise<void> {
    const attempts = buildConnectionAttempts(preferredPort);
    const errors: string[] = [];

    for (const attempt of attempts) {
      try {
        if (attempt.mode === 'tcl') {
          const client = new OpenOcdTclClient('127.0.0.1', attempt.port);
          await client.connect();
          this.client = client;
          this.clientMode = 'tcl';
          this.endpointLabel = `tcl:${attempt.port}`;
          return;
        }
        const client = new TelnetClient();
        await client.connect('127.0.0.1', attempt.port);
        this.client = client;
        this.clientMode = 'telnet';
        this.endpointLabel = `telnet:${attempt.port}`;
        return;
      } catch (err) {
        errors.push(`${attempt.mode}:${attempt.port} ${toErrMsg(err)}`);
      }
    }

    throw new Error(`Cannot connect to OpenOCD live interface. Tried ${errors.join(' | ')}`);
  }

  private async closeClient(): Promise<void> {
    if (!this.client) {
      this.clientMode = undefined;
      this.endpointLabel = '';
      return;
    }
    if (this.clientMode === 'tcl') {
      (this.client as OpenOcdTclClient).disconnect();
    } else {
      await (this.client as TelnetClient).close();
    }
    this.client = undefined;
    this.clientMode = undefined;
    this.endpointLabel = '';
  }

  private async readViaTcl(client: OpenOcdTclClient, entry: WatchEntry): Promise<number | undefined> {
    switch (entry.dataType) {
      case 'INT8':
      case 'UINT8': {
        const values = await client.readMemory8(entry.address, 1);
        return interpretBytes(BigInt(values[0] ?? 0), entry.dataType);
      }
      case 'INT16':
      case 'UINT16': {
        const values = await client.readMemory16(entry.address, 1);
        return interpretBytes(BigInt(values[0] ?? 0), entry.dataType);
      }
      case 'INT32':
      case 'UINT32':
      case 'FLOAT': {
        const values = await client.readMemory32(entry.address, 1);
        return interpretBytes(BigInt(values[0] ?? 0), entry.dataType);
      }
      case 'DOUBLE': {
        const values = await client.readMemory32(entry.address, 2);
        if (values.length < 2) {
          return undefined;
        }
        const raw = (BigInt(values[1] >>> 0) << 32n) | BigInt(values[0] >>> 0);
        return interpretBytes(raw, entry.dataType);
      }
    }
  }

  private async writeViaTcl(client: OpenOcdTclClient, entry: WatchEntry, value: number): Promise<void> {
    switch (entry.dataType) {
      case 'INT8':
      case 'UINT8':
        await client.writeMemory8(entry.address, value);
        return;
      case 'INT16':
      case 'UINT16':
        await client.writeMemory16(entry.address, value);
        return;
      case 'INT32':
      case 'UINT32':
        await client.writeMemory32(entry.address, value);
        return;
      case 'FLOAT': {
        const buf = new ArrayBuffer(4);
        const dv = new DataView(buf);
        dv.setFloat32(0, value, true);
        await client.writeMemory32(entry.address, dv.getUint32(0, true));
        return;
      }
      case 'DOUBLE': {
        const buf = new ArrayBuffer(8);
        const dv = new DataView(buf);
        dv.setFloat64(0, value, true);
        await client.writeMemory32(entry.address, dv.getUint32(0, true));
        await client.writeMemory32(entry.address + 4, dv.getUint32(4, true));
        return;
      }
    }
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTelnetReadCommand(entry: WatchEntry): string {
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

function buildConnectionAttempts(preferredPort: number): Array<{ mode: 'telnet' | 'tcl'; port: number }> {
  const unique = new Set<string>();
  const attempts: Array<{ mode: 'telnet' | 'tcl'; port: number }> = [];
  const push = (mode: 'telnet' | 'tcl', port: number) => {
    const key = `${mode}:${port}`;
    if (unique.has(key)) {
      return;
    }
    unique.add(key);
    attempts.push({ mode, port });
  };

  push('tcl', preferredPort);
  push('telnet', preferredPort);
  push('tcl', 6666);
  push('telnet', 4444);
  return attempts;
}

function parseOpenocdResponse(response: string, dt: DataType): bigint | undefined {
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

function interpretBytes(rawValue: bigint, dataType: DataType): number {
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

function parseAddressFromPrint(result: string): number | undefined {
  const hex = result.match(/\$\d+\s*=\s*0x([0-9a-fA-F]+)/);
  if (hex) {
    return Number.parseInt(hex[1], 16);
  }
  const dec = result.match(/\$\d+\s*=\s*(\d+)/);
  if (dec) {
    return Number.parseInt(dec[1], 10);
  }

  const fallback = parseDebuggerNumber(result);
  if (fallback !== undefined) {
    return Math.floor(fallback);
  }
  return undefined;
}

function inferDataType(ptypeResult: string, sizeResult: string): DataType | undefined {
  const lower = ptypeResult.toLowerCase();

  // 检测 struct/class/union 类型，无法映射为单一基本类型
  if (isStructOrClass(ptypeResult)) {
    return undefined;
  }

  const size = parseDebuggerNumber(sizeResult) ?? 4;
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

/** 从 GDB ptype 输出中检测是否为 struct/class/union */
function isStructOrClass(ptypeText: string): boolean {
  // 移除开头的 "type = "
  const stripped = ptypeText.replace(/^type\s*=\s*/i, '').trim();
  return /^(struct|class|union)\b/i.test(stripped);
}

/**
 * 解析 GDB ptype 输出中的顶层成员名称。
 * 正确跳过嵌套 struct { ... } 内的成员，只提取本级成员。
 */
function parseMemberNames(ptypeOutput: string): string[] {
  const braceStart = ptypeOutput.indexOf('{');
  const braceEnd = ptypeOutput.lastIndexOf('}');
  if (braceStart < 0 || braceEnd < 0 || braceStart >= braceEnd) {
    return [];
  }

  const names: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = braceStart + 1; i < braceEnd; i += 1) {
    const ch = ptypeOutput[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    } else if (ch === ';' && depth === 0) {
      const name = extractMemberName(current);
      if (name) {
        names.push(name);
      }
      current = '';
    } else if (depth === 0) {
      current += ch;
    }
  }

  return names;
}

function extractMemberName(declaration: string): string | undefined {
  const trimmed = declaration.trim();
  if (!trimmed) {
    return undefined;
  }

  // 匿名 struct/union 定义（末尾为 } 但没有变量名）
  if (trimmed.endsWith('}')) {
    return undefined;
  }

  // 取最后一个 token
  const tokens = trimmed.split(/\s+/);
  let last = tokens[tokens.length - 1];

  // 去除数组符号: name[10] -> name
  const bracket = last.indexOf('[');
  if (bracket > 0) {
    last = last.substring(0, bracket);
  }

  // 去除位域: name:1 -> name
  const colon = last.indexOf(':');
  if (colon > 0) {
    last = last.substring(0, colon);
  }

  // 验证为合法标识符
  if (last && /^[a-zA-Z_]\w*$/.test(last)) {
    return last;
  }

  return undefined;
}

function byteSize(dataType: DataType): number {
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

function toErrMsg(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)));
}

function clampUint(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return 0;
  const clamped = Math.max(min, Math.min(max, Math.round(v)));
  return clamped >>> 0;
}
