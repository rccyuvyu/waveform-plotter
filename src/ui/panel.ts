import * as vscode from 'vscode';
import { TreeViewRow } from '../core/types';

export interface WaveformViewState {
  bufferCapacity: number;
  variables: Array<{
    name: string;
    checked: boolean;
    valueText: string;
    color: string;
  }>;
  treeVariables: TreeViewRow[];
  data?: {
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

export interface WaveformAppendState {
  totalSamples: number;
  timestampsSec: number[];
  channels: Array<{ name: string; data: number[] }>;
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

  hasView(): boolean {
    return !!this.view;
  }

  postState(state: WaveformViewState): void {
    if (!this.view) {
      this.pendingState = state;
      return;
    }
    void this.view.webview.postMessage({ type: 'state', state });
  }

  postAppend(append: WaveformAppendState): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({ type: 'append', append });
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
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
    <button id="xZoomOutBtn" title="Zoom out time axis">X-</button>
    <span id="timeScaleBadge" class="metricBadge">X Tick --</span>
    <button id="xZoomInBtn" title="Zoom in time axis">X+</button>
    <span class="split"></span>
    <button id="liveBtn">▶ Live</button>
    <select id="sourceSel">
      <option>Telnet</option>
      <option>RTT</option>
    </select>
    <input id="freqInput" type="number" min="1" max="10000" step="1" />
    <label id="freqLabel">Target Hz</label>
    <button id="settingsBtn">⚙</button>
  </div>

  <div class="inputRow">
    <label>Variable:</label>
    <input id="varInput" type="text" placeholder="变量名或表达式" />
    <button id="addBtn" type="button">+ Add</button>
  </div>

  <div class="plotWrap">
    <canvas id="plotCanvas"></canvas>
  </div>

  <div class="variable-inspector" id="variableInspector">
    <div class="inspector-header" id="inspectorHeader">
      <span class="inspector-title">Variables</span>
      <span id="inspectorToggle">&#9660;</span>
    </div>
    <div class="inspector-body" id="inspectorBody">
      <table class="inspector-table">
        <colgroup>
          <col style="width:46%">
          <col style="width:24%">
          <col style="width:14%">
          <col style="width:16%">
        </colgroup>
        <thead>
          <tr><th>Name</th><th>Value</th><th>Type</th><th>Address</th></tr>
        </thead>
        <tbody id="inspectorTbody"></tbody>
      </table>
    </div>
  </div>

  <div class="statusRow">
    <div id="statusLeft"></div>
    <div id="statusMid"></div>
    <div id="statusRight"></div>
  </div>

  <dialog id="settingsDlg">
    <form id="settingsForm" method="dialog">
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
          <option value="120">120 fps</option>
        </select>
      </label>
      <div class="actions">
        <button id="cancelSettingsBtn" type="submit" value="cancel">Cancel</button>
        <button id="saveSettingsBtn" type="submit" value="default">Save</button>
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
