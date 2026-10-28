import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Upload,
  Pause,
  Play,
  CheckCircle2,
  AlertCircle,
  Terminal,
  Server,
  ShieldCheck,
  HardDrive,
  FileCode,
  Copy,
  Check,
  RefreshCw,
  FolderOpen,
  Trash2,
  Sliders,
  Lock,
  Activity,
  Cpu,
  Search,
  Download,
  FileText,
  Layers,
  Command,
  ChevronRight,
  X,
} from 'lucide-react';
import {
  ResumableSha512Uploader,
  TransferProgress,
  PersistedSession,
  getPersistedSessions,
  removePersistedSession,
  clearAllPersistedSessions,
  computeFastFileFingerprint,
} from './engine/ResumableSha512Engine';
import {
  ParallelRangeSha512Downloader,
  DownloadProgress,
} from './engine/ParallelRangeDownloader';
import { LINUX_SERVER_GUIDES } from './data/linuxServerGuides';

interface LogEntry {
  id: string;
  time: string;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

interface RemoteServerFile {
  name: string;
  path: string;
  size: number;
  modified: string;
  isDir: boolean;
  sha512?: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i >= 2 ? 2 : 0)} ${sizes[i]}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function App() {
  // Navigation & Inspector Tabs
  const [activeNav, setActiveNav] = useState<
    'transfers' | 'remote-files' | 'linux-setup' | 'settings'
  >('transfers');
  const [inspectorTab, setInspectorTab] = useState<
    'crypto' | 'chunk-map' | 'logs' | 'audit' | 'connection'
  >('crypto');

  // Server Connection State
  const [serverUrl, setServerUrl] = useState<string>('http://127.0.0.1:8080');
  const [username, setUsername] = useState<string>('admin');
  const [password, setPassword] = useState<string>('ChangeMe_StrongPass2026!');
  const [jwtToken, setJwtToken] = useState<string>('');
  const [targetFolder, setTargetFolder] = useState<string>('/transfers');
  const [chunkSizeMb, setChunkSizeMb] = useState<number>(10);
  const [downloadConcurrency, setDownloadConcurrency] = useState<number>(6);
  const [verifyFullFileAtEnd, setVerifyFullFileAtEnd] = useState<boolean>(true);
  const [simulationMode, setSimulationMode] = useState<boolean>(true);

  // Upload & Download State
  const [transfers, setTransfers] = useState<Record<string, TransferProgress>>({});
  const [selectedFingerprint, setSelectedFingerprint] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<Record<string, DownloadProgress>>({});
  const [selectedDownloadId, setSelectedDownloadId] = useState<string | null>(null);

  const [persistedSessions, setPersistedSessions] = useState<Record<string, PersistedSession>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [auditLines, setAuditLines] = useState<string[]>([
    '2026-10-28T21:40:00+03:00 | SYSTEM | FileBrowser Audit Hook (.audit.log) hazır — GET /api/raw/.audit.log',
  ]);
  const [remoteFiles, setRemoteFiles] = useState<RemoteServerFile[]>([
    {
      name: 'ubuntu-24.04.1-live-server-amd64.iso',
      path: '/transfers/ubuntu-24.04.1-live-server-amd64.iso',
      size: 180 * 1024 * 1024, // 180 MB (18 chunks of 10 MB)
      modified: '2026-10-28 21:15:00',
      isDir: false,
      sha512:
        '8a4c9e52d0a1f71e63b4b9c85e2a10d97b3f4c81e2d5a609b7c8e1f2a3d4b5c60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0123456789abc',
    },
    {
      name: 'postgres_prod_cluster_dump.tar.zst',
      path: '/transfers/postgres_prod_cluster_dump.tar.zst',
      size: 140 * 1024 * 1024, // 140 MB (14 chunks of 10 MB)
      modified: '2026-10-28 21:30:00',
      isDir: false,
      sha512:
        '4f2b1c90e8d7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9',
    },
    {
      name: '.audit.log',
      path: '/transfers/.audit.log',
      size: 1420,
      modified: '2026-10-28 21:40:00',
      isDir: false,
      sha512:
        'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e',
    },
  ]);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [isDraggingOver, setIsDraggingOver] = useState<boolean>(false);
  const [isCmdPaletteOpen, setIsCmdPaletteOpen] = useState<boolean>(false);
  const [cmdQuery, setCmdQuery] = useState<string>('');
  const [searchFilter, setSearchFilter] = useState<string>('');

  const uploadersRef = useRef<Record<string, ResumableSha512Uploader>>({});
  const downloadersRef = useRef<Record<string, ParallelRangeSha512Downloader>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const addLog = useCallback((level: LogEntry['level'], message: string) => {
    const now = new Date();
    const time =
      now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
    setLogs((prev) => [
      { id: `${Date.now()}-${Math.random()}`, time, level, message },
      ...prev.slice(0, 199),
    ]);
  }, []);

  const refreshPersistedSessions = useCallback(async () => {
    const stored = await getPersistedSessions();
    setPersistedSessions(stored);
  }, []);

  // Fetch /srv/transfers/.audit.log directly from FileBrowser via GET /api/raw/.audit.log
  const fetchServerAuditLog = useCallback(async () => {
    if (simulationMode) {
      addLog('info', 'Simülasyon modunda yerel .audit.log kayıtları görüntüleniyor.');
      return;
    }
    try {
      const base = serverUrl.replace(/\/+$/, '');
      const res = await fetch(`${base}/api/raw/.audit.log`, {
        headers: { 'X-Auth': jwtToken },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const text = await res.text();
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .reverse();
      setAuditLines(lines);
      addLog('success', `Sunucu .audit.log dosyası okundu (${lines.length} kayıt).`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog('warn', `Sunucu .audit.log okunamadı: ${msg}`);
    }
  }, [simulationMode, serverUrl, jwtToken, addLog]);

  // Fetch remote directory listing from FileBrowser /api/resources/{targetFolder}
  const fetchRemoteFiles = useCallback(async () => {
    if (simulationMode) return;
    try {
      const base = serverUrl.replace(/\/+$/, '');
      const cleanFolder = targetFolder.replace(/\/+$/, '') || '/';
      const res = await fetch(`${base}/api/resources${cleanFolder}`, {
        headers: { 'X-Auth': jwtToken },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data.items)) {
        setRemoteFiles(
          data.items.map(
            (item: {
              name: string;
              path: string;
              size: number;
              modified: string;
              isDir: boolean;
            }) => ({
              name: item.name,
              path: item.path,
              size: item.size,
              modified: item.modified,
              isDir: item.isDir,
            })
          )
        );
      }
    } catch (err) {
      addLog('warn', `Sunucu dosya listesi alınamadı: ${String(err)}`);
    }
  }, [simulationMode, serverUrl, targetFolder, jwtToken, addLog]);

  useEffect(() => {
    refreshPersistedSessions();
    addLog(
      'info',
      'Pipelined TUS (Upload) + Çok Kanallı HTTP 206 Range (Download) + SHA-512 motoru hazır.'
    );
  }, [refreshPersistedSessions, addLog]);

  // Authenticate against FileBrowser /api/login
  const handleLoginToken = async () => {
    setAuthStatus('loading');
    try {
      const base = serverUrl.replace(/\/+$/, '');
      const res = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const token = await res.text();
      setJwtToken(token.trim());
      setSimulationMode(false);
      setAuthStatus('ok');
      addLog('success', `FileBrowser JWT oturum anahtarı alındı (${base}). Canlı sunucu modu aktif.`);
    } catch (err) {
      setAuthStatus('error');
      const msg = err instanceof Error ? err.message : String(err);
      addLog('error', `FileBrowser giriş hatası: ${msg}`);
    }
  };

  // Start or resume a File upload
  const startFileTransfer = useCallback(
    async (file: File, handle?: FileSystemFileHandle, customTargetPath?: string) => {
      const fp = await computeFastFileFingerprint(file);
      const saved = (await getPersistedSessions())[fp];
      const cleanFolder = targetFolder.replace(/\/+$/, '') || '';
      const resolvedPath = customTargetPath || saved?.targetPath || `${cleanFolder}/${file.name}`;

      setSelectedFingerprint(fp);
      setActiveNav('transfers');

      const uploader = new ResumableSha512Uploader(
        file,
        resolvedPath,
        {
          serverUrl,
          jwtToken,
          chunkSizeMb,
          verifyFullFileAtEnd,
          simulationMode,
          onProgress: (progressState) => {
            const key = progressState.fingerprint || fp;
            setTransfers((prev) => ({
              ...prev,
              [key]: { ...progressState, fingerprint: key },
            }));
            setSelectedFingerprint((curr) => curr || key);

            if (
              progressState.status === 'paused' ||
              progressState.status === 'completed'
            ) {
              refreshPersistedSessions();
            }

            if (progressState.status === 'completed') {
              const isoNow = new Date().toISOString();
              setAuditLines((prev) => [
                `${isoNow} | UPLOAD | User: ${username} | File: ${resolvedPath} | SHA512: ${progressState.clientSha512?.slice(0, 16)}...`,
                ...prev,
              ]);
              setRemoteFiles((prev) => {
                const filtered = prev.filter((f) => f.path !== resolvedPath);
                return [
                  {
                    name: file.name,
                    path: resolvedPath,
                    size: file.size,
                    modified: isoNow.replace('T', ' ').slice(0, 19),
                    isDir: false,
                    sha512: progressState.clientSha512,
                  },
                  ...filtered,
                ];
              });
            }
          },
          onLog: addLog,
        },
        handle
      );

      uploadersRef.current[fp] = uploader;
      await uploader.startOrResume();
      await refreshPersistedSessions();
    },
    [
      targetFolder,
      serverUrl,
      jwtToken,
      username,
      chunkSizeMb,
      verifyFullFileAtEnd,
      simulationMode,
      addLog,
      refreshPersistedSessions,
    ]
  );

  // Start a Multi-Stream Parallel HTTP 206 Range Download with SHA-512 verification
  const startParallelRangeDownload = useCallback(
    async (file: RemoteServerFile, useSavePicker = false) => {
      let saveHandle: FileSystemFileHandle | undefined;

      if (useSavePicker && 'showSaveFilePicker' in window) {
        try {
          saveHandle = await (
            window as unknown as {
              showSaveFilePicker: (opts: { suggestedName: string }) => Promise<FileSystemFileHandle>;
            }
          ).showSaveFilePicker({ suggestedName: file.name });
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
        }
      }

      const dlId = `dl_${file.path}_${file.size}`;
      setSelectedDownloadId(dlId);

      const existing = downloadersRef.current[dlId];
      if (existing) {
        await existing.startOrResume();
        return;
      }

      const downloader = new ParallelRangeSha512Downloader(
        file.name,
        file.path,
        file.size,
        {
          serverUrl,
          jwtToken,
          chunkSizeMb,
          concurrency: downloadConcurrency,
          simulationMode,
          expectedServerSha512: file.sha512,
          onProgress: (dlState) => {
            setDownloads((prev) => ({
              ...prev,
              [dlState.id]: dlState,
            }));
            setSelectedDownloadId((curr) => curr || dlState.id);
          },
          onLog: addLog,
        },
        saveHandle
      );

      downloadersRef.current[dlId] = downloader;
      await downloader.startOrResume();
    },
    [serverUrl, jwtToken, chunkSizeMb, downloadConcurrency, simulationMode, addLog]
  );

  const handlePauseDownload = useCallback((dlId: string) => {
    downloadersRef.current[dlId]?.pause();
  }, []);

  const handleResumeDownload = useCallback(async (dlId: string) => {
    await downloadersRef.current[dlId]?.startOrResume();
  }, []);

  const handleRemoveDownload = useCallback((dlId: string) => {
    downloadersRef.current[dlId]?.pause();
    delete downloadersRef.current[dlId];
    setDownloads((prev) => {
      const next = { ...prev };
      delete next[dlId];
      return next;
    });
    setSelectedDownloadId((curr) => (curr === dlId ? null : curr));
  }, []);

  // Pick file with File System Access API
  const handleModernFilePicker = useCallback(async () => {
    if ('showOpenFilePicker' in window) {
      try {
        const handles = await (
          window as unknown as {
            showOpenFilePicker: (opts: { multiple: boolean }) => Promise<FileSystemFileHandle[]>;
          }
        ).showOpenFilePicker({ multiple: true });

        for (const handle of handles) {
          const file = await handle.getFile();
          startFileTransfer(file, handle);
        }
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
      }
    }
    fileInputRef.current?.click();
  }, [startFileTransfer]);

  const handleFallbackInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((file) => startFileTransfer(file));
    e.target.value = '';
  };

  // Generate an in-memory deterministic binary file for instant testing
  const handleGenerateTestFile = useCallback(
    async (sizeMb = 120) => {
      const sizeBytes = sizeMb * 1024 * 1024;
      const buffer = new Uint8Array(sizeBytes);
      for (let i = 0; i < 4096; i++) {
        buffer[i] = (i + sizeMb) % 251;
        buffer[Math.floor(sizeBytes / 2) + i] = (i * 7 + sizeMb) % 251;
        buffer[sizeBytes - 1 - i] = (i * 13 + sizeMb) % 251;
      }
      const blob = new Blob([buffer], { type: 'application/octet-stream' });
      const testFile = new File([blob], `linux_image_${sizeMb}MB_backup.tar.zst`, {
        type: 'application/octet-stream',
        lastModified: 1793209400000 + sizeMb,
      });
      addLog(
        'info',
        `${sizeMb} MB deterministik test dosyası oluşturuldu (${Math.ceil(sizeMb / chunkSizeMb)} × ${chunkSizeMb} MB parça).`
      );
      await startFileTransfer(testFile);
    },
    [chunkSizeMb, addLog, startFileTransfer]
  );

  // Resume directly from IndexedDB persisted FileSystemFileHandle
  const handleResumePersistedSession = async (session: PersistedSession) => {
    if (session.fileHandle) {
      try {
        const opts = { mode: 'read' as const };
        const handleWithPerm = session.fileHandle as unknown as {
          queryPermission: (o: typeof opts) => Promise<PermissionState>;
          requestPermission: (o: typeof opts) => Promise<PermissionState>;
          getFile: () => Promise<File>;
        };
        let perm = await handleWithPerm.queryPermission(opts);
        if (perm !== 'granted') {
          perm = await handleWithPerm.requestPermission(opts);
        }
        if (perm === 'granted') {
          const file = await handleWithPerm.getFile();
          await startFileTransfer(file, session.fileHandle, session.targetPath);
          return;
        }
      } catch (err) {
        addLog('warn', `Dosya referansı izni alınamadı, lütfen dosyayı tekrar seçin: ${String(err)}`);
      }
    }
    addLog(
      'info',
      `"${session.fileName}" dosyasını seçin (Adı değişmiş olsa bile 3ms SHA-512 parmak iziyle %${((session.offset / session.fileSize) * 100).toFixed(1)} konumundan devam edecektir).`
    );
    handleModernFilePicker();
  };

  const handlePause = useCallback((fp: string) => {
    uploadersRef.current[fp]?.pause();
  }, []);

  const handleResumeActive = useCallback(
    async (fp: string) => {
      const uploader = uploadersRef.current[fp];
      if (uploader) {
        await uploader.startOrResume();
      } else {
        const saved = persistedSessions[fp];
        if (saved) {
          await handleResumePersistedSession(saved);
        }
      }
    },
    [persistedSessions]
  );

  const handleRemoveTransfer = async (fp: string) => {
    uploadersRef.current[fp]?.pause();
    delete uploadersRef.current[fp];
    await removePersistedSession(fp);
    setTransfers((prev) => {
      const next = { ...prev };
      delete next[fp];
      return next;
    });
    if (selectedFingerprint === fp) {
      setSelectedFingerprint(null);
    }
    await refreshPersistedSessions();
  };

  // Remote File Delete & SHA-512 Checksum Request
  const handleDeleteRemoteFile = async (file: RemoteServerFile) => {
    if (!simulationMode) {
      try {
        const base = serverUrl.replace(/\/+$/, '');
        const res = await fetch(`${base}/api/resources${file.path}`, {
          method: 'DELETE',
          headers: { 'X-Auth': jwtToken },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        addLog('error', `Sunucudan silinemedi: ${String(err)}`);
        return;
      }
    }
    const isoNow = new Date().toISOString();
    setRemoteFiles((prev) => prev.filter((f) => f.path !== file.path));
    setAuditLines((prev) => [
      `${isoNow} | DELETE | User: ${username} | File: ${file.path}`,
      ...prev,
    ]);
    addLog('warn', `Sunucudan dosya silindi ve .audit.log güncellendi: ${file.path}`);
  };

  const handleVerifyRemoteFileSha512 = async (file: RemoteServerFile) => {
    if (simulationMode) {
      addLog(
        'success',
        `GET /api/resources${file.path}?checksum=sha512 -> Doğrulandı (${file.sha512?.slice(0, 24) || 'cf83e135...'})`
      );
      return;
    }
    try {
      const base = serverUrl.replace(/\/+$/, '');
      const res = await fetch(`${base}/api/resources${file.path}?checksum=sha512`, {
        headers: { 'X-Auth': jwtToken },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const sha512 = data?.checksums?.sha512;
      setRemoteFiles((prev) =>
        prev.map((f) => (f.path === file.path ? { ...f, sha512 } : f))
      );
      addLog('success', `Sunucu SHA-512 özeti alındı (${file.name}): ${sha512?.slice(0, 24)}...`);
    } catch (err) {
      addLog('error', `SHA-512 sorgulanamadı: ${String(err)}`);
    }
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const transferList = Object.values(transfers).filter((t) =>
    searchFilter
      ? t.fileName.toLowerCase().includes(searchFilter.toLowerCase()) ||
        t.fingerprint.includes(searchFilter.toLowerCase())
      : true
  );
  const selectedTransfer =
    (selectedFingerprint && transfers[selectedFingerprint]) || transferList[0] || null;

  const downloadList = Object.values(downloads);
  const selectedDownload =
    (selectedDownloadId && downloads[selectedDownloadId]) || downloadList[0] || null;

  const persistedList = Object.values(persistedSessions);

  // Total live aggregate speed (Uploads + Parallel Range Downloads)
  const totalUploadSpeed = Object.values(transfers).reduce(
    (acc, t) => acc + (t.status === 'uploading' ? t.speedBytesPerSec : 0),
    0
  );
  const totalDownloadSpeed = Object.values(downloads).reduce(
    (acc, d) => acc + (d.status === 'downloading' ? d.speedBytesPerSec : 0),
    0
  );
  const totalSpeedBytesPerSec = totalUploadSpeed + totalDownloadSpeed;

  const activeUploadsCount = Object.values(transfers).filter(
    (t) => t.status === 'uploading'
  ).length;
  const activeDownloadsCount = Object.values(downloads).filter(
    (d) => d.status === 'downloading'
  ).length;

  // Global Keyboard Shortcuts (Ctrl+K Command Palette, Space to Pause/Resume)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsCmdPaletteOpen((v) => !v);
        setCmdQuery('');
        return;
      }
      if (e.key === 'Escape' && isCmdPaletteOpen) {
        setIsCmdPaletteOpen(false);
        return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.code === 'Space') {
        if (activeNav === 'transfers' && selectedTransfer) {
          e.preventDefault();
          if (selectedTransfer.status === 'uploading') {
            handlePause(selectedTransfer.fingerprint);
          } else if (selectedTransfer.status === 'paused') {
            handleResumeActive(selectedTransfer.fingerprint);
          }
        } else if (activeNav === 'remote-files' && selectedDownload) {
          e.preventDefault();
          if (selectedDownload.status === 'downloading') {
            handlePauseDownload(selectedDownload.id);
          } else if (selectedDownload.status === 'paused') {
            handleResumeDownload(selectedDownload.id);
          }
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    isCmdPaletteOpen,
    activeNav,
    selectedTransfer,
    selectedDownload,
    handlePause,
    handleResumeActive,
    handlePauseDownload,
    handleResumeDownload,
  ]);

  const commandActions = [
    {
      id: 'pick-file',
      label: 'Bilgisayardan Dosya Seç ve Yükle (TUS + SHA-512)',
      shortcut: 'Ctrl+U',
      run: () => handleModernFilePicker(),
    },
    {
      id: 'test-120mb',
      label: '120 MB Deterministik Test Yüklemesi Başlat (12 × 10 MB Parça)',
      shortcut: 'Upload 120M',
      run: () => handleGenerateTestFile(120),
    },
    {
      id: 'test-parallel-dl',
      label: `180 MB Ubuntu ISO Paralel Range İndirmesi Başlat (${downloadConcurrency}x Kanal + SHA-512)`,
      shortcut: `Range ${downloadConcurrency}x`,
      run: () => {
        setActiveNav('remote-files');
        if (remoteFiles[0]) {
          startParallelRangeDownload(remoteFiles[0], false);
        }
      },
    },
    {
      id: 'view-chunk-map',
      label: 'Canlı Parça (Chunk) Bütünlük Haritasını Aç',
      shortcut: 'Matrix',
      run: () => {
        setActiveNav('transfers');
        setInspectorTab('chunk-map');
      },
    },
    {
      id: 'view-audit',
      label: 'Linux Sunucu Denetim Günlüğünü (.audit.log) Görüntüle',
      shortcut: 'Audit',
      run: () => {
        setActiveNav('transfers');
        setInspectorTab('audit');
        fetchServerAuditLog();
      },
    },
    {
      id: 'view-remote',
      label: 'Linux Sunucu Dosya Gezginini ve Paralel İndiriciyi Aç',
      shortcut: 'Explorer',
      run: () => {
        setActiveNav('remote-files');
        fetchRemoteFiles();
      },
    },
    {
      id: 'view-linux-setup',
      label: 'Linux Sunucu Kurulum Scriptlerini (BBR + Caddy + Nginx) Göster',
      shortcut: 'Setup',
      run: () => setActiveNav('linux-setup'),
    },
  ].filter((item) =>
    cmdQuery ? item.label.toLowerCase().includes(cmdQuery.toLowerCase()) : true
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setIsDraggingOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDraggingOver(false);
        if (e.dataTransfer.files?.length) {
          Array.from(e.dataTransfer.files).forEach((f) => startFileTransfer(f));
        }
      }}
      className="flex flex-col h-screen w-screen overflow-hidden bg-[#0A0B0E] text-[#ECEEF2] select-none relative"
    >
      {/* Full-Window Drag-and-Drop Overlay */}
      {isDraggingOver && (
        <div className="absolute inset-0 z-50 bg-[#0A0B0E]/90 backdrop-blur-xs border-2 border-dashed border-[#3B82F6] flex flex-col items-center justify-center pointer-events-none">
          <div className="w-12 h-12 rounded bg-[#192338] border border-[#3B82F6] flex items-center justify-center mb-3">
            <Upload className="w-6 h-6 text-[#3B82F6]" strokeWidth={1.75} />
          </div>
          <div className="text-[14px] font-semibold text-[#ECEEF2]">
            Dosyaları TUS + SHA-512 Kuyruğuna Bırakın
          </div>
          <div className="text-[12px] text-[#9499A6] mt-1 font-mono">
            Hedef: {targetFolder} • {chunkSizeMb} MB Pipelined Parçalar
          </div>
        </div>
      )}

      {/* Command Palette Overlay (Ctrl+K) */}
      {isCmdPaletteOpen && (
        <div
          onClick={() => setIsCmdPaletteOpen(false)}
          className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-[12vh]"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[560px] rounded bg-[#0F1117] border border-[#2A2F40] shadow-2xl overflow-hidden"
          >
            <div className="h-[40px] px-3 border-b border-[#1E2230] flex items-center gap-2.5">
              <Search className="w-4 h-4 text-[#636875]" strokeWidth={1.5} />
              <input
                type="text"
                autoFocus
                value={cmdQuery}
                onChange={(e) => setCmdQuery(e.target.value)}
                placeholder="Komut veya işlem ara..."
                className="flex-1 bg-transparent text-[13px] text-[#ECEEF2] placeholder-[#636875] focus:outline-none"
              />
              <button
                onClick={() => setIsCmdPaletteOpen(false)}
                className="text-[#636875] hover:text-[#ECEEF2] cursor-pointer"
              >
                <X className="w-4 h-4" strokeWidth={1.5} />
              </button>
            </div>
            <div className="p-1.5 max-h-[300px] overflow-y-auto space-y-0.5">
              {commandActions.map((act) => (
                <button
                  key={act.id}
                  onClick={() => {
                    setIsCmdPaletteOpen(false);
                    act.run();
                  }}
                  className="w-full h-[34px] px-3 rounded text-left text-[12px] text-[#ECEEF2] hover:bg-[#192338] flex items-center justify-between transition-colors cursor-pointer"
                >
                  <span className="flex items-center gap-2">
                    <ChevronRight className="w-3.5 h-3.5 text-[#3B82F6]" strokeWidth={1.75} />
                    <span>{act.label}</span>
                  </span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#161922] border border-[#2A2F40] text-[#9499A6]">
                    {act.shortcut}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Top Command Bar (38px structural shell) */}
      <header className="h-[38px] shrink-0 bg-[#0F1117] border-b border-[#1E2230] px-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-5 h-5 rounded bg-[#161922] border border-[#2A2F40] flex items-center justify-center">
            <ShieldCheck className="w-3.5 h-3.5 text-[#3B82F6]" strokeWidth={1.75} />
          </div>
          <span className="text-[12px] font-semibold tracking-tight text-[#ECEEF2]">
            NovaTransfer • TUS & Parallel Range SHA-512 Console
          </span>
          <span className="text-[11px] text-[#636875] font-mono">
            {simulationMode ? '[Simülasyon]' : `[${serverUrl}]`}
          </span>
        </div>

        {/* Center Command Palette Trigger */}
        <button
          onClick={() => setIsCmdPaletteOpen(true)}
          className="h-[26px] w-[240px] px-2.5 rounded bg-[#161922] hover:bg-[#1C202B] border border-[#2A2F40] text-[11px] text-[#9499A6] flex items-center justify-between transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-1.5">
            <Command className="w-3 h-3 text-[#636875]" strokeWidth={1.5} />
            <span>Hızlı Komut Çalıştır...</span>
          </span>
          <kbd className="text-[10px] font-mono text-[#636875]">Ctrl+K</kbd>
        </button>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setSimulationMode((v) => !v)}
            className="h-[26px] px-2.5 rounded text-[11px] font-medium bg-[#161922] hover:bg-[#1C202B] text-[#9499A6] hover:text-[#ECEEF2] border border-[#2A2F40] flex items-center gap-1.5 transition-colors cursor-pointer"
            title="Canlı FileBrowser Sunucusu ile Yerel Simülasyon arasında geçiş yap"
          >
            <Activity className="w-3.5 h-3.5 text-[#3B82F6]" strokeWidth={1.5} />
            <span>{simulationMode ? 'Mod: Simülasyon' : 'Mod: Canlı Sunucu'}</span>
          </button>

          <button
            onClick={() => handleGenerateTestFile(120)}
            className="h-[26px] px-2.5 rounded text-[11px] font-medium bg-[#161922] hover:bg-[#1C202B] text-[#ECEEF2] border border-[#2A2F40] flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Cpu className="w-3.5 h-3.5 text-[#9499A6]" strokeWidth={1.5} />
            <span>120 MB Test Yükle</span>
          </button>

          <button
            onClick={handleModernFilePicker}
            className="h-[26px] px-3 rounded text-[11px] font-medium bg-[#3B82F6] hover:bg-[#2563EB] text-white flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" strokeWidth={1.75} />
            <span>Dosya Seç ve Yükle</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFallbackInput}
          />
        </div>
      </header>

      {/* Main Middle Body: Sidebar + Content Area */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Sidebar Navigation (250px) */}
        <aside className="w-[250px] shrink-0 bg-[#0F1117] border-r border-[#1E2230] flex flex-col justify-between p-2">
          <div className="space-y-4">
            <div>
              <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-[#636875]">
                Çalışma Alanı
              </div>
              <nav className="mt-1 space-y-0.5">
                <button
                  onClick={() => setActiveNav('transfers')}
                  className={`w-full h-[30px] px-2.5 rounded text-[12px] flex items-center justify-between transition-colors cursor-pointer ${
                    activeNav === 'transfers'
                      ? 'bg-[#192338] text-[#ECEEF2] font-medium'
                      : 'text-[#9499A6] hover:bg-[#1C202B] hover:text-[#ECEEF2]'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <HardDrive className="w-3.5 h-3.5" strokeWidth={1.5} />
                    <span>Yüklemeler (TUS Upload)</span>
                  </span>
                  <span className="text-[11px] font-mono text-[#636875] tabular-nums">
                    {Object.keys(transfers).length}
                  </span>
                </button>

                <button
                  onClick={() => {
                    setActiveNav('remote-files');
                    fetchRemoteFiles();
                  }}
                  className={`w-full h-[30px] px-2.5 rounded text-[12px] flex items-center justify-between transition-colors cursor-pointer ${
                    activeNav === 'remote-files'
                      ? 'bg-[#192338] text-[#ECEEF2] font-medium'
                      : 'text-[#9499A6] hover:bg-[#1C202B] hover:text-[#ECEEF2]'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <Download className="w-3.5 h-3.5" strokeWidth={1.5} />
                    <span>Sunucu & Paralel İndir</span>
                  </span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#161922] border border-[#2A2F40] text-[#3B82F6]">
                    {downloadConcurrency}x Range
                  </span>
                </button>

                <button
                  onClick={() => setActiveNav('linux-setup')}
                  className={`w-full h-[30px] px-2.5 rounded text-[12px] flex items-center justify-between transition-colors cursor-pointer ${
                    activeNav === 'linux-setup'
                      ? 'bg-[#192338] text-[#ECEEF2] font-medium'
                      : 'text-[#9499A6] hover:bg-[#1C202B] hover:text-[#ECEEF2]'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <Server className="w-3.5 h-3.5" strokeWidth={1.5} />
                    <span>Linux Sunucu Kurulumu</span>
                  </span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#161922] border border-[#2A2F40] text-[#9499A6]">
                    BBR+TUS
                  </span>
                </button>

                <button
                  onClick={() => setActiveNav('settings')}
                  className={`w-full h-[30px] px-2.5 rounded text-[12px] flex items-center justify-between transition-colors cursor-pointer ${
                    activeNav === 'settings'
                      ? 'bg-[#192338] text-[#ECEEF2] font-medium'
                      : 'text-[#9499A6] hover:bg-[#1C202B] hover:text-[#ECEEF2]'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <Sliders className="w-3.5 h-3.5" strokeWidth={1.5} />
                    <span>Protokol & Kanal Ayarı</span>
                  </span>
                </button>
              </nav>
            </div>

            {/* Persisted Resumable Sessions in IndexedDB */}
            <div>
              <div className="px-2 py-1 flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-wider text-[#636875]">
                  Kayıtlı Oturumlar (IDB)
                </span>
                {persistedList.length > 0 && (
                  <button
                    onClick={async () => {
                      await clearAllPersistedSessions();
                      await refreshPersistedSessions();
                    }}
                    className="text-[11px] text-[#636875] hover:text-[#ECEEF2] cursor-pointer"
                  >
                    Temizle
                  </button>
                )}
              </div>

              <div className="mt-1 space-y-1 max-h-[240px] overflow-y-auto">
                {persistedList.length === 0 ? (
                  <div className="px-2.5 py-2.5 rounded bg-[#161922]/60 border border-[#1E2230] text-[11px] text-[#636875] leading-relaxed">
                    Duraklatılan yüklemelerin SHA-512 durumu ve dosya referansı (`FileSystemFileHandle`) burada korunur.
                  </div>
                ) : (
                  persistedList.map((sess) => {
                    const pct = ((sess.offset / Math.max(1, sess.fileSize)) * 100).toFixed(1);
                    return (
                      <div
                        key={sess.fingerprint}
                        className="p-2 rounded bg-[#161922] border border-[#1E2230] hover:border-[#2A2F40] space-y-1.5"
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[11px] font-medium text-[#ECEEF2] truncate">
                            {sess.fileName}
                          </span>
                          <span className="text-[11px] font-mono text-[#3B82F6] shrink-0 tabular-nums">
                            %{pct}
                          </span>
                        </div>
                        <div className="text-[10px] font-mono text-[#636875] truncate">
                          FP: {sess.fingerprint.slice(0, 16)}…
                        </div>
                        <div className="flex items-center justify-between pt-0.5">
                          <span className="text-[10px] font-mono text-[#9499A6] tabular-nums">
                            {formatBytes(sess.offset)} / {formatBytes(sess.fileSize)}
                          </span>
                          <button
                            onClick={() => handleResumePersistedSession(sess)}
                            className="h-[22px] px-2 rounded bg-[#3B82F6] hover:bg-[#2563EB] text-white text-[10px] font-medium flex items-center gap-1 cursor-pointer"
                          >
                            <Play className="w-2.5 h-2.5" strokeWidth={2} />
                            <span>Devam Et</span>
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* Bottom Telemetry Card */}
          <div className="p-2.5 rounded bg-[#161922] border border-[#1E2230] space-y-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[#9499A6] flex items-center gap-1.5">
                <Lock className="w-3 h-3 text-[#3B82F6]" strokeWidth={1.5} />
                <span>SHA-512 Pipeline</span>
              </span>
              <span className="font-mono text-[10px] text-emerald-400">0 ms Gecikme</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 pt-1 border-t border-[#1E2230] text-[10px] font-mono">
              <div>
                <div className="text-[#636875]">Range Kanalı</div>
                <div className="text-[#ECEEF2] tabular-nums">{downloadConcurrency}x Paralel</div>
              </div>
              <div>
                <div className="text-[#636875]">Toplam Hız</div>
                <div className="text-[#ECEEF2] tabular-nums">
                  {formatBytes(totalSpeedBytesPerSec)}/s
                </div>
              </div>
            </div>
          </div>
        </aside>

        {/* Center Workspace */}
        <main className="flex-1 flex flex-col min-w-0 bg-[#0A0B0E] overflow-hidden">
          {activeNav === 'transfers' && (
            <>
              {/* Upper Data Table Section */}
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                {/* Section Header Bar with Filter */}
                <div className="h-[36px] shrink-0 px-4 border-b border-[#1E2230] flex items-center justify-between bg-[#0A0B0E]">
                  <div className="flex items-center gap-2 text-[12px] font-medium text-[#ECEEF2]">
                    <span>TUS Parçalı Yükleme Kuyruğu (Upload)</span>
                    <span className="text-[11px] font-mono text-[#636875]">
                      ({targetFolder})
                    </span>
                  </div>

                  <div className="flex items-center gap-2.5">
                    <div className="relative flex items-center">
                      <Search
                        className="w-3.5 h-3.5 text-[#636875] absolute left-2 pointer-events-none"
                        strokeWidth={1.5}
                      />
                      <input
                        type="text"
                        value={searchFilter}
                        onChange={(e) => setSearchFilter(e.target.value)}
                        placeholder="Dosya veya parmak izi filtrele..."
                        className="h-[24px] w-[210px] pl-7 pr-2 rounded bg-[#161922] border border-[#2A2F40] text-[11px] text-[#ECEEF2] placeholder-[#636875] focus:outline-none focus:border-[#3B82F6]"
                      />
                    </div>
                  </div>
                </div>

                {/* Dense DataGrid */}
                <div className="flex-1 overflow-auto">
                  {transferList.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center p-8 text-center">
                      <div className="w-10 h-10 rounded bg-[#161922] border border-[#2A2F40] flex items-center justify-center mb-3">
                        <FolderOpen className="w-5 h-5 text-[#9499A6]" strokeWidth={1.5} />
                      </div>
                      <p className="text-[13px] font-medium text-[#ECEEF2]">
                        Dosyaları bu pencereye sürükleyin veya aktarım başlatın
                      </p>
                      <p className="text-[12px] text-[#636875] mt-1 max-w-md">
                        100 GB+ dosyalar yalnızca {chunkSizeMb} MB bellek dilimiyle parçalı (TUS) aktarılır; her parça <code className="text-[#9499A6]">Upload-Checksum: sha512</code> ile doğrulanır.
                      </p>
                      <div className="mt-4 flex items-center gap-2">
                        <button
                          onClick={handleModernFilePicker}
                          className="h-[30px] px-3.5 rounded text-[12px] font-medium bg-[#3B82F6] hover:bg-[#2563EB] text-white flex items-center gap-1.5 cursor-pointer"
                        >
                          <Upload className="w-3.5 h-3.5" strokeWidth={1.75} />
                          <span>Bilgisayardan Dosya Seç</span>
                        </button>
                        <button
                          onClick={() => handleGenerateTestFile(120)}
                          className="h-[30px] px-3.5 rounded text-[12px] font-medium bg-[#161922] hover:bg-[#1C202B] text-[#ECEEF2] border border-[#2A2F40] flex items-center gap-1.5 cursor-pointer"
                        >
                          <Cpu className="w-3.5 h-3.5 text-[#9499A6]" strokeWidth={1.5} />
                          <span>120 MB Test Yüklemesi Başlat</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="h-[30px] bg-[#0F1117] border-b border-[#1E2230] text-[11px] font-medium text-[#636875] uppercase">
                          <th className="pl-4 pr-2">Dosya Adı & Hedef</th>
                          <th className="px-2">Parmak İzi (3ms SHA-512)</th>
                          <th className="px-2 w-[240px]">İlerleme & Parça</th>
                          <th className="px-2 text-right">Aktarılan / Boyut</th>
                          <th className="px-2 text-right">Hız & Kalan</th>
                          <th className="px-2">Durum</th>
                          <th className="pl-2 pr-4 text-right">Kontrol</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#161821] text-[12px]">
                        {transferList.map((item) => {
                          const isSelected = selectedTransfer?.fingerprint === item.fingerprint;
                          return (
                            <tr
                              key={item.fingerprint}
                              onClick={() => setSelectedFingerprint(item.fingerprint)}
                              className={`h-[44px] transition-colors cursor-pointer ${
                                isSelected ? 'bg-[#192338]' : 'hover:bg-[#1C202B]'
                              }`}
                            >
                              <td className="pl-4 pr-2 max-w-[240px]">
                                <div className="font-medium text-[#ECEEF2] truncate">
                                  {item.fileName}
                                </div>
                                <div className="text-[11px] font-mono text-[#636875] truncate">
                                  {item.targetPath}
                                </div>
                              </td>

                              <td className="px-2 font-mono text-[11px] text-[#9499A6]">
                                <span title={item.fingerprint}>
                                  {item.fingerprint
                                    ? `${item.fingerprint.slice(0, 14)}…`
                                    : 'Hesaplanıyor'}
                                </span>
                                {item.resumedFromOffset !== undefined && (
                                  <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded bg-[#161922] border border-[#2A2F40] text-[#ECEEF2]">
                                    Devam
                                  </span>
                                )}
                              </td>

                              <td className="px-2">
                                <div className="flex items-center justify-between text-[11px] font-mono mb-1">
                                  <span className="text-[#ECEEF2] tabular-nums">
                                    %{item.percent.toFixed(1)}
                                  </span>
                                  <span className="text-[#636875] tabular-nums">
                                    Parça {item.currentChunkIndex}/{item.totalChunks}
                                  </span>
                                </div>
                                <div className="w-full h-1.5 bg-[#161922] rounded-full overflow-hidden">
                                  <div
                                    className={`h-full transition-all duration-150 ${
                                      item.status === 'completed'
                                        ? 'bg-emerald-500'
                                        : item.status === 'paused'
                                        ? 'bg-amber-500'
                                        : item.status === 'error'
                                        ? 'bg-rose-500'
                                        : 'bg-[#3B82F6]'
                                    }`}
                                    style={{ width: `${Math.min(100, item.percent)}%` }}
                                  />
                                </div>
                              </td>

                              <td className="px-2 text-right font-mono text-[11px] tabular-nums text-[#ECEEF2]">
                                <div>{formatBytes(item.offset)}</div>
                                <div className="text-[#636875]">{formatBytes(item.totalSize)}</div>
                              </td>

                              <td className="px-2 text-right font-mono text-[11px] tabular-nums">
                                {item.status === 'uploading' ? (
                                  <>
                                    <div className="text-[#ECEEF2]">
                                      {formatBytes(item.speedBytesPerSec)}/sn
                                    </div>
                                    <div className="text-[#636875]">
                                      {formatDuration(item.etaSeconds)}
                                    </div>
                                  </>
                                ) : (
                                  <span className="text-[#636875]">—</span>
                                )}
                              </td>

                              <td className="px-2">
                                {item.status === 'completed' && (
                                  <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
                                    <CheckCircle2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                                    <span>SHA-512 Doğrulandı</span>
                                  </span>
                                )}
                                {item.status === 'uploading' && (
                                  <span className="inline-flex items-center gap-1 text-[11px] text-[#3B82F6] font-medium">
                                    <RefreshCw
                                      className="w-3.5 h-3.5 animate-spin"
                                      strokeWidth={1.75}
                                    />
                                    <span>Aktarılıyor</span>
                                  </span>
                                )}
                                {item.status === 'paused' && (
                                  <span className="inline-flex items-center gap-1 text-[11px] text-amber-400 font-medium">
                                    <Pause className="w-3.5 h-3.5" strokeWidth={1.75} />
                                    <span>Duraklatıldı</span>
                                  </span>
                                )}
                                {item.status === 'verifying' && (
                                  <span className="inline-flex items-center gap-1 text-[11px] text-[#9499A6]">
                                    <ShieldCheck className="w-3.5 h-3.5" strokeWidth={1.75} />
                                    <span>Sunucu Özeti</span>
                                  </span>
                                )}
                                {item.status === 'error' && (
                                  <span className="inline-flex items-center gap-1 text-[11px] text-rose-400 font-medium">
                                    <AlertCircle className="w-3.5 h-3.5" strokeWidth={1.75} />
                                    <span>Hata</span>
                                  </span>
                                )}
                              </td>

                              <td
                                className="pl-2 pr-4 text-right"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <div className="inline-flex items-center gap-1">
                                  {item.status === 'uploading' && (
                                    <button
                                      onClick={() => handlePause(item.fingerprint)}
                                      className="h-[26px] px-2.5 rounded bg-[#161922] hover:bg-[#1C202B] border border-[#2A2F40] text-[#ECEEF2] text-[11px] flex items-center gap-1 cursor-pointer"
                                      title="Anında Duraklat (Boşluk Tuşu)"
                                    >
                                      <Pause className="w-3 h-3" strokeWidth={1.75} />
                                      <span>Durdur</span>
                                    </button>
                                  )}
                                  {(item.status === 'paused' || item.status === 'error') && (
                                    <button
                                      onClick={() => handleResumeActive(item.fingerprint)}
                                      className="h-[26px] px-2.5 rounded bg-[#3B82F6] hover:bg-[#2563EB] text-white text-[11px] flex items-center gap-1 cursor-pointer"
                                      title="Kaldığı bayttan ve SHA-512 durumundan devam et (Boşluk Tuşu)"
                                    >
                                      <Play className="w-3 h-3" strokeWidth={1.75} />
                                      <span>Devam Et</span>
                                    </button>
                                  )}
                                  <button
                                    onClick={() => handleRemoveTransfer(item.fingerprint)}
                                    className="h-[26px] w-[26px] rounded bg-[#161922] hover:bg-[#1C202B] border border-[#2A2F40] text-[#9499A6] hover:text-rose-400 flex items-center justify-center cursor-pointer"
                                    title="Listeden ve IndexedDB hafızasından kaldır"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {/* Bottom Inspector Pane (250px) */}
              <section className="h-[250px] shrink-0 bg-[#0F1117] border-t border-[#1E2230] flex flex-col">
                <div className="h-[34px] px-4 border-b border-[#1E2230] flex items-center justify-between">
                  <div className="flex items-center gap-5 h-full">
                    <button
                      onClick={() => setInspectorTab('crypto')}
                      className={`h-full text-[12px] font-medium flex items-center gap-1.5 border-b-2 transition-colors cursor-pointer ${
                        inspectorTab === 'crypto'
                          ? 'border-[#3B82F6] text-[#ECEEF2]'
                          : 'border-transparent text-[#9499A6] hover:text-[#ECEEF2]'
                      }`}
                    >
                      <ShieldCheck className="w-3.5 h-3.5" strokeWidth={1.5} />
                      <span>SHA-512 Kriptografik Denetim</span>
                    </button>

                    <button
                      onClick={() => setInspectorTab('chunk-map')}
                      className={`h-full text-[12px] font-medium flex items-center gap-1.5 border-b-2 transition-colors cursor-pointer ${
                        inspectorTab === 'chunk-map'
                          ? 'border-[#3B82F6] text-[#ECEEF2]'
                          : 'border-transparent text-[#9499A6] hover:text-[#ECEEF2]'
                      }`}
                    >
                      <Layers className="w-3.5 h-3.5" strokeWidth={1.5} />
                      <span>
                        Canlı Parça Haritası (
                        {selectedTransfer
                          ? `${selectedTransfer.currentChunkIndex}/${selectedTransfer.totalChunks}`
                          : '0/0'}
                        )
                      </span>
                    </button>

                    <button
                      onClick={() => setInspectorTab('logs')}
                      className={`h-full text-[12px] font-medium flex items-center gap-1.5 border-b-2 transition-colors cursor-pointer ${
                        inspectorTab === 'logs'
                          ? 'border-[#3B82F6] text-[#ECEEF2]'
                          : 'border-transparent text-[#9499A6] hover:text-[#ECEEF2]'
                      }`}
                    >
                      <Terminal className="w-3.5 h-3.5" strokeWidth={1.5} />
                      <span>Protokol Günlüğü ({logs.length})</span>
                    </button>

                    <button
                      onClick={() => {
                        setInspectorTab('audit');
                        if (!simulationMode) fetchServerAuditLog();
                      }}
                      className={`h-full text-[12px] font-medium flex items-center gap-1.5 border-b-2 transition-colors cursor-pointer ${
                        inspectorTab === 'audit'
                          ? 'border-[#3B82F6] text-[#ECEEF2]'
                          : 'border-transparent text-[#9499A6] hover:text-[#ECEEF2]'
                      }`}
                    >
                      <FileCode className="w-3.5 h-3.5" strokeWidth={1.5} />
                      <span>Sunucu Audit Log (.audit.log)</span>
                    </button>

                    <button
                      onClick={() => setInspectorTab('connection')}
                      className={`h-full text-[12px] font-medium flex items-center gap-1.5 border-b-2 transition-colors cursor-pointer ${
                        inspectorTab === 'connection'
                          ? 'border-[#3B82F6] text-[#ECEEF2]'
                          : 'border-transparent text-[#9499A6] hover:text-[#ECEEF2]'
                      }`}
                    >
                      <Server className="w-3.5 h-3.5" strokeWidth={1.5} />
                      <span>Hızlı Bağlantı & Oturum</span>
                    </button>
                  </div>

                  {selectedTransfer && (
                    <div className="text-[11px] font-mono text-[#636875]">
                      Seçili: <span className="text-[#9499A6]">{selectedTransfer.fileName}</span>
                    </div>
                  )}
                </div>

                {/* Inspector Tab Content */}
                <div className="flex-1 overflow-auto p-3.5">
                  {inspectorTab === 'crypto' && (
                    <div className="grid grid-cols-2 gap-4 text-[12px]">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-[#9499A6]">
                            3ms Kriptografik Dosya Parmak İzi (İlk/Orta/Son 1 MB SHA-512)
                          </span>
                          {selectedTransfer?.fingerprint && (
                            <button
                              onClick={() => handleCopy('fp', selectedTransfer.fingerprint)}
                              className="text-[11px] text-[#9499A6] hover:text-[#ECEEF2] flex items-center gap-1 cursor-pointer"
                            >
                              {copiedId === 'fp' ? (
                                <Check className="w-3 h-3 text-emerald-400" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                              <span>Kopyala</span>
                            </button>
                          )}
                        </div>
                        <div className="p-2 rounded bg-[#161922] border border-[#1E2230] font-mono text-[11px] text-[#ECEEF2] break-all">
                          {selectedTransfer?.fingerprint ||
                            'Bir dosya seçildiğinde 3 milisaniyede hesaplanır.'}
                        </div>

                        <div className="text-[11px] text-[#9499A6] pt-1">
                          Son Gönderilen Parça Başlığı (TUS Upload-Checksum)
                        </div>
                        <div className="p-2 rounded bg-[#161922] border border-[#1E2230] font-mono text-[11px] text-[#9499A6] truncate">
                          {selectedTransfer?.lastChunkSha512Base64
                            ? `Upload-Checksum: sha512 ${selectedTransfer.lastChunkSha512Base64}`
                            : 'Upload-Checksum: sha512 (Parça aktarımı bekleniyor)'}
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-[#9499A6]">
                            Tam Dosya Nihai SHA-512 Özeti (İstemci WASM ↔ Linux Sunucu)
                          </span>
                          {selectedTransfer?.clientSha512 && (
                            <button
                              onClick={() =>
                                handleCopy('sha512', selectedTransfer.clientSha512!)
                              }
                              className="text-[11px] text-[#9499A6] hover:text-[#ECEEF2] flex items-center gap-1 cursor-pointer"
                            >
                              {copiedId === 'sha512' ? (
                                <Check className="w-3 h-3 text-emerald-400" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                              <span>SHA-512 Kopyala</span>
                            </button>
                          )}
                        </div>
                        <div className="p-2 rounded bg-[#161922] border border-[#1E2230] font-mono text-[11px] text-[#ECEEF2] break-all leading-relaxed">
                          {selectedTransfer?.clientSha512 ||
                            (selectedTransfer?.status === 'uploading'
                              ? `Akış halinde hesaplanıyor... (%${selectedTransfer.percent.toFixed(1)} tamamlandı)`
                              : 'Aktarım tamamlandığında 128 karakterlik tam SHA-512 özeti burada görüntülenir.')}
                        </div>

                        {selectedTransfer?.verified && (
                          <div className="px-2.5 py-1.5 rounded bg-[#161922] border border-emerald-500/30 flex items-center justify-between text-[11px]">
                            <span className="text-emerald-400 flex items-center gap-1.5 font-medium">
                              <CheckCircle2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                              <span>İstemci ve Linux Sunucu SHA-512 Özetleri %100 Eşleşti</span>
                            </span>
                            <span className="font-mono text-[#9499A6]">512-bit OK</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {inspectorTab === 'chunk-map' && (
                    <div className="space-y-2.5">
                      {!selectedTransfer ? (
                        <div className="text-[12px] text-[#636875]">
                          Canlı parça (chunk) ve pipeline haritasını görmek için bir aktarım başlatın veya seçin.
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center justify-between text-[11px]">
                            <div className="flex items-center gap-4">
                              <span className="flex items-center gap-1.5 text-[#9499A6]">
                                <span className="w-2.5 h-2.5 rounded-xs bg-emerald-500 inline-block" />
                                <span>SHA-512 Doğrulandı ({selectedTransfer.currentChunkIndex})</span>
                              </span>
                              <span className="flex items-center gap-1.5 text-[#9499A6]">
                                <span className="w-2.5 h-2.5 rounded-xs bg-[#3B82F6] inline-block" />
                                <span>Aktif TUS PATCH Gönderimi</span>
                              </span>
                              <span className="flex items-center gap-1.5 text-[#9499A6]">
                                <span className="w-2.5 h-2.5 rounded-xs bg-[#1E293B] border border-[#3B82F6]/60 inline-block" />
                                <span>Pipelined Ön-Hazırlık (N+1)</span>
                              </span>
                              <span className="flex items-center gap-1.5 text-[#9499A6]">
                                <span className="w-2.5 h-2.5 rounded-xs bg-[#161922] border border-[#2A2F40] inline-block" />
                                <span>Sırada Bekleyen</span>
                              </span>
                            </div>
                            <span className="font-mono text-[#9499A6] tabular-nums">
                              {selectedTransfer.totalChunks} Parça × {chunkSizeMb} MB
                            </span>
                          </div>

                          <div className="grid grid-cols-24 gap-1.5 p-2.5 rounded bg-[#161922]/60 border border-[#1E2230] max-h-[135px] overflow-y-auto">
                            {Array.from({
                              length: Math.min(240, selectedTransfer.totalChunks),
                            }).map((_, idx) => {
                              const done = idx < selectedTransfer.currentChunkIndex;
                              const active =
                                idx === selectedTransfer.currentChunkIndex &&
                                selectedTransfer.status === 'uploading';
                              const pausedHere =
                                idx === selectedTransfer.currentChunkIndex &&
                                selectedTransfer.status === 'paused';
                              const pipelined =
                                idx === selectedTransfer.currentChunkIndex + 1 &&
                                selectedTransfer.status === 'uploading';

                              return (
                                <div
                                  key={idx}
                                  title={`Parça #${idx + 1} (${idx * chunkSizeMb} MB – ${(idx + 1) * chunkSizeMb} MB)`}
                                  className={`h-[22px] rounded-xs font-mono text-[10px] flex items-center justify-center tabular-nums transition-colors ${
                                    done
                                      ? 'bg-emerald-500/20 border border-emerald-500/60 text-emerald-300'
                                      : active
                                      ? 'bg-[#3B82F6] text-white font-semibold'
                                      : pausedHere
                                      ? 'bg-amber-500/30 border border-amber-500 text-amber-300'
                                      : pipelined
                                      ? 'bg-[#192338] border border-[#3B82F6]/60 text-[#9499A6]'
                                      : 'bg-[#161922] border border-[#1E2230] text-[#636875]'
                                  }`}
                                >
                                  {idx + 1}
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {inspectorTab === 'logs' && (
                    <div className="space-y-1 font-mono text-[11px]">
                      {logs.map((log) => (
                        <div key={log.id} className="flex items-start gap-2.5 py-0.5">
                          <span className="text-[#636875] shrink-0">{log.time}</span>
                          <span
                            className={
                              log.level === 'success'
                                ? 'text-emerald-400'
                                : log.level === 'warn'
                                ? 'text-amber-400'
                                : log.level === 'error'
                                ? 'text-rose-400'
                                : 'text-[#ECEEF2]'
                            }
                          >
                            {log.message}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {inspectorTab === 'audit' && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-[#9499A6]">
                          Linux Sunucu <code className="text-[#ECEEF2]">/srv/transfers/.audit.log</code> (FileBrowser <code className="text-[#ECEEF2]">after_upload</code> / <code className="text-[#ECEEF2]">after_delete</code> Hook Çıktısı)
                        </span>
                        <button
                          onClick={fetchServerAuditLog}
                          className="h-[24px] px-2.5 rounded bg-[#161922] hover:bg-[#1C202B] border border-[#2A2F40] text-[11px] text-[#ECEEF2] flex items-center gap-1.5 cursor-pointer"
                        >
                          <RefreshCw className="w-3 h-3 text-[#3B82F6]" strokeWidth={1.75} />
                          <span>GET /api/raw/.audit.log Yenile</span>
                        </button>
                      </div>
                      <div className="p-2.5 rounded bg-[#161922] border border-[#1E2230] font-mono text-[11px] space-y-1 max-h-[140px] overflow-y-auto">
                        {auditLines.map((line, i) => (
                          <div
                            key={i}
                            className="text-[#ECEEF2] py-0.5 border-b border-[#1E2230]/50 last:border-none"
                          >
                            {line}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {inspectorTab === 'connection' && (
                    <div className="grid grid-cols-4 gap-3 items-end text-[12px]">
                      <div>
                        <label className="block text-[11px] text-[#9499A6] mb-1">
                          FileBrowser Sunucu URL
                        </label>
                        <input
                          type="text"
                          value={serverUrl}
                          onChange={(e) => setServerUrl(e.target.value)}
                          className="w-full h-[30px] px-2.5 rounded bg-[#161922] border border-[#2A2F40] text-[12px] font-mono text-[#ECEEF2] focus:outline-none focus:border-[#3B82F6]"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-[#9499A6] mb-1">
                          Kullanıcı Adı
                        </label>
                        <input
                          type="text"
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                          className="w-full h-[30px] px-2.5 rounded bg-[#161922] border border-[#2A2F40] text-[12px] text-[#ECEEF2] focus:outline-none focus:border-[#3B82F6]"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-[#9499A6] mb-1">
                          Şifre
                        </label>
                        <input
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          className="w-full h-[30px] px-2.5 rounded bg-[#161922] border border-[#2A2F40] text-[12px] text-[#ECEEF2] focus:outline-none focus:border-[#3B82F6]"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleLoginToken}
                          className="h-[30px] px-3.5 rounded bg-[#3B82F6] hover:bg-[#2563EB] text-white text-[12px] font-medium cursor-pointer"
                        >
                          JWT Token Al & Bağlan
                        </button>
                        {authStatus === 'ok' && (
                          <span className="text-[11px] text-emerald-400 font-medium">Bağlandı</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </>
          )}

          {/* Remote Server File Explorer + Parallel HTTP 206 Range Downloader View */}
          {activeNav === 'remote-files' && (
            <>
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                <div className="h-[36px] shrink-0 px-4 border-b border-[#1E2230] flex items-center justify-between bg-[#0A0B0E]">
                  <div className="flex items-center gap-2 text-[12px] font-medium text-[#ECEEF2]">
                    <Server className="w-3.5 h-3.5 text-[#3B82F6]" strokeWidth={1.5} />
                    <span>Linux Sunucu Dosya Gezgini & Çok Kanallı Range İndirici</span>
                    <span className="text-[11px] font-mono text-[#636875]">
                      (/srv{targetFolder} • {downloadConcurrency}x Paralel HTTP 206 Kanalı)
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5 text-[11px] text-[#9499A6]">
                      <span>Paralel Kanal:</span>
                      {[4, 6, 8, 16].map((n) => (
                        <button
                          key={n}
                          onClick={() => setDownloadConcurrency(n)}
                          className={`h-[22px] px-2 rounded font-mono text-[10px] border cursor-pointer ${
                            downloadConcurrency === n
                              ? 'bg-[#192338] border-[#3B82F6] text-[#ECEEF2]'
                              : 'bg-[#161922] border-[#2A2F40] text-[#9499A6]'
                          }`}
                        >
                          {n}x
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={fetchRemoteFiles}
                      className="h-[24px] px-2.5 rounded bg-[#161922] hover:bg-[#1C202B] border border-[#2A2F40] text-[11px] text-[#ECEEF2] flex items-center gap-1.5 cursor-pointer"
                    >
                      <RefreshCw className="w-3 h-3 text-[#3B82F6]" strokeWidth={1.5} />
                      <span>Listeyi Yenile</span>
                    </button>
                  </div>
                </div>

                {/* Server Files Table */}
                <div className="flex-1 overflow-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="h-[30px] bg-[#0F1117] border-b border-[#1E2230] text-[11px] font-medium text-[#636875] uppercase">
                        <th className="pl-4 pr-2">Sunucu Dosya Adı</th>
                        <th className="px-2">Tam Yol</th>
                        <th className="px-2 text-right">Boyut</th>
                        <th className="px-2">Sunucu SHA-512 Özeti (?checksum=sha512)</th>
                        <th className="px-2">Değiştirilme</th>
                        <th className="pl-2 pr-4 text-right">Paralel Range İndirme & İşlem</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#161821] text-[12px]">
                      {remoteFiles.map((file) => (
                        <tr
                          key={file.path}
                          className="h-[42px] hover:bg-[#1C202B] transition-colors"
                        >
                          <td className="pl-4 pr-2 font-medium text-[#ECEEF2] flex items-center gap-2 h-[42px]">
                            <FileText className="w-3.5 h-3.5 text-[#3B82F6]" strokeWidth={1.5} />
                            <span>{file.name}</span>
                          </td>
                          <td className="px-2 font-mono text-[11px] text-[#9499A6]">
                            {file.path}
                          </td>
                          <td className="px-2 text-right font-mono text-[11px] tabular-nums text-[#ECEEF2]">
                            {formatBytes(file.size)}
                          </td>
                          <td className="px-2 font-mono text-[11px] text-[#9499A6]">
                            {file.sha512 ? (
                              <span className="text-emerald-400" title={file.sha512}>
                                {file.sha512.slice(0, 26)}…
                              </span>
                            ) : (
                              <span className="text-[#636875]">Sorgulanmadı</span>
                            )}
                          </td>
                          <td className="px-2 font-mono text-[11px] text-[#636875]">
                            {file.modified}
                          </td>
                          <td className="pl-2 pr-4 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                onClick={() => startParallelRangeDownload(file, false)}
                                className="h-[26px] px-2.5 rounded bg-[#3B82F6] hover:bg-[#2563EB] text-white text-[11px] font-medium flex items-center gap-1.5 cursor-pointer"
                                title={`Dosyayı ${downloadConcurrency} eşzamanlı HTTP 206 Range kanalıyla indir ve SHA-512 doğrula`}
                              >
                                <Download className="w-3 h-3" strokeWidth={1.75} />
                                <span>Paralel İndir ({downloadConcurrency}x)</span>
                              </button>
                              <button
                                onClick={() => handleVerifyRemoteFileSha512(file)}
                                className="h-[26px] px-2 rounded bg-[#161922] hover:bg-[#1C202B] border border-[#2A2F40] text-[11px] text-[#ECEEF2] flex items-center gap-1 cursor-pointer"
                                title="Sunucudan ?checksum=sha512 hesaplat"
                              >
                                <ShieldCheck
                                  className="w-3 h-3 text-[#3B82F6]"
                                  strokeWidth={1.5}
                                />
                                <span>SHA-512</span>
                              </button>
                              <button
                                onClick={() => handleDeleteRemoteFile(file)}
                                className="h-[26px] w-[26px] rounded bg-[#161922] hover:bg-[#1C202B] border border-[#2A2F40] text-[#9499A6] hover:text-rose-400 flex items-center justify-center cursor-pointer"
                                title="Sunucudan Sil (after_delete .audit.log kancasını tetikler)"
                              >
                                <Trash2 className="w-3 h-3" strokeWidth={1.5} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Bottom Parallel HTTP 206 Range Downloads & Live Multi-Channel Chunk Matrix */}
              <section className="h-[275px] shrink-0 bg-[#0F1117] border-t border-[#1E2230] flex flex-col">
                <div className="h-[34px] px-4 border-b border-[#1E2230] flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[12px] font-medium text-[#ECEEF2]">
                    <Layers className="w-3.5 h-3.5 text-[#3B82F6]" strokeWidth={1.5} />
                    <span>
                      Çok Kanallı Paralel HTTP 206 Range İndirmeleri & Canlı Kanal Haritası
                    </span>
                  </div>
                  {selectedDownload && (
                    <div className="text-[11px] font-mono text-[#9499A6] tabular-nums">
                      Aktif Kanal: {selectedDownload.activeWorkers}/
                      {selectedDownload.concurrency} • Tamamlanan Parça:{' '}
                      {selectedDownload.completedChunksCount}/{selectedDownload.totalChunks}
                    </div>
                  )}
                </div>

                <div className="flex-1 overflow-auto p-3.5">
                  {downloadList.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-[12px] text-[#636875]">
                      Yukarıdaki sunucu listesinden herhangi bir dosyanın yanındaki &quot;Paralel İndir ({downloadConcurrency}x)&quot; butonuna tıklayarak çok kanallı Range indirmesini ve canlı parça matrisini başlatın.
                    </div>
                  ) : (
                    <div className="grid grid-cols-12 gap-4">
                      {/* Left 6 cols: Active Parallel Range Downloads List */}
                      <div className="col-span-6 space-y-2 max-h-[210px] overflow-y-auto pr-1">
                        {downloadList.map((dl) => {
                          const isSel = selectedDownload?.id === dl.id;
                          return (
                            <div
                              key={dl.id}
                              onClick={() => setSelectedDownloadId(dl.id)}
                              className={`p-2.5 rounded border transition-colors cursor-pointer ${
                                isSel
                                  ? 'bg-[#192338] border-[#3B82F6]/60'
                                  : 'bg-[#161922] border-[#1E2230] hover:border-[#2A2F40]'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2 mb-1">
                                <span className="text-[12px] font-medium text-[#ECEEF2] truncate">
                                  {dl.fileName}
                                </span>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  {dl.status === 'downloading' && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handlePauseDownload(dl.id);
                                      }}
                                      className="h-[22px] px-2 rounded bg-[#0F1117] hover:bg-[#1C202B] border border-[#2A2F40] text-[10px] text-[#ECEEF2] flex items-center gap-1 cursor-pointer"
                                    >
                                      <Pause className="w-2.5 h-2.5" strokeWidth={1.75} />
                                      <span>Durdur</span>
                                    </button>
                                  )}
                                  {dl.status === 'paused' && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleResumeDownload(dl.id);
                                      }}
                                      className="h-[22px] px-2 rounded bg-[#3B82F6] hover:bg-[#2563EB] text-[10px] text-white flex items-center gap-1 cursor-pointer"
                                    >
                                      <Play className="w-2.5 h-2.5" strokeWidth={1.75} />
                                      <span>Devam Et</span>
                                    </button>
                                  )}
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleRemoveDownload(dl.id);
                                    }}
                                    className="h-[22px] w-[22px] rounded bg-[#0F1117] border border-[#2A2F40] text-[#9499A6] hover:text-rose-400 flex items-center justify-center cursor-pointer"
                                  >
                                    <Trash2 className="w-3 h-3" strokeWidth={1.5} />
                                  </button>
                                </div>
                              </div>

                              <div className="flex items-center justify-between text-[11px] font-mono text-[#9499A6] tabular-nums mb-1">
                                <span>
                                  %{dl.percent.toFixed(1)} ({formatBytes(dl.downloadedBytes)} /{' '}
                                  {formatBytes(dl.totalSize)})
                                </span>
                                <span>
                                  {dl.status === 'downloading'
                                    ? `${formatBytes(dl.speedBytesPerSec)}/sn • ${dl.activeWorkers}x Kanal`
                                    : dl.status === 'completed'
                                    ? 'SHA-512 Doğrulandı'
                                    : 'Duraklatıldı'}
                                </span>
                              </div>

                              <div className="w-full h-1.5 bg-[#0F1117] rounded-full overflow-hidden">
                                <div
                                  className={`h-full transition-all duration-150 ${
                                    dl.status === 'completed'
                                      ? 'bg-emerald-500'
                                      : dl.status === 'paused'
                                      ? 'bg-amber-500'
                                      : 'bg-[#3B82F6]'
                                  }`}
                                  style={{ width: `${Math.min(100, dl.percent)}%` }}
                                />
                              </div>

                              {dl.verified && dl.clientSha512 && (
                                <div className="mt-1.5 text-[10px] font-mono text-emerald-400 truncate">
                                  SHA-512 Eşleşti: {dl.clientSha512.slice(0, 44)}…
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* Right 6 cols: Live Parallel Range Worker Chunk Matrix */}
                      <div className="col-span-6 space-y-2">
                        {selectedDownload && (
                          <>
                            <div className="flex items-center justify-between text-[11px]">
                              <div className="flex items-center gap-3">
                                <span className="flex items-center gap-1.5 text-[#9499A6]">
                                  <span className="w-2.5 h-2.5 rounded-xs bg-[#3B82F6] inline-block" />
                                  <span>
                                    Eşzamanlı İndirilen ({selectedDownload.activeWorkers}x Kanal)
                                  </span>
                                </span>
                                <span className="flex items-center gap-1.5 text-[#9499A6]">
                                  <span className="w-2.5 h-2.5 rounded-xs bg-emerald-500 inline-block" />
                                  <span>
                                    Tamamlanan ({selectedDownload.completedChunksCount})
                                  </span>
                                </span>
                                <span className="flex items-center gap-1.5 text-[#9499A6]">
                                  <span className="w-2.5 h-2.5 rounded-xs bg-amber-500 inline-block" />
                                  <span>Duraklatılan</span>
                                </span>
                              </div>
                            </div>

                            <div className="grid grid-cols-12 gap-1.5 p-2.5 rounded bg-[#161922]/60 border border-[#1E2230] max-h-[165px] overflow-y-auto">
                              {selectedDownload.chunkStates.map((st, idx) => (
                                <div
                                  key={idx}
                                  title={`Range Parçası #${idx + 1}: bytes=${idx * chunkSizeMb}M-${(idx + 1) * chunkSizeMb}M (${st})`}
                                  className={`h-[24px] rounded-xs font-mono text-[10px] flex items-center justify-center tabular-nums transition-colors ${
                                    st === 'completed'
                                      ? 'bg-emerald-500/20 border border-emerald-500/60 text-emerald-300'
                                      : st === 'downloading'
                                      ? 'bg-[#3B82F6] text-white font-semibold animate-pulse'
                                      : st === 'paused'
                                      ? 'bg-amber-500/30 border border-amber-500 text-amber-300'
                                      : 'bg-[#161922] border border-[#1E2230] text-[#636875]'
                                  }`}
                                >
                                  #{idx + 1}
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </>
          )}

          {/* Linux Server Setup Tab */}
          {activeNav === 'linux-setup' && (
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              <div className="border-b border-[#1E2230] pb-4">
                <h1 className="text-[16px] font-semibold text-[#ECEEF2]">
                  Linux Sunucu Üretim (Production) Kurulumu — FileBrowser + TUS + SHA-512 + BBR
                </h1>
                <p className="text-[12px] text-[#9499A6] mt-1">
                  Aşağıdaki scriptler proje dizininde <code className="text-[#ECEEF2]">linux-server/</code> klasörüne de kaydedilmiştir. Doğrudan Linux sunucunuzda çalıştırabilirsiniz.
                </p>
              </div>

              <div className="space-y-6">
                {LINUX_SERVER_GUIDES.map((guide) => (
                  <div
                    key={guide.id}
                    className="rounded bg-[#0F1117] border border-[#1E2230] overflow-hidden"
                  >
                    <div className="px-4 py-3 border-b border-[#1E2230] flex items-center justify-between">
                      <div>
                        <div className="text-[13px] font-semibold text-[#ECEEF2] flex items-center gap-2">
                          <FileCode className="w-4 h-4 text-[#3B82F6]" strokeWidth={1.5} />
                          <span>{guide.title}</span>
                        </div>
                        <p className="text-[11px] text-[#9499A6] mt-0.5">{guide.subtitle}</p>
                      </div>
                      <button
                        onClick={() => handleCopy(guide.id, guide.code)}
                        className="h-[28px] px-3 rounded bg-[#161922] hover:bg-[#1C202B] border border-[#2A2F40] text-[11px] text-[#ECEEF2] flex items-center gap-1.5 cursor-pointer shrink-0"
                      >
                        {copiedId === guide.id ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                            <span>Kopyalandı</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5 text-[#9499A6]" />
                            <span>Kodu Kopyala</span>
                          </>
                        )}
                      </button>
                    </div>

                    <pre className="p-4 text-[11px] font-mono text-[#ECEEF2] bg-[#0A0B0E] overflow-x-auto leading-relaxed select-text">
                      {guide.code}
                    </pre>

                    <div className="px-4 py-2.5 bg-[#0F1117] border-t border-[#1E2230] space-y-1">
                      {guide.notes.map((note, idx) => (
                        <div
                          key={idx}
                          className="text-[11px] text-[#9499A6] flex items-center gap-2"
                        >
                          <span className="w-1 h-1 rounded-full bg-[#3B82F6]" />
                          <span>{note}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Protocol & Server Settings Tab */}
          {activeNav === 'settings' && (
            <div className="flex-1 overflow-y-auto p-6 max-w-2xl space-y-5">
              <div className="border-b border-[#1E2230] pb-3">
                <h1 className="text-[15px] font-semibold text-[#ECEEF2]">
                  TUS Parçalı Yükleme, Paralel Range İndirme ve SHA-512 Ayarları
                </h1>
                <p className="text-[12px] text-[#9499A6] mt-0.5">
                  Linux FileBrowser sunucunuzun adresini, parça boyutunu ve paralel HTTP 206 Range kanal sayısını yapılandırın.
                </p>
              </div>

              <div className="space-y-4 text-[12px]">
                <div>
                  <label className="block text-[#9499A6] mb-1">
                    FileBrowser Sunucu Adresi (HTTP / HTTPS)
                  </label>
                  <input
                    type="text"
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                    className="w-full h-[32px] px-3 rounded bg-[#161922] border border-[#2A2F40] font-mono text-[#ECEEF2]"
                  />
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[#9499A6] mb-1">Sunucu Hedef Klasörü</label>
                    <input
                      type="text"
                      value={targetFolder}
                      onChange={(e) => setTargetFolder(e.target.value)}
                      className="w-full h-[32px] px-3 rounded bg-[#161922] border border-[#2A2F40] font-mono text-[#ECEEF2]"
                    />
                  </div>
                  <div>
                    <label className="block text-[#9499A6] mb-1">Parça Boyutu (MB)</label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={chunkSizeMb}
                      onChange={(e) => setChunkSizeMb(Number(e.target.value) || 10)}
                      className="w-full h-[32px] px-3 rounded bg-[#161922] border border-[#2A2F40] font-mono text-[#ECEEF2]"
                    />
                  </div>
                  <div>
                    <label className="block text-[#9499A6] mb-1">
                      Paralel Range Kanalı (1-16)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={16}
                      value={downloadConcurrency}
                      onChange={(e) =>
                        setDownloadConcurrency(
                          Math.min(16, Math.max(1, Number(e.target.value) || 6))
                        )
                      }
                      className="w-full h-[32px] px-3 rounded bg-[#161922] border border-[#2A2F40] font-mono text-[#ECEEF2]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[#9499A6] mb-1">
                    FileBrowser X-Auth JWT Token (veya otomatik giriş kullanın)
                  </label>
                  <input
                    type="text"
                    value={jwtToken}
                    onChange={(e) => setJwtToken(e.target.value)}
                    placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                    className="w-full h-[32px] px-3 rounded bg-[#161922] border border-[#2A2F40] font-mono text-[#ECEEF2]"
                  />
                </div>

                <div className="p-3 rounded bg-[#0F1117] border border-[#1E2230] flex items-center justify-between">
                  <div>
                    <div className="font-medium text-[#ECEEF2]">
                      Aktarım Sonunda Sunucudan Tam Dosya SHA-512 Sorgula (?checksum=sha512)
                    </div>
                    <div className="text-[11px] text-[#636875] mt-0.5">
                      Hem TUS yüklemelerinde hem de Paralel HTTP 206 Range indirmelerinde sunucu SHA-512 özetiyle karşılaştırır.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={verifyFullFileAtEnd}
                    onChange={(e) => setVerifyFullFileAtEnd(e.target.checked)}
                    className="w-4 h-4 accent-[#3B82F6] cursor-pointer"
                  />
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Bottom 24px Status Bar */}
      <footer className="h-[24px] shrink-0 bg-[#0F1117] border-t border-[#1E2230] px-3 flex items-center justify-between text-[11px] text-[#636875] font-mono">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span
              className={`w-2 h-2 rounded-full ${
                activeUploadsCount + activeDownloadsCount > 0
                  ? 'bg-[#3B82F6] animate-pulse'
                  : 'bg-emerald-500'
              }`}
            />
            <span className="text-[#9499A6]">
              {activeUploadsCount + activeDownloadsCount > 0
                ? `${activeUploadsCount} Upload / ${activeDownloadsCount} Range Download (${formatBytes(totalSpeedBytesPerSec)}/sn)`
                : `TUS v1.0.0 & HTTP 206 Range (${downloadConcurrency}x) Hazır`}
            </span>
          </span>
          <span>Algoritma: SHA-512 (64-bit WASM)</span>
          <span>Parmak İzi: 3ms Örneklem</span>
        </div>

        <div className="flex items-center gap-4">
          <span>Boşluk: Duraklat/Devam Et</span>
          <span>Ctrl+K: Komut Paleti</span>
        </div>
      </footer>
    </div>
  );
}
export default App;
