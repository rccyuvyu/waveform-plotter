import * as vscode from 'vscode';
import { DataBuffer } from '../core/dataBuffer';

export class PassiveCollector {
  recording = false;
  sampleCount = 0;
  private lastStoppedThreadId: number | undefined;

  constructor(private readonly dataBuffer: DataBuffer) {}

  rememberStoppedThread(threadId: number | undefined): void {
    if (threadId !== undefined) {
      this.lastStoppedThreadId = threadId;
    }
  }

  async collectFromSession(session: vscode.DebugSession, trackedVariables: string[]): Promise<void> {
    if (!this.recording || trackedVariables.length === 0) {
      return;
    }

    const values = await this.readCurrentValues(session, trackedVariables);
    if (values.size === 0) {
      return;
    }

    const collectedNames = [...values.keys()];
    for (const name of collectedNames) {
      if (!this.dataBuffer.getChannels().some((c) => c.name === name)) {
        this.dataBuffer.addChannel(name);
      }
    }

    const aligned = new Map<string, number>();
    for (const name of collectedNames) {
      aligned.set(name, values.get(name) ?? Number.NaN);
    }

    this.dataBuffer.pushAll(aligned, process.hrtime.bigint());
    this.sampleCount += 1;
  }

  async readCurrentValues(session: vscode.DebugSession, trackedVariables: string[]): Promise<Map<string, number>> {
    const values = new Map<string, number>();
    if (trackedVariables.length === 0) {
      return values;
    }

    const threadId = this.lastStoppedThreadId ?? (await this.pickThreadId(session));
    if (!threadId) {
      return values;
    }

    const frameId = await this.getTopFrameId(session, threadId);
    if (frameId === undefined) {
      return values;
    }

    for (const varName of trackedVariables) {
      if (isCompoundExpression(varName)) {
        const parsed = await this.evaluateNumber(session, varName, frameId);
        if (parsed !== undefined) {
          values.set(varName, parsed);
        }
        continue;
      }

      const ptype = await this.safeEval(session, ptypeExpressionCommand(varName), frameId);
      if (ptype && isStructType(ptype)) {
        // 结构体：展开为成员逐个求值
        const memberNames = parseStructMemberNames(ptype);
        for (const member of memberNames) {
          const fullName = `${varName}.${member}`;
          const parsed = await this.evaluateNumber(session, fullName, frameId);
          if (parsed !== undefined) {
            values.set(fullName, parsed);
          }
        }
      } else {
        const parsed = await this.evaluateNumber(session, varName, frameId);
        if (parsed !== undefined) {
          values.set(varName, parsed);
        }
      }
    }
    return values;
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

  resetSampleCount(): void {
    this.sampleCount = 0;
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

  private async evaluateNumber(session: vscode.DebugSession, expression: string, frameId: number): Promise<number | undefined> {
    try {
      const result = (await session.customRequest('evaluate', {
        expression,
        frameId,
        context: 'watch'
      })) as { result?: string };

      if (!result.result) {
        return undefined;
      }
      return parseDebuggerNumber(result.result);
    } catch {
      return undefined;
    }
  }
}

export function parseDebuggerNumber(raw: string): number | undefined {
  const cleaned = raw
    .trim()
    .replace(/'.*'/g, '')
    .replace(/\b(true)\b/i, '1')
    .replace(/\b(false)\b/i, '0')
    .replace(/\b(?:u|ul|ull|l|ll|f)\b/gi, '')
    .replace(/,/g, '')
    .trim();

  const assignMatch = cleaned.match(/=\s*([^,}]+)/);
  const valueText = (assignMatch?.[1] ?? cleaned).trim();

  if (/^[-+]?0x[0-9a-f]+$/i.test(valueText)) {
    return Number.parseInt(valueText, 16);
  }

  const n = Number(valueText);
  if (!Number.isNaN(n) && Number.isFinite(n)) {
    return n;
  }

  const floatMatch = valueText.match(/[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/);
  if (floatMatch) {
    const m = Number(floatMatch[0]);
    if (!Number.isNaN(m)) {
      return m;
    }
  }

  return undefined;
}

/** 检测 GDB ptype 输出是否为 struct/class/union */
export function isStructType(ptypeText: string): boolean {
  const stripped = ptypeText.replace(/^type\s*=\s*/i, '').trim();
  return /^(struct|class|union)\b/i.test(stripped);
}

/** 解析 GDB ptype 输出中的顶层成员名（跳过嵌套层级） */
export function parseStructMemberNames(ptypeOutput: string): string[] {
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

function ptypeExpressionCommand(expression: string): string {
  return `ptype (${expression})`;
}

function isCompoundExpression(expression: string): boolean {
  return expression.includes('.')
    || expression.includes('->')
    || expression.includes('[');
}

function extractMemberName(declaration: string): string | undefined {
  const trimmed = declaration.trim();
  if (!trimmed || trimmed.endsWith('}')) {
    return undefined;
  }
  const tokens = trimmed.split(/\s+/);
  let last = tokens[tokens.length - 1];
  const bracket = last.indexOf('[');
  if (bracket > 0) {
    last = last.substring(0, bracket);
  }
  const colon = last.indexOf(':');
  if (colon > 0) {
    last = last.substring(0, colon);
  }
  if (last && /^[a-zA-Z_]\w*$/.test(last)) {
    return last;
  }
  return undefined;
}
