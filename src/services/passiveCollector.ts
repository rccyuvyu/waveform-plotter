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

    const threadId = this.lastStoppedThreadId ?? (await this.pickThreadId(session));
    if (!threadId) {
      return;
    }

    const frameId = await this.getTopFrameId(session, threadId);
    if (frameId === undefined) {
      return;
    }

    const values = new Map<string, number>();
    for (const varName of trackedVariables) {
      const parsed = await this.evaluateNumber(session, varName, frameId);
      if (parsed !== undefined) {
        values.set(varName, parsed);
      }
    }

    if (values.size === 0) {
      return;
    }

    for (const name of trackedVariables) {
      if (!this.dataBuffer.getChannels().some((c) => c.name === name)) {
        this.dataBuffer.addChannel(name);
      }
    }

    const aligned = new Map<string, number>();
    for (const name of trackedVariables) {
      aligned.set(name, values.get(name) ?? Number.NaN);
    }

    this.dataBuffer.pushAll(aligned, process.hrtime.bigint());
    this.sampleCount += 1;
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
