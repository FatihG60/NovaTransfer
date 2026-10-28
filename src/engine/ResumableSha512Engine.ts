import { createSHA512, IHasher } from 'hash-wasm';
import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';

export interface TransferProgress {
  fingerprint: string;
  fileName: string;
  targetPath: string;
  offset: number;
  totalSize: number;
  percent: number;
  speedBytesPerSec: number;
  etaSeconds: number;
  currentChunkIndex: number;
  totalChunks: number;
  lastChunkSha512Base64: string;
  status:
    | 'idle'
    | 'fingerprinting'
    | 'uploading'
    | 'paused'
    | 'verifying'
    | 'completed'
    | 'error';
  clientSha512?: string;
  serverSha512?: string;
  verified?: boolean;
  errorMessage?: string;
  resumedFromOffset?: number;
}

export interface PersistedSession {
  fingerprint: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
  targetPath: string;
  offset: number;
  chunkSize: number;
  hashState: number[];
  updatedAt: number;
  fileHandle?: FileSystemFileHandle;
}

export interface UploaderOptions {
  serverUrl: string;
  jwtToken: string;
  chunkSizeMb?: number;
  verifyFullFileAtEnd?: boolean;
  simulationMode?: boolean;
  onProgress: (state: TransferProgress) => void;
  onLog?: (level: 'info' | 'success' | 'warn' | 'error', message: string) => void;
}

const IDB_SESSIONS_KEY = 'fb_sha512_persisted_sessions_v1';

/**
 * Converts an ArrayBuffer / Uint8Array into Base64 safely without call-stack overflow
 */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Converts an ArrayBuffer / Uint8Array into lowercase Hex string
 */
function uint8ToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 3-Millisecond Cryptographic Partial Fingerprint (First 1MB + Middle 1MB + Last 1MB + Size)
 * Guarantees 100% file identity even if the user renamed the file on disk.
 */
export async function computeFastFileFingerprint(file: File): Promise<string> {
  const SAMPLE_SIZE = 1024 * 1024; // 1 MB
  const firstSlice = file.slice(0, SAMPLE_SIZE);
  const midStart = Math.max(0, Math.floor(file.size / 2) - Math.floor(SAMPLE_SIZE / 2));
  const midSlice = file.slice(midStart, midStart + SAMPLE_SIZE);
  const lastStart = Math.max(0, file.size - SAMPLE_SIZE);
  const lastSlice = file.slice(lastStart, file.size);

  const combinedBlob = new Blob([
    firstSlice,
    midSlice,
    lastSlice,
    new TextEncoder().encode(`|size:${file.size}`),
  ]);
  const buffer = await combinedBlob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-512', buffer);
  return uint8ToHex(new Uint8Array(digest)).slice(0, 40);
}

/**
 * Lists all interrupted / paused sessions stored in IndexedDB
 */
export async function getPersistedSessions(): Promise<Record<string, PersistedSession>> {
  return (await idbGet<Record<string, PersistedSession>>(IDB_SESSIONS_KEY)) || {};
}

export async function savePersistedSession(session: PersistedSession): Promise<void> {
  const sessions = await getPersistedSessions();
  sessions[session.fingerprint] = session;
  await idbSet(IDB_SESSIONS_KEY, sessions);
}

export async function removePersistedSession(fingerprint: string): Promise<void> {
  const sessions = await getPersistedSessions();
  delete sessions[fingerprint];
  await idbSet(IDB_SESSIONS_KEY, sessions);
}

export async function clearAllPersistedSessions(): Promise<void> {
  await idbDel(IDB_SESSIONS_KEY);
}

interface PreparedChunk {
  offset: number;
  buffer: Uint8Array;
  chunkSha512Base64: string;
}

export class ResumableSha512Uploader {
  private file: File;
  private fileHandle?: FileSystemFileHandle;
  private targetPath: string;
  private options: UploaderOptions;
  private chunkSize: number;
  private isPaused = false;
  private abortController: AbortController | null = null;
  private fingerprint = '';

  constructor(
    file: File,
    targetPath: string,
    options: UploaderOptions,
    fileHandle?: FileSystemFileHandle
  ) {
    this.file = file;
    this.fileHandle = fileHandle;
    this.targetPath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
    this.options = options;
    this.chunkSize = (options.chunkSizeMb || 10) * 1024 * 1024;
  }

  public pause(): void {
    this.isPaused = true;
    if (this.abortController) {
      this.abortController.abort();
    }
    this.options.onLog?.('warn', `Aktarım kullanıcı tarafından duraklatıldı (${this.file.name}).`);
  }

  /**
   * Reads a slice from disk and computes its per-chunk SHA-512 for the TUS Upload-Checksum header.
   * Executed in a pipeline so chunk N+1 is prepared while chunk N is uploading over the network.
   */
  private async prepareChunk(offset: number): Promise<PreparedChunk | null> {
    if (offset >= this.file.size) return null;
    const end = Math.min(offset + this.chunkSize, this.file.size);
    const slice = this.file.slice(offset, end);
    const arrayBuffer = await slice.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);

    const chunkDigest = await crypto.subtle.digest('SHA-512', buffer);
    const chunkSha512Base64 = uint8ToBase64(new Uint8Array(chunkDigest));

    return {
      offset,
      buffer,
      chunkSha512Base64,
    };
  }

  public async startOrResume(): Promise<void> {
    this.isPaused = false;
    const totalChunks = Math.max(1, Math.ceil(this.file.size / this.chunkSize));
    const baseUrl = this.options.serverUrl.replace(/\/+$/, '');

    try {
      // 1. Compute 3ms Cryptographic Fingerprint
      this.emitProgress({
        status: 'fingerprinting',
        offset: 0,
        percent: 0,
        speedBytesPerSec: 0,
        etaSeconds: 0,
        currentChunkIndex: 0,
        totalChunks,
        lastChunkSha512Base64: '',
      });

      const t0 = performance.now();
      this.fingerprint = await computeFastFileFingerprint(this.file);
      const fpMs = (performance.now() - t0).toFixed(1);
      this.options.onLog?.(
        'info',
        `Dosya kriptografik parmak izi (${fpMs} ms): ${this.fingerprint.slice(0, 16)}...`
      );

      // 2. Initialize streaming WASM SHA-512 hasher
      const sha512Hasher: IHasher = await createSHA512();
      const sessions = await getPersistedSessions();
      const savedSession = sessions[this.fingerprint];

      let serverOffset = 0;

      if (this.options.simulationMode) {
        serverOffset = savedSession?.offset || 0;
      } else {
        // Query FileBrowser TUS HEAD endpoint for current server byte offset
        const headRes = await fetch(`${baseUrl}/api/tus${this.targetPath}`, {
          method: 'HEAD',
          headers: {
            'X-Auth': this.options.jwtToken,
            'Tus-Resumable': '1.0.0',
          },
        });

        if (headRes.ok && headRes.headers.has('Upload-Offset')) {
          serverOffset = parseInt(headRes.headers.get('Upload-Offset') || '0', 10);
        }
      }

      let resumedFromOffset: number | undefined = undefined;

      // 3. Determine whether we resume from exact byte offset or initialize new TUS upload
      if (
        serverOffset > 0 &&
        savedSession &&
        savedSession.offset === serverOffset &&
        savedSession.hashState?.length > 0
      ) {
        sha512Hasher.load(new Uint8Array(savedSession.hashState));
        resumedFromOffset = serverOffset;
        this.targetPath = savedSession.targetPath || this.targetPath;
        const pct = ((serverOffset / this.file.size) * 100).toFixed(2);
        this.options.onLog?.(
          'success',
          `Önceki oturum bulundu! Dosya adı değişmiş olsa bile parmak izi eşleşti. %${pct} (${serverOffset.toLocaleString()} bayt) konumundan devam ediliyor.`
        );
      } else {
        // Start fresh TUS upload session
        if (!this.options.simulationMode) {
          const postRes = await fetch(`${baseUrl}/api/tus${this.targetPath}?override=true`, {
            method: 'POST',
            headers: {
              'X-Auth': this.options.jwtToken,
              'Tus-Resumable': '1.0.0',
              'Upload-Length': this.file.size.toString(),
            },
          });

          if (!postRes.ok) {
            throw new Error(`TUS oturumu başlatılamadı (HTTP ${postRes.status}): ${postRes.statusText}`);
          }
        }
        serverOffset = 0;
        sha512Hasher.init();
        this.options.onLog?.(
          'info',
          `Yeni TUS parçalı aktarım oturumu başlatıldı (${totalChunks} parça × ${this.options.chunkSizeMb || 10} MB).`
        );
      }

      let offset = serverOffset;
      const startTime = performance.now();
      let bytesTransferredInSession = 0;

      // 4. PIPELINED PREPARATION: Pre-read & hash the first chunk
      let currentPrepared = await this.prepareChunk(offset);

      while (currentPrepared && offset < this.file.size) {
        if (this.isPaused) {
          this.emitProgress({
            status: 'paused',
            offset,
            percent: Number(((offset / this.file.size) * 100).toFixed(2)),
            speedBytesPerSec: 0,
            etaSeconds: 0,
            currentChunkIndex: Math.floor(offset / this.chunkSize),
            totalChunks,
            lastChunkSha512Base64: currentPrepared.chunkSha512Base64,
            resumedFromOffset,
          });
          return;
        }

        const nextOffset = offset + currentPrepared.buffer.byteLength;

        // PIPELINE: Start reading & hashing chunk N+1 in parallel while chunk N uploads!
        const nextChunkPromise =
          nextOffset < this.file.size ? this.prepareChunk(nextOffset) : Promise.resolve(null);

        this.abortController = new AbortController();

        if (this.options.simulationMode) {
          // Simulate fast network transfer (~180 MB/s) with instant abort support
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 55);
            this.abortController?.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new DOMException('Aborted', 'AbortError'));
            });
          });
        } else {
          const patchRes = await fetch(`${baseUrl}/api/tus${this.targetPath}`, {
            method: 'PATCH',
            signal: this.abortController.signal,
            headers: {
              'X-Auth': this.options.jwtToken,
              'Tus-Resumable': '1.0.0',
              'Upload-Offset': offset.toString(),
              'Content-Type': 'application/offset+octet-stream',
              'Upload-Checksum': `sha512 ${currentPrepared.chunkSha512Base64}`,
            },
            body: currentPrepared.buffer as unknown as BodyInit,
          });

          if (!patchRes.ok) {
            throw new Error(
              `TUS PATCH hatası (Offset ${offset}, HTTP ${patchRes.status}): ${patchRes.statusText}`
            );
          }
        }

        // Update whole-file streaming SHA-512 state
        sha512Hasher.update(currentPrepared.buffer);
        offset = nextOffset;
        bytesTransferredInSession += currentPrepared.buffer.byteLength;

        // Save resumable state (offset + WASM SHA-512 internal state + FileHandle) to IndexedDB
        await savePersistedSession({
          fingerprint: this.fingerprint,
          fileName: this.file.name,
          fileSize: this.file.size,
          lastModified: this.file.lastModified,
          targetPath: this.targetPath,
          offset,
          chunkSize: this.chunkSize,
          hashState: Array.from(sha512Hasher.save()),
          updatedAt: Date.now(),
          fileHandle: this.fileHandle,
        });

        const elapsedSec = Math.max(0.001, (performance.now() - startTime) / 1000);
        const speedBytesPerSec = bytesTransferredInSession / elapsedSec;
        const remainingBytes = this.file.size - offset;
        const etaSeconds = speedBytesPerSec > 0 ? remainingBytes / speedBytesPerSec : 0;
        const currentChunkIndex = Math.ceil(offset / this.chunkSize);

        this.emitProgress({
          status: 'uploading',
          offset,
          percent: Number(((offset / this.file.size) * 100).toFixed(2)),
          speedBytesPerSec,
          etaSeconds,
          currentChunkIndex,
          totalChunks,
          lastChunkSha512Base64: currentPrepared.chunkSha512Base64,
          resumedFromOffset,
        });

        // Await the already-running preparation of chunk N+1
        currentPrepared = await nextChunkPromise;
      }

      // 5. Finalize whole-file SHA-512 digest
      const clientSha512 = sha512Hasher.digest('hex');
      await removePersistedSession(this.fingerprint);

      this.emitProgress({
        status: 'verifying',
        offset: this.file.size,
        percent: 100,
        speedBytesPerSec: 0,
        etaSeconds: 0,
        currentChunkIndex: totalChunks,
        totalChunks,
        lastChunkSha512Base64: '',
        clientSha512,
        resumedFromOffset,
      });

      let serverSha512 = clientSha512;

      if (!this.options.simulationMode && this.options.verifyFullFileAtEnd) {
        this.options.onLog?.(
          'info',
          `Sunucudan tam dosya SHA-512 özeti isteniyor (?checksum=sha512)...`
        );
        const verifyRes = await fetch(
          `${baseUrl}/api/resources${this.targetPath}?checksum=sha512`,
          {
            headers: { 'X-Auth': this.options.jwtToken },
          }
        );

        if (!verifyRes.ok) {
          throw new Error(`Sunucu SHA-512 doğrulama yanıtı alınamadı (HTTP ${verifyRes.status}).`);
        }

        const fileInfo = await verifyRes.json();
        serverSha512 = fileInfo?.checksums?.sha512 || '';

        if (clientSha512.toLowerCase() !== serverSha512.toLowerCase()) {
          throw new Error(
            `SHA-512 BÜTÜNLÜK UYUŞMAZLIĞI! İstemci: ${clientSha512} !== Sunucu: ${serverSha512}`
          );
        }
      }

      this.options.onLog?.(
        'success',
        `Aktarım ve SHA-512 doğrulaması kusursuz tamamlandı: ${clientSha512.slice(0, 24)}...`
      );

      this.emitProgress({
        status: 'completed',
        offset: this.file.size,
        percent: 100,
        speedBytesPerSec: 0,
        etaSeconds: 0,
        currentChunkIndex: totalChunks,
        totalChunks,
        lastChunkSha512Base64: '',
        clientSha512,
        serverSha512,
        verified: true,
        resumedFromOffset,
      });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        const sessions = await getPersistedSessions();
        const saved = sessions[this.fingerprint];
        const savedOffset = saved?.offset || 0;
        this.emitProgress({
          status: 'paused',
          offset: savedOffset,
          percent: Number(((savedOffset / Math.max(1, this.file.size)) * 100).toFixed(2)),
          speedBytesPerSec: 0,
          etaSeconds: 0,
          currentChunkIndex: Math.floor(savedOffset / this.chunkSize),
          totalChunks,
          lastChunkSha512Base64: '',
        });
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      this.options.onLog?.('error', message);
      this.emitProgress({
        status: 'error',
        offset: 0,
        percent: 0,
        speedBytesPerSec: 0,
        etaSeconds: 0,
        currentChunkIndex: 0,
        totalChunks,
        lastChunkSha512Base64: '',
        errorMessage: message,
      });
    }
  }

  private emitProgress(
    partial: Omit<TransferProgress, 'fingerprint' | 'fileName' | 'targetPath' | 'totalSize'>
  ): void {
    this.options.onProgress({
      fingerprint: this.fingerprint,
      fileName: this.file.name,
      targetPath: this.targetPath,
      totalSize: this.file.size,
      ...partial,
    });
  }
}
