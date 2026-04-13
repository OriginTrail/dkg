import React, { useState, useRef, useCallback } from 'react';
import { importFile, type ImportFileResult } from '../../api.js';

interface ImportFilesModalProps {
  open: boolean;
  onClose: () => void;
  contextGraphId: string;
  contextGraphName?: string;
}

interface QueuedFile {
  file: File;
  id: string;
}

type UploadStatus = 'idle' | 'uploading' | 'done' | 'error';

interface UploadResult {
  fileName: string;
  status: 'success' | 'skipped' | 'error';
  triplesWritten?: number;
  error?: string;
}

const SUPPORTED_EXTENSIONS = '.md, .docx, .pdf, .txt, .csv, .json, .ttl, .rdf, .owl, .py, .ts, .js, .tsx, .jsx, .java, .go, .rs, .c, .cpp, .html, .xml, .yaml, .yml';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'txt'].includes(ext)) return '📝';
  if (['pdf'].includes(ext)) return '📕';
  if (['docx', 'doc'].includes(ext)) return '📄';
  if (['csv', 'json', 'xml', 'yaml', 'yml'].includes(ext)) return '📊';
  if (['ttl', 'rdf', 'owl'].includes(ext)) return '🔗';
  if (['py', 'ts', 'js', 'tsx', 'jsx', 'java', 'go', 'rs', 'c', 'cpp'].includes(ext)) return '💻';
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return '🖼️';
  return '📄';
}

export function ImportFilesModal({ open, onClose, contextGraphId, contextGraphName }: ImportFilesModalProps) {
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [extractKnowledge, setExtractKnowledge] = useState(true);
  const [storeOriginals, setStoreOriginals] = useState(true);
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [currentFile, setCurrentFile] = useState(0);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((newFiles: FileList | File[]) => {
    const arr = Array.from(newFiles);
    setFiles(prev => {
      const existing = new Set(prev.map(f => `${f.file.name}:${f.file.size}`));
      const unique = arr.filter(f => !existing.has(`${f.name}:${f.size}`));
      return [...prev, ...unique.map(f => ({ file: f, id: `${f.name}-${f.size}-${Date.now()}` }))];
    });
  }, []);

  const removeFile = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  const handleImport = async () => {
    if (files.length === 0) return;

    setStatus('uploading');
    setCurrentFile(0);
    setResults([]);
    setError(null);

    const uploadResults: UploadResult[] = [];

    for (let i = 0; i < files.length; i++) {
      setCurrentFile(i);
      const { file } = files[i];
      const sanitized = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const assertionName = `${Date.now().toString(36)}-${i}-${sanitized}`;

      try {
        const result: ImportFileResult = await importFile(assertionName, contextGraphId, file);
        const triples = result.extraction.tripleCount ?? result.extraction.triplesWritten;
        uploadResults.push({
          fileName: file.name,
          status: result.extraction.status === 'completed' ? 'success' :
                  result.extraction.status === 'skipped' ? 'skipped' : 'error',
          triplesWritten: triples,
          error: result.extraction.error,
        });
      } catch (err: any) {
        uploadResults.push({
          fileName: file.name,
          status: 'error',
          error: err?.message ?? 'Upload failed',
        });
      }
    }

    setResults(uploadResults);
    setCurrentFile(files.length);

    const hasErrors = uploadResults.some(r => r.status === 'error');
    setStatus(hasErrors ? 'error' : 'done');
  };

  const handleClose = () => {
    if (status === 'uploading') return;
    setFiles([]);
    setResults([]);
    setStatus('idle');
    setError(null);
    setCurrentFile(0);
    onClose();
  };

  if (!open) return null;

  const totalTriples = results.reduce((sum, r) => sum + (r.triplesWritten ?? 0), 0);
  const successCount = results.filter(r => r.status === 'success').length;
  const errorCount = results.filter(r => r.status === 'error').length;

  return (
    <div className="v10-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && status !== 'uploading') handleClose(); }}>
      <div className="v10-modal-box" style={{ maxWidth: 560 }}>
        <div className="v10-modal-header">
          <div className="v10-modal-title">Import to Working Memory</div>
          <div className="v10-modal-subtitle">
            {contextGraphName
              ? <>Upload files to <strong>{contextGraphName}</strong> — your agent will extract structured knowledge.</>
              : <>Upload files — your agent will extract structured knowledge and add it to working memory.</>
            }
          </div>
        </div>

        <div className="v10-modal-body">
          {error && <div className="v10-modal-error">{error}</div>}

          {status === 'idle' && (
            <>
              <div
                className={`v10-import-dropzone ${dragOver ? 'drag-over' : ''}`}
                onClick={() => inputRef.current?.click()}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <div className="v10-import-dropzone-label">
                  Drag files here, or click to browse
                </div>
                <div className="v10-import-dropzone-hint" style={{ marginTop: 4 }}>
                  Your agent will extract structured knowledge and add it to working memory.
                </div>
                <div className="v10-import-dropzone-hint" style={{ marginTop: 8 }}>
                  Supported: {SUPPORTED_EXTENSIONS}
                </div>
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
                />
              </div>

              {files.length > 0 && (
                <>
                  <div className="v10-import-file-list">
                    {files.map((f) => (
                      <div key={f.id} className="v10-import-file-item">
                        <span className="v10-import-file-icon">{fileIcon(f.file.name)}</span>
                        <span className="v10-import-file-name">{f.file.name}</span>
                        <span className="v10-import-file-size">{formatSize(f.file.size)}</span>
                        <button className="v10-import-file-remove" onClick={() => removeFile(f.id)} title="Remove">×</button>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 12 }}>
                    {files.length} file{files.length !== 1 ? 's' : ''} selected · {formatSize(files.reduce((s, f) => s + f.file.size, 0))} total
                  </div>
                </>
              )}

              <div className="v10-form-divider" />
              <div className="v10-form-label" style={{ marginBottom: 8 }}>Ingestion Options <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-tertiary)' }}>(coming soon)</span></div>
              <label className="v10-import-option" style={{ opacity: 0.5, pointerEvents: 'none' }}>
                <input type="checkbox" checked={storeOriginals} disabled readOnly />
                Store original files as Knowledge Assets
              </label>
              <label className="v10-import-option" style={{ opacity: 0.5, pointerEvents: 'none' }}>
                <input type="checkbox" checked={extractKnowledge} disabled readOnly />
                Let agent extract structured knowledge from content
              </label>
            </>
          )}

          {status === 'uploading' && (
            <div className="v10-import-progress">
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500 }}>
                Importing files… ({currentFile + 1} of {files.length})
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                {files[currentFile]?.file.name ?? '…'}
              </div>
              <div className="v10-import-progress-bar">
                <div
                  className="v10-import-progress-fill"
                  style={{ width: `${((currentFile + 0.5) / files.length) * 100}%` }}
                />
              </div>
              <div className="v10-import-progress-text">
                {currentFile} of {files.length} files processed
              </div>
            </div>
          )}

          {(status === 'done' || status === 'error') && (
            <>
              <div className={`v10-import-result ${errorCount > 0 ? 'error' : 'success'}`}>
                {errorCount === 0 ? (
                  <>
                    Successfully imported {successCount} file{successCount !== 1 ? 's' : ''}.
                    {totalTriples > 0 && <> Extracted <strong>{totalTriples.toLocaleString()}</strong> triples into working memory.</>}
                  </>
                ) : (
                  <>
                    {successCount} file{successCount !== 1 ? 's' : ''} imported, {errorCount} failed.
                    {totalTriples > 0 && <> {totalTriples.toLocaleString()} triples extracted.</>}
                  </>
                )}
              </div>

              {results.length > 0 && (
                <div className="v10-import-file-list" style={{ marginTop: 12 }}>
                  {results.map((r, i) => (
                    <div key={i} className="v10-import-file-item">
                      <span className="v10-import-file-icon">
                        {r.status === 'success' ? '✓' : r.status === 'skipped' ? '–' : '✗'}
                      </span>
                      <span className="v10-import-file-name">{r.fileName}</span>
                      <span className="v10-import-file-size" style={r.status === 'error' ? { color: 'var(--accent-red)' } : undefined}>
                        {r.status === 'success' && r.triplesWritten != null ? `${r.triplesWritten} triples` :
                         r.status === 'skipped' ? 'stored (no extraction)' :
                         r.error ?? 'failed'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="v10-modal-footer">
          {status === 'idle' && (
            <>
              <button className="v10-modal-btn" onClick={handleClose}>Cancel</button>
              <button
                className="v10-modal-btn primary"
                onClick={handleImport}
                disabled={files.length === 0}
              >
                Start Import ({files.length} file{files.length !== 1 ? 's' : ''})
              </button>
            </>
          )}
          {status === 'uploading' && (
            <button className="v10-modal-btn" disabled>Importing…</button>
          )}
          {(status === 'done' || status === 'error') && (
            <button className="v10-modal-btn primary" onClick={handleClose}>Done</button>
          )}
        </div>
      </div>
    </div>
  );
}
