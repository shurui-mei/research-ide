import type { EditorKind, FileNode } from '../types';

const languageByExtension: Record<string, string> = {
  tex: 'latex',
  sty: 'latex',
  cls: 'latex',
  bib: 'bibtex',
  py: 'python',
  r: 'r',
  rmd: 'markdown',
  qmd: 'markdown',
  md: 'markdown',
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  toml: 'ini',
  yaml: 'yaml',
  yml: 'yaml',
  csv: 'plaintext',
  txt: 'plaintext',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  rs: 'rust',
  java: 'java',
  sh: 'shell',
  html: 'html',
  css: 'css',
  sql: 'sql',
};

export function extensionOf(path: string) {
  const name = basename(path);
  const index = name.lastIndexOf('.');
  return index > -1 ? name.slice(index + 1).toLowerCase() : '';
}

export function basename(path: string) {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? path;
}

export function dirname(path: string) {
  const normal = path.replace(/\\/g, '/');
  const index = normal.lastIndexOf('/');
  if (index < 0) return '';
  if (index === 0) return '/';
  return normal.slice(0, index);
}

export function joinPath(parent: string, child: string) {
  if (!parent) return child.replace(/^[\\/]+/, '');
  const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return `${parent.replace(/[\\/]$/, '')}${separator}${child}`;
}

export function kindForPath(path: string): EditorKind {
  const extension = extensionOf(path);
  if (extension === 'pdf') return 'pdf';
  if (extension === 'doc' || extension === 'docx') return 'docx';
  if (extension === 'researchdoc') return 'document';
  return 'text';
}

export function languageForPath(path: string) {
  return languageByExtension[extensionOf(path)] ?? 'plaintext';
}

export function flattenFiles(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((node) =>
    node.type === 'directory'
      ? flattenFiles(node.children ?? [])
      : [node],
  );
}

export function relativePath(path: string, root: string) {
  const normalizedPath = path.replace(/\\/g, '/');
  if (!normalizedPath.startsWith('/') && !/^[A-Za-z]:\//.test(normalizedPath)) return normalizedPath;
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : basename(path);
}

export function fileIconName(path: string): 'tex' | 'pdf' | 'doc' | 'code' | 'file' {
  const extension = extensionOf(path);
  if (['tex', 'sty', 'cls', 'bib'].includes(extension)) return 'tex';
  if (extension === 'pdf') return 'pdf';
  if (extension === 'doc' || extension === 'docx' || extension === 'researchdoc') return 'doc';
  if (Object.hasOwn(languageByExtension, extension) && !['txt', 'csv'].includes(extension)) return 'code';
  return 'file';
}
