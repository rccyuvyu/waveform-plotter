"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WaveformViewProvider = void 0;
const vscode = __importStar(require("vscode"));
class WaveformViewProvider {
    constructor(context) {
        this.context = context;
    }
    resolveWebviewView(view) {
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
    setMessageHandler(handler) {
        this.handler = handler;
    }
    hasView() {
        return !!this.view;
    }
    postState(state) {
        if (!this.view) {
            this.pendingState = state;
            return;
        }
        void this.view.webview.postMessage({ type: 'state', state });
    }
    postAppend(append) {
        if (!this.view) {
            return;
        }
        void this.view.webview.postMessage({ type: 'append', append });
    }
    async reveal() {
        await vscode.commands.executeCommand('workbench.view.extension.waveformPlotter');
    }
    getHtml(webview) {
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
          <option value="120">120 fps</option>
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
exports.WaveformViewProvider = WaveformViewProvider;
WaveformViewProvider.viewType = 'waveformPlotter.view';
function getNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 24; i += 1) {
        out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
}
//# sourceMappingURL=panel.js.map