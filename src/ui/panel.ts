import * as vscode from 'vscode';

export interface WaveformViewState {
  variables: Array<{
    name: string;
    checked: boolean;
    valueText: string;
    color: string;
  }>;
  data: {
    channels: Array<{ name: string; color: string; data: number[] }>;
    timestampsSec: number[];
    version: number;
  };
  status: string;
  sessionStatus: string;
  liveStatus: string;
  recording: boolean;
  liveRunning: boolean;
  dataSource: 'Telnet' | 'RTT';
  frequencyHz: number;
  displayMode: 'TIME' | 'FFT';
  timeUnit: 'ms' | 'us';
  fontSize: number;
  lineWidth: number;
  refreshFps: number;
  settings: {
    telnetPort: number;
    rttPort: number;
    rttRamStart: string;
    rttRamSize: string;
    rttAutoInit: boolean;
  };
}

export type UiMessageHandler = (message: any) => void;

export class WaveformViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'waveformPlotter.view';

  private view: vscode.WebviewView | undefined;
  private handler: UiMessageHandler | undefined;
  private pendingState: WaveformViewState | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media')
      ]
    };

    view.webview.html = this.getHtml(view.webview);

    view.webview.onDidReceiveMessage((message) => {
      this.handler?.(message);
    });

    if (this.pendingState) {
      this.postState(this.pendingState);
      this.pendingState = undefined;
    }
  }

  setMessageHandler(handler: UiMessageHandler): void {
    this.handler = handler;
  }

  postState(state: WaveformViewState): void {
    if (!this.view) {
      this.pendingState = state;
      return;
    }
    void this.view.webview.postMessage({ type: 'state', state });
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.waveformPlotter');
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'styles.css'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Waveform Plotter</title>
</head>
<body>
  <div class="toolbar">
    <button id="recordBtn">● Record</button>
    <button id="stopBtn">■ Stop</button>
    <button id="clearBtn">↻ Clear</button>
    <button id="exportBtn">Export CSV</button>
    <span class="split"></span>
    <button id="timeBtn">Time</button>
    <button id="fftBtn">FFT</button>
    <button id="timeUnitBtn">ms</button>
    <span class="split"></span>
    <button id="liveBtn">▶ Live</button>
    <select id="sourceSel">
      <option>Telnet</option>
      <option>RTT</option>
    </select>
    <input id="freqInput" type="number" min="1" max="2000" step="1" />
    <label id="freqLabel">Hz</label>
    <button id="settingsBtn">⚙</button>
  </div>

  <div class="inputRow">
    <label>Variable:</label>
    <input id="varInput" type="text" placeholder="变量名或表达式" />
    <button id="addBtn">+ Add</button>
  </div>

  <div class="channels" id="channels"></div>

  <div class="plotWrap">
    <canvas id="plotCanvas"></canvas>
  </div>

  <div class="statusRow">
    <div id="statusLeft"></div>
    <div id="statusMid"></div>
    <div id="statusRight"></div>
  </div>

  <dialog id="settingsDlg">
    <form method="dialog">
      <h3>Settings</h3>
      <label>Telnet Port <input id="telnetPort" type="number" min="1" max="65535" /></label>
      <label>RTT Port <input id="rttPort" type="number" min="1" max="65535" /></label>
      <label>RAM Start <input id="ramStart" type="text" placeholder="0x20000000" /></label>
      <label>RAM Size <input id="ramSize" type="text" placeholder="0x10000" /></label>
      <label class="checkbox"><input id="autoInit" type="checkbox" /> OpenOCD Auto Init</label>
      <label>Font Size <input id="fontSize" type="number" min="8" max="20" /></label>
      <label>Line Width <input id="lineWidth" type="number" min="0.5" max="5" step="0.5" /></label>
      <label>Refresh FPS
        <select id="refreshFps">
          <option value="30">30 fps</option>
          <option value="60">60 fps</option>
        </select>
      </label>
      <div class="actions">
        <button value="cancel">Cancel</button>
        <button id="saveSettingsBtn" value="default">Save</button>
      </div>
    </form>
  </dialog>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 24; i += 1) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
