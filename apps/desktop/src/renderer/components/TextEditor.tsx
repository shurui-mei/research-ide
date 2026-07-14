import Editor, { loader, type BeforeMount, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import type { editor } from 'monaco-editor';
import { useEffect, useRef } from 'react';

loader.config({ monaco });
(self as unknown as { MonacoEnvironment: { getWorker(_: string, label: string): Worker } }).MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

export function TextEditor({
  path,
  language,
  value,
  onChange,
  onCursorChange,
  onSave,
  reveal,
}: {
  path: string;
  language: string;
  value: string;
  onChange(value: string): void;
  onCursorChange(line: number, column: number): void;
  onSave(): void;
  reveal?: { line: number; column: number; nonce: string };
}) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const beforeMount: BeforeMount = (monaco) => {
    monaco.editor.defineTheme('research-night', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '65758B', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'C4A7FF' },
        { token: 'string', foreground: 'A7D7A2' },
        { token: 'number', foreground: 'E9B985' },
        { token: 'type.identifier', foreground: '82D2CE' },
        { token: 'tag', foreground: '7BB7FF' },
      ],
      colors: {
        'editor.background': '#0d1119',
        'editor.foreground': '#c8d0de',
        'editorLineNumber.foreground': '#465165',
        'editorLineNumber.activeForeground': '#9ca8ba',
        'editorCursor.foreground': '#7dd3c7',
        'editor.selectionBackground': '#284b5d99',
        'editor.inactiveSelectionBackground': '#22374a80',
        'editor.lineHighlightBackground': '#141b27',
        'editorIndentGuide.background1': '#202a39',
        'editorIndentGuide.activeBackground1': '#40506a',
        'editorWhitespace.foreground': '#2a3547',
        'editorGutter.background': '#0d1119',
        'editorWidget.background': '#151b26',
        'editorWidget.border': '#303b4f',
        'input.background': '#0c1017',
        'input.border': '#344257',
        'focusBorder': '#4d9d94',
        'scrollbarSlider.background': '#3e4b5c66',
        'scrollbarSlider.hoverBackground': '#56657988',
      },
    });
  };

  const onMount: OnMount = (instance, monaco) => {
    editorRef.current = instance;
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, onSave);
    instance.onDidChangeCursorPosition(({ position }) => onCursorChange(position.lineNumber, position.column));
    window.setTimeout(() => instance.focus(), 50);
  };

  useEffect(() => {
    if (!reveal || !editorRef.current) return;
    const position = { lineNumber: reveal.line, column: reveal.column };
    editorRef.current.setPosition(position);
    editorRef.current.revealPositionInCenter(position);
    editorRef.current.focus();
  }, [reveal]);

  return (
    <div className="monaco-shell">
      <Editor
        beforeMount={beforeMount}
        language={language}
        onChange={(next) => onChange(next ?? '')}
        onMount={onMount}
        options={{
          automaticLayout: true,
          bracketPairColorization: { enabled: true },
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
          fontLigatures: true,
          fontSize: 13.5,
          lineHeight: 22,
          minimap: { enabled: true, maxColumn: 88, renderCharacters: false, scale: 0.8 },
          padding: { top: 16, bottom: 20 },
          renderLineHighlight: 'all',
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          stickyScroll: { enabled: true },
          tabSize: 2,
          wordWrap: language === 'latex' || language === 'markdown' ? 'on' : 'off',
        }}
        path={path}
        saveViewState
        theme="research-night"
        value={value}
      />
    </div>
  );
}
