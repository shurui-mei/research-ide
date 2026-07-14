import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useEffect, useRef, useState } from 'react';
import { IconButton, Spinner } from './Common';
import { Icon } from './Icon';

GlobalWorkerOptions.workerSrc = workerUrl;

export function PdfPreview({ binary, path, onReveal }: { binary: Uint8Array; path: string; onReveal?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const renderRef = useRef<RenderTask | null>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [scale, setScale] = useState(1.15);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const loadingTask = getDocument({ data: binary.slice() });
    loadingTask.promise.then((document) => {
      if (cancelled) { void document.cleanup(); return; }
      documentRef.current = document;
      setPages(document.numPages);
      setPage(1);
    }).catch((nextError) => {
      if (!cancelled) setError(nextError instanceof Error ? nextError.message : 'PDF 无法打开');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      renderRef.current?.cancel();
      void loadingTask.destroy();
      documentRef.current = null;
    };
  }, [binary]);

  useEffect(() => {
    const document = documentRef.current;
    const canvas = canvasRef.current;
    if (loading || !document || !canvas || !pages) return;
    let cancelled = false;
    void document.getPage(page).then((pdfPage) => {
      if (cancelled) return;
      renderRef.current?.cancel();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = pdfPage.getViewport({ scale });
      const context = canvas.getContext('2d');
      if (!context) return;
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const task = pdfPage.render({ canvas, canvasContext: context, viewport, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] });
      renderRef.current = task;
      return task.promise;
    }).catch((nextError) => {
      if (!cancelled && nextError?.name !== 'RenderingCancelledException') setError(nextError instanceof Error ? nextError.message : '页面渲染失败');
    });
    return () => { cancelled = true; renderRef.current?.cancel(); };
  }, [loading, page, pages, scale]);

  return (
    <div className="pdf-shell">
      <div className="pdf-toolbar">
        <div className="pdf-page-controls">
          <IconButton disabled={page <= 1} icon="previous" label="上一页" onClick={() => setPage((current) => Math.max(1, current - 1))} />
          <label><input aria-label="PDF 页码" max={pages || 1} min={1} onChange={(event) => setPage(Math.min(pages || 1, Math.max(1, Number(event.target.value))))} type="number" value={page} /><span>/ {pages || '—'}</span></label>
          <IconButton disabled={page >= pages} icon="next" label="下一页" onClick={() => setPage((current) => Math.min(pages, current + 1))} />
        </div>
        <div className="pdf-title"><Icon name="pdf" size={14} /><span>{path.split(/[\\/]/).at(-1)}</span></div>
        <div className="pdf-zoom-controls">
          <IconButton disabled={scale <= 0.55} icon="zoomOut" label="缩小" onClick={() => setScale((current) => Math.max(.5, current - .1))} />
          <button className="zoom-value" onClick={() => setScale(1.15)} type="button">{Math.round(scale * 100)}%</button>
          <IconButton disabled={scale >= 2.5} icon="zoomIn" label="放大" onClick={() => setScale((current) => Math.min(2.5, current + .1))} />
          {onReveal && <IconButton icon="external" label="在文件管理器中显示" onClick={onReveal} />}
        </div>
      </div>
      <div className="pdf-viewport">
        {loading && <div className="pdf-state"><Spinner /><span>正在载入 PDF…</span></div>}
        {error && <div className="pdf-state error"><Icon name="error" size={24} /><strong>PDF 预览失败</strong><span>{error}</span></div>}
        <canvas className={loading || error ? 'hidden' : ''} ref={canvasRef} />
      </div>
    </div>
  );
}
