// Slim Monaco setup: the editor core plus only the features we use. We
// deliberately do NOT load Monaco's JSON language service: it would try to
// parse / validate the whole document on the main thread, which is hopeless
// for 20MB inputs. Highlighting uses a tiny tokenizer; validation is done by
// our own worker.
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu';
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/editor/contrib/folding/browser/folding';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor';
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations';
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

export const JSON_LANG = 'json-fast';

monaco.languages.register({ id: JSON_LANG });
monaco.languages.setMonarchTokensProvider(JSON_LANG, {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key.json'],
      [/"(?:[^"\\]|\\.)*"/, 'string.value.json'],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/\b(?:true|false)\b/, 'keyword'],
      [/\bnull\b/, 'keyword.null'],
      [/[{}[\]]/, 'delimiter.bracket'],
      [/[,:]/, 'delimiter'],
    ],
  },
});
monaco.languages.setLanguageConfiguration(JSON_LANG, {
  brackets: [
    ['{', '}'],
    ['[', ']'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}', notIn: ['string'] },
    { open: '[', close: ']', notIn: ['string'] },
    { open: '"', close: '"', notIn: ['string'] },
  ],
});

export { monaco };
