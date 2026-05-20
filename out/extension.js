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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const controller_1 = require("./controller");
const panel_1 = require("./ui/panel");
const logger_1 = require("./services/logger");
let controller;
async function activate(context) {
    (0, logger_1.activateLogger)(context);
    (0, logger_1.log)('Extension activating...');
    const viewProvider = new panel_1.WaveformViewProvider(context);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(panel_1.WaveformViewProvider.viewType, viewProvider));
    controller = new controller_1.WaveformController(context, viewProvider);
    context.subscriptions.push(controller);
    await controller.initialize();
    context.subscriptions.push(vscode.commands.registerCommand('waveformPlotter.addSelection', async () => {
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
    }));
    context.subscriptions.push(vscode.commands.registerCommand('waveformPlotter.focus', async () => {
        await controller?.openView();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('waveformPlotter.open', async () => {
        await controller?.openView();
    }));
}
async function deactivate() {
    if (controller) {
        await controller.stopAllLive();
        controller.dispose();
        controller = undefined;
    }
}
//# sourceMappingURL=extension.js.map