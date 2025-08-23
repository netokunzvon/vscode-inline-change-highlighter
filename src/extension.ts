import * as vscode from 'vscode';
import {
  diff_match_patch,
  DIFF_EQUAL,
  DIFF_INSERT,
  DIFF_DELETE,
  type Diff
} from 'diff-match-patch';

type DocKey = string;

const dmp = new diff_match_patch();

let enabled = true;

const baselineByDoc = new Map<DocKey, string>();
let decorationType: vscode.TextEditorDecorationType | null = null;
let timers = new Map<DocKey, ReturnType<typeof setTimeout>>();

/* ---------- Donation prompt keys ---------- */
const DONATION_NEVER_KEY = 'ich.donate.never';
const DONATION_LAST_SHOWN_KEY = 'ich.donate.lastShown';
const DONATION_EDIT_COUNT_KEY = 'ich.donate.editCount';

function keyFor(doc: vscode.TextDocument): DocKey {
  return doc.uri.toString();
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('inlineChangeHighlighter');
  return {
    enabled: cfg.get<boolean>('enabled', true),
    color: cfg.get<string>('color', 'rgba(255,215,0,0.35)'),
    border: cfg.get<string>('border', '1px solid rgba(255,215,0,0.7)'),
    debounceMs: cfg.get<number>('debounceMs', 200),
    maxFileSizeKb: cfg.get<number>('maxFileSizeKb', 1024),
    languages: cfg.get<string[]>('languages', []),
    includeWhitespace: cfg.get<boolean>('includeWhitespace', true),

    donationEnable: cfg.get<boolean>('donation.enablePrompt', true),
    donationIntervalDays: cfg.get<number>('donation.intervalDays', 14),
    donationEditThreshold: cfg.get<number>('donation.editThreshold', 200),
    donationPaypalUrl: cfg.get<string>('donation.paypalUrl', 'https://paypal.me/netof01'),
    donationCashUrl: cfg.get<string>('donation.cashAppUrl', 'https://cash.app/$netokunz')
  };
}

function ensureDecorationType() {
  const cfg = getConfig();
  if (decorationType) decorationType.dispose();
  decorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: cfg.color,
    border: cfg.border
  });
}

function shouldProcess(doc: vscode.TextDocument): boolean {
  const cfg = getConfig();
  if (!enabled || !cfg.enabled) return false;

  const kb = Buffer.byteLength(doc.getText(), 'utf8') / 1024;
  if (kb > cfg.maxFileSizeKb) return false;

  if (cfg.languages && cfg.languages.length > 0) {
    return cfg.languages.includes(doc.languageId);
  }
  return true;
}

function rebaseline(doc: vscode.TextDocument) {
  baselineByDoc.set(keyFor(doc), doc.getText());
}

function clearDecorations(editor?: vscode.TextEditor) {
  if (editor && decorationType) {
    editor.setDecorations(decorationType, []);
  } else {
    for (const ed of vscode.window.visibleTextEditors) {
      if (decorationType) ed.setDecorations(decorationType, []);
    }
  }
}

function scheduleDiff(editor: vscode.TextEditor) {
  const cfg = getConfig();
  const k = keyFor(editor.document);
  const existing = timers.get(k);
  if (existing) clearTimeout(existing);
  timers.set(k, setTimeout(() => runDiff(editor), cfg.debounceMs));
}

function runDiff(editor: vscode.TextEditor) {
  if (!decorationType) return;
  const doc = editor.document;
  if (!shouldProcess(doc)) {
    clearDecorations(editor);
    return;
  }

  const baseline = baselineByDoc.get(keyFor(doc)) ?? '';
  const current = doc.getText();

  // Diff baseline vs current
  const diffs = dmp.diff_main(baseline, current) as Diff[];
  dmp.diff_cleanupSemantic(diffs);

  // Build ranges for INSERTs (and replacements as inserts)
  const cfg = getConfig();
  let newOffset = 0;
  let oldOffset = 0;
  const ranges: vscode.Range[] = [];

  for (const [op, text] of diffs) {
    const len = text.length;
    if (op === DIFF_EQUAL) {
      oldOffset += len;
      newOffset += len;
    } else if (op === DIFF_INSERT) {
      if (cfg.includeWhitespace || /\S/.test(text)) {
        const start = doc.positionAt(newOffset);
        const end = doc.positionAt(newOffset + len);
        ranges.push(new vscode.Range(start, end));
      }
      newOffset += len;
    } else if (op === DIFF_DELETE) {
      oldOffset += len;
      // deletions don't exist in current text; skip inline mark
    }
  }

  editor.setDecorations(decorationType, ranges);
}

/* ---------- Donation prompt helpers ---------- */

function daysSince(ms: number) {
  const ONE_DAY = 24 * 60 * 60 * 1000;
  return (Date.now() - ms) / ONE_DAY;
}

async function maybeShowDonationPrompt(context: vscode.ExtensionContext) {
  const cfg = getConfig();
  if (!cfg.donationEnable) return;

  const never = context.globalState.get<boolean>(DONATION_NEVER_KEY, false);
  if (never) return;

  const lastShown = context.globalState.get<number | undefined>(DONATION_LAST_SHOWN_KEY, undefined);
  const editCount = context.globalState.get<number>(DONATION_EDIT_COUNT_KEY, 0);

  const longEnoughSinceLast =
    !lastShown || daysSince(lastShown) >= cfg.donationIntervalDays;
  const enoughEdits = editCount >= cfg.donationEditThreshold;

  if (!longEnoughSinceLast || !enoughEdits) return;

  const choice = await vscode.window.showInformationMessage(
    'Enjoying Inline Change Highlighter? If it helps you, please consider supporting continued development ❤️',
    'Donate (PayPal)', 'Donate (Cash App)', 'Later', 'Never'
  );

  if (!choice) return;

  if (choice.startsWith('Donate')) {
    const url = choice.includes('PayPal') ? cfg.donationPaypalUrl : cfg.donationCashUrl;
    vscode.env.openExternal(vscode.Uri.parse(url));
  }

  if (choice === 'Never') {
    await context.globalState.update(DONATION_NEVER_KEY, true);
  } else {
    await context.globalState.update(DONATION_LAST_SHOWN_KEY, Date.now());
    await context.globalState.update(DONATION_EDIT_COUNT_KEY, 0); // reset counter after showing
  }
}

async function bumpEditCounter(context: vscode.ExtensionContext) {
  const n = context.globalState.get<number>(DONATION_EDIT_COUNT_KEY, 0);
  await context.globalState.update(DONATION_EDIT_COUNT_KEY, n + 1);
}

export function activate(context: vscode.ExtensionContext) {
  ensureDecorationType();
  enabled = getConfig().enabled;

  // On open: set baseline to the current (saved) text.
  vscode.workspace.textDocuments.forEach(doc => rebaseline(doc));

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => rebaseline(doc)),

    vscode.workspace.onDidChangeTextDocument(async e => {
      const editor = vscode.window.visibleTextEditors.find(ed => ed.document === e.document);
      if (!editor) return;
      scheduleDiff(editor);
      await bumpEditCounter(context);
      // evaluate donation prompt occasionally (cheap checks)
      maybeShowDonationPrompt(context);
    }),

    vscode.workspace.onDidSaveTextDocument(doc => {
      rebaseline(doc);
      // Clear highlights on save
      const ed = vscode.window.visibleTextEditors.find(e => e.document === doc);
      if (ed) clearDecorations(ed);
    }),

    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (!editor) return;
      // Recompute for newly focused editor
      scheduleDiff(editor);
    }),

    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('inlineChangeHighlighter')) {
        ensureDecorationType();
        enabled = getConfig().enabled;
        const ed = vscode.window.activeTextEditor;
        if (ed) scheduleDiff(ed);
      }
    }),

    vscode.commands.registerCommand('inlineChangeHighlighter.toggle', () => {
      enabled = !enabled;
      if (!enabled) clearDecorations();
      else if (vscode.window.activeTextEditor) scheduleDiff(vscode.window.activeTextEditor);
      vscode.window.showInformationMessage(
        `Inline Change Highlighter ${enabled ? 'enabled' : 'disabled'}`
      );
    }),

    vscode.commands.registerCommand('inlineChangeHighlighter.rebaseline', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      rebaseline(ed.document);
      clearDecorations(ed);
      vscode.window.showInformationMessage('Rebaselined to current file content.');
    }),

    vscode.commands.registerCommand('inlineChangeHighlighter.support', async () => {
      const cfg = getConfig();
      const choice = await vscode.window.showInformationMessage(
        'Thanks for using Inline Change Highlighter! If it helps you, you can support it here:',
        'Donate (PayPal)', 'Donate (Cash App)', 'Close'
      );
      if (!choice) return;
      if (choice.startsWith('Donate')) {
        const url = choice.includes('PayPal') ? cfg.donationPaypalUrl : cfg.donationCashUrl;
        vscode.env.openExternal(vscode.Uri.parse(url));
      }
    })
  );

  // First-run lightweight prompt gate: don't block startup, only check rules.
  maybeShowDonationPrompt(context);
}

export function deactivate() {
  if (decorationType) decorationType.dispose();
  timers.forEach(t => clearTimeout(t));
  timers.clear();
  baselineByDoc.clear();
}
