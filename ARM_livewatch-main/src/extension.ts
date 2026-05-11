import * as vscode from 'vscode';
import { LiveWatchService } from './service/liveWatchService';
import { LiveWatchViewProvider } from './panel/liveWatchViewProvider';

let service: LiveWatchService;

export function activate(context: vscode.ExtensionContext) {
    service = new LiveWatchService(context);

    // Register the WebView panel provider
    const provider = new LiveWatchViewProvider(context.extensionUri, service);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            LiveWatchViewProvider.viewType,
            provider,
            { webviewOptions: { retainContextWhenHidden: true } },
        )
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('livewatch.addWatch', async () => {
            const name = await vscode.window.showInputBox({
                prompt: 'Enter variable name to watch',
                placeHolder: 'e.g. speed_pid, motor.output',
            });
            if (name) {
                await service.addWatch(name);
            }
        }),

        vscode.commands.registerCommand('livewatch.removeWatch', () => {
            // Handled via webview context menu
        }),

        vscode.commands.registerCommand('livewatch.pausePolling', () => {
            if (!service.isPaused()) { service.togglePause(); }
        }),

        vscode.commands.registerCommand('livewatch.resumePolling', () => {
            if (service.isPaused()) { service.togglePause(); }
        }),

        vscode.commands.registerCommand('livewatch.clearAll', () => {
            service.clearAll();
        }),

        vscode.commands.registerCommand('livewatch.refreshSymbols', () => {
            service.refreshSymbols();
        }),
    );

    context.subscriptions.push(service);

    // Auto-reveal the LiveWatch view on first activation
    setTimeout(() => {
        vscode.commands.executeCommand('workbench.view.extension.livewatch-sidebar');
    }, 500);
}

export function deactivate() {
    if (service) {
        service.dispose();
    }
}
