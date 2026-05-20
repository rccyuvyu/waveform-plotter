import * as vscode from 'vscode';
import { WaveformController } from './controller';
import { WaveformViewProvider } from './ui/panel';
import { activateLogger, log } from './services/logger';

let controller: WaveformController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  activateLogger(context);
  log('Extension activating...');

  const viewProvider = new WaveformViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WaveformViewProvider.viewType, viewProvider)
  );

  controller = new WaveformController(context, viewProvider);
  context.subscriptions.push(controller);
  await controller.initialize();

  context.subscriptions.push(
    vscode.commands.registerCommand('waveformPlotter.addSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const selection = editor.selection;
      const selectedText = editor.document.getText(selection).trim();
      if (!selectedText || selectedText.includes('\n')) {
        return;
      }
      await controller?.openView();
      await controller?.addVariable(selectedText, true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('waveformPlotter.focus', async () => {
      await controller?.openView();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('waveformPlotter.open', async () => {
      await controller?.openView();
    })
  );
}

export async function deactivate(): Promise<void> {
  if (controller) {
    await controller.stopAllLive();
    controller.dispose();
    controller = undefined;
  }
}
