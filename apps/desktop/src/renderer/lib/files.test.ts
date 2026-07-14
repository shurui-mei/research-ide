import { describe, expect, it } from 'vitest';
import { basename, dirname, extensionOf, joinPath, kindForPath, relativePath } from './files';

describe('renderer file helpers', () => {
  it('handles project-root files without introducing an absolute path', () => {
    expect(dirname('main.tex')).toBe('');
    expect(joinPath('', 'main.tex')).toBe('main.tex');
  });

  it('keeps nested relative paths intact', () => {
    expect(relativePath('manuscript/sections/introduction.tex', '/tmp/paper')).toBe('manuscript/sections/introduction.tex');
    expect(relativePath('/tmp/paper/manuscript/main.tex', '/tmp/paper')).toBe('manuscript/main.tex');
  });

  it('classifies common research files', () => {
    expect(basename('manuscript/main.tex')).toBe('main.tex');
    expect(extensionOf('manuscript/main.TEX')).toBe('tex');
    expect(kindForPath('paper.pdf')).toBe('pdf');
    expect(kindForPath('legacy-paper.DOC')).toBe('docx');
    expect(kindForPath('paper.docx')).toBe('docx');
    expect(kindForPath('paper.researchdoc')).toBe('document');
    expect(kindForPath('supplement.html')).toBe('text');
    expect(kindForPath('analysis/model.py')).toBe('text');
  });
});
