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
const diff_match_patch_1 = require("diff-match-patch");
const dmp = new diff_match_patch_1.diff_match_patch();
let enabled = true;
const baselineByDoc = new Map();
let decorationType = null;
let timers = new Map();
function keyFor(doc) {
    return doc.uri.toString();
}
function getConfig() {
    const cfg = vscode.workspace.getConfiguration('inlineChangeHighlighter');
    return {
        enabled: cfg.get('enabled', true),
        color: cfg.get('color', 'rgba(255,215,0,0.35)'),
        border: cfg.get('border', '1px solid rgba(255,215,0,0.7)'),
        debounceMs: cfg.get('debounceMs', 200),
        maxFileSizeKb: cfg.get('maxFileSizeKb', 1024),
        languages: cfg.get('languages', []),
        includeWhitespace: cfg.get('includeWhitespace', true)
    };
}
function ensureDecorationType() {
    const cfg = getConfig();
    if (decorationType)
        decorationType.dispose();
    decorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: cfg.color,
        border: cfg.border
    });
}
function shouldProcess(doc) {
    const cfg = getConfig();
    if (!enabled || !cfg.enabled)
        return false;
    const kb = Buffer.byteLength(doc.getText(), 'utf8') / 1024;
    if (kb > cfg.maxFileSizeKb)
        return false;
    if (cfg.languages && cfg.languages.length > 0) {
        return cfg.languages.includes(doc.languageId);
    }
    return true;
}
function rebaseline(doc) {
    baselineByDoc.set(keyFor(doc), doc.getText());
}
function clearDecorations(editor) {
    if (editor && decorationType) {
        editor.setDecorations(decorationType, []);
    }
    else {
        for (const ed of vscode.window.visibleTextEditors) {
            if (decorationType)
                ed.setDecorations(decorationType, []);
        }
    }
}
function scheduleDiff(editor) {
    const cfg = getConfig();
    const k = keyFor(editor.document);
    const existing = timers.get(k);
    if (existing)
        clearTimeout(existing);
    timers.set(k, setTimeout(() => runDiff(editor), cfg.debounceMs));
}
function runDiff(editor) {
    if (!decorationType)
        return;
    const doc = editor.document;
    if (!shouldProcess(doc)) {
        clearDecorations(editor);
        return;
    }
    const baseline = baselineByDoc.get(keyFor(doc)) ?? '';
    const current = doc.getText();
    // Diff baseline vs current
    const diffs = dmp.diff_main(baseline, current);
    dmp.diff_cleanupSemantic(diffs);
    // Build ranges for INSERTs (and replacements as inserts)
    const cfg = getConfig();
    let newOffset = 0;
    let oldOffset = 0;
    const ranges = [];
    for (const [op, text] of diffs) {
        const len = text.length;
        if (op === diff_match_patch_1.DIFF_EQUAL) {
            oldOffset += len;
            newOffset += len;
        }
        else if (op === diff_match_patch_1.DIFF_INSERT) {
            if (cfg.includeWhitespace || /\S/.test(text)) {
                const start = doc.positionAt(newOffset);
                const end = doc.positionAt(newOffset + len);
                ranges.push(new vscode.Range(start, end));
            }
            newOffset += len;
        }
        else if (op === diff_match_patch_1.DIFF_DELETE) {
            oldOffset += len;
            // deletions don't exist in current text; we skip inline mark
            // (Optional: could add 'after' ghost marker at position newOffset)
        }
    }
    editor.setDecorations(decorationType, ranges);
}
function activate(context) {
    ensureDecorationType();
    enabled = getConfig().enabled;
    // On open: set baseline to the current (saved) text.
    vscode.workspace.textDocuments.forEach(doc => rebaseline(doc));
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => rebaseline(doc)), vscode.workspace.onDidChangeTextDocument(e => {
        const editor = vscode.window.visibleTextEditors.find(ed => ed.document === e.document);
        if (!editor)
            return;
        scheduleDiff(editor);
    }), vscode.workspace.onDidSaveTextDocument(doc => {
        rebaseline(doc);
        // Clear highlights on save
        const ed = vscode.window.visibleTextEditors.find(e => e.document === doc);
        if (ed)
            clearDecorations(ed);
    }), vscode.window.onDidChangeActiveTextEditor(editor => {
        if (!editor)
            return;
        // Recompute for newly focused editor
        scheduleDiff(editor);
    }), vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('inlineChangeHighlighter')) {
            ensureDecorationType();
            enabled = getConfig().enabled;
            // Refresh current editor
            const ed = vscode.window.activeTextEditor;
            if (ed)
                scheduleDiff(ed);
        }
    }), vscode.commands.registerCommand('inlineChangeHighlighter.toggle', () => {
        enabled = !enabled;
        if (!enabled) {
            clearDecorations();
        }
        else if (vscode.window.activeTextEditor) {
            scheduleDiff(vscode.window.activeTextEditor);
        }
        vscode.window.showInformationMessage(`Inline Change Highlighter ${enabled ? 'enabled' : 'disabled'}`);
    }), vscode.commands.registerCommand('inlineChangeHighlighter.rebaseline', () => {
        const ed = vscode.window.activeTextEditor;
        if (!ed)
            return;
        rebaseline(ed.document);
        clearDecorations(ed);
        vscode.window.showInformationMessage('Rebaselined to current file content.');
    }));
}
function deactivate() {
    if (decorationType)
        decorationType.dispose();
    timers.forEach(t => clearTimeout(t));
    timers.clear();
    baselineByDoc.clear();
}
//# sourceMappingURL=extension.js.map