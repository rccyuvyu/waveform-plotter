import * as vscode from 'vscode';
import { LiveWatchService, ServiceEvent } from '../service/liveWatchService';
import { DisplayFormat } from '../model/watchNode';

/**
 * Provides the WebView-based Live Watch panel in the bottom panel area.
 */
export class LiveWatchViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'livewatch.watchView';

    private view?: vscode.WebviewView;
    private service: LiveWatchService;
    private extensionUri: vscode.Uri;

    constructor(extensionUri: vscode.Uri, service: LiveWatchService) {
        this.extensionUri = extensionUri;
        this.service = service;

        // Listen for service events
        this.service.onEvent((event: ServiceEvent) => {
            this.handleServiceEvent(event);
        });
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'media'),
            ],
        };

        webviewView.webview.html = this.getHtmlContent(webviewView.webview);

        // Handle messages from the WebView
        webviewView.webview.onDidReceiveMessage(msg => this.handleWebviewMessage(msg));

        // When the view becomes visible, send current state
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.sendFullState();
            }
        });

        // Send initial state after a short delay to let the WebView initialize
        setTimeout(() => this.sendFullState(), 100);

        // Auto-connect on first open
        this.service.tryConnect();
    }

    // ── Message handling ───────────────────────────────────────

    private handleWebviewMessage(msg: any): void {
        switch (msg.type) {
            case 'addWatch':
                this.service.addWatch(msg.name, true, msg.reqId);
                break;
            case 'removeWatch':
                this.service.removeWatch(msg.nodeId);
                break;
            case 'toggleExpand':
                this.service.toggleExpand(msg.nodeId);
                break;
            case 'writeValue':
                this.service.writeValue(msg.nodeId, msg.value);
                break;
            case 'setFormat':
                this.service.setDisplayFormat(msg.nodeId, msg.format as DisplayFormat);
                break;
            case 'togglePause':
                this.service.togglePause();
                break;
            case 'clearAll':
                this.service.clearAll();
                break;
            case 'connect':
                this.service.tryConnect(false);
                break;
            case 'refreshSymbols':
                this.service.refreshSymbols();
                break;
            case 'openSettings':
                vscode.commands.executeCommand('workbench.action.openSettings', 'livewatch');
                break;
            case 'ready':
                this.sendFullState();
                break;
        }
    }

    private handleServiceEvent(event: ServiceEvent): void {
        if (!this.view) { return; }
        switch (event.type) {
            case 'treeUpdate':
                this.postMessage({ type: 'updateTree', rows: event.rows });
                break;
            case 'connectionChange':
                this.postMessage({ type: 'connectionState', state: event.connectionState });
                break;
            case 'pauseChange':
                this.postMessage({ type: 'pauseState', paused: event.paused });
                break;
            case 'addWatchResult':
                this.postMessage({
                    type: 'addWatchResult',
                    name: event.addWatchName,
                    success: event.addWatchSuccess,
                    reqId: event.addWatchReqId,
                    message: event.message,
                });
                break;
            case 'error':
                this.postMessage({ type: 'error', message: event.message });
                vscode.window.showWarningMessage(`Live Watch: ${event.message}`);
                break;
        }
    }

    private sendFullState(): void {
        if (!this.view) { return; }
        this.postMessage({
            type: 'fullState',
            rows: this.service.getRows(),
            connectionState: this.service.getConnectionState(),
            paused: this.service.isPaused(),
            elfPath: this.service.getElfPath(),
        });
    }

    private postMessage(msg: any): void {
        this.view?.webview.postMessage(msg);
    }

    // ── HTML Generation ────────────────────────────────────────

    private getHtmlContent(webview: vscode.Webview): string {
        const cssUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css')
        );
        const jsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js')
        );

        const nonce = getNonce();

        return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${webview.cspSource} 'unsafe-inline';
                   script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${cssUri}">
    <title>Live Watch</title>
</head>
<body>
    <!-- Toolbar -->
    <div class="toolbar">
        <div class="toolbar-left">
            <button id="btn-connect" class="toolbar-btn" title="Connect to OpenOCD">
                <span class="status-dot disconnected"></span>
                <span>Connect</span>
            </button>
            <button id="btn-pause" class="toolbar-btn" title="Pause/Resume polling">
                <span class="codicon codicon-debug-pause"></span>
                <span id="btn-pause-label">Pause</span>
            </button>
            <button id="btn-refresh" class="toolbar-btn" title="Re-resolve all symbols">
                <span class="codicon codicon-refresh"></span>
            </button>
            <button id="btn-clear" class="toolbar-btn" title="Clear all watches">
                <span class="codicon codicon-clear-all"></span>
            </button>
            <button id="btn-settings" class="toolbar-btn" title="Open settings">
                <span class="codicon codicon-gear"></span>
            </button>
        </div>
        <div class="toolbar-right">
            <span id="status-text" class="status-text">Disconnected</span>
        </div>
    </div>

    <!-- Watch Table -->
    <div class="table-container">
        <table class="watch-table">
            <colgroup>
                <col id="col-name">
                <col id="col-value">
                <col id="col-address">
                <col id="col-type">
            </colgroup>
            <thead>
                <tr>
                    <th class="col-name" data-col="name">Name</th>
                    <th class="col-value" data-col="value">Value</th>
                    <th class="col-address" data-col="address">Address</th>
                    <th class="col-type" data-col="type">Type</th>
                </tr>
            </thead>
            <tbody id="watch-tbody">
                <!-- Rows rendered by JS -->
            </tbody>
        </table>
    </div>

    <!-- Context Menu -->
    <div id="context-menu" class="context-menu hidden">
        <div class="context-menu-item" data-format="auto">Auto Format</div>
        <div class="context-menu-item" data-format="hex">Hexadecimal</div>
        <div class="context-menu-item" data-format="decimal">Decimal</div>
        <div class="context-menu-item" data-format="float">Float</div>
        <div class="context-menu-item" data-format="binary">Binary</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="remove">Delete Watch</div>
    </div>

    <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}
