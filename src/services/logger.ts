import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

export function activateLogger(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('Waveform Plotter');
  context.subscriptions.push(outputChannel);
}

export function log(message: string): void {
  console.log(`[waveform-plotter] ${message}`);
  outputChannel?.appendLine(`[${timestamp()}] ${message}`);
}

export function warn(message: string): void {
  console.warn(`[waveform-plotter] ${message}`);
  outputChannel?.appendLine(`[${timestamp()}] WARN: ${message}`);
}

export function error(message: string, err?: unknown): void {
  const detail = err instanceof Error ? ` ${err.message}` : '';
  console.error(`[waveform-plotter] ${message}${detail}`);
  outputChannel?.appendLine(`[${timestamp()}] ERROR: ${message}${detail}`);
}

function timestamp(): string {
  const d = new Date();
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}
