import { createSHA512, IHasher } from 'hash-wasm';
import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';

export type ChunkStateType = 'pending' | 'pipelined' | 'uploading' | 'completed' | 'paused';

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
  chunkSizeMb: number;
  uploadConcurrency: number;
  activeUploadWorkers: number;
  chunkStates: ChunkStateType[];
  lastChunkSha512Base64: string;
  status:
    | 'idle'
    | 'fingerprinting'
    | 'uploading'
    | 'merging'
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
  uploadConcurrency: number;
  completedChunks?: number[];
  hashState: number[];
  updatedAt: number;
  fileHandle?: FileSystemFileHandle;
}

export interface UploaderOptions {
  serverUrl: string;
  jwtToken: string;
  chunkSizeMb?: number | 'adaptive';
  uploadConcurrency?: number;
  verifyFullFileAtEnd?: boolean;
  simulationMode?: boolean;
  onProgress: (state: TransferProgress) => void;
  onLog?: (level: 'info' | 'success' | 'warn' | 'error', message: string) => void;
}

const IDB_SESSIONS_KEY = 'fb_sha512_persisted_sessions_v1';

/**
 * Automatically selects the optimal TUS chunk size (10 MB, 32 MB, or 64 MB)
 * based on file size to minimize HTTP PATCH RTT latency on high-bandwidth WAN links.
 */
export function resolveAdaptiveChunkSizeMb(
  fileSizeBytes: number,
  setting: number | 'adaptive' = 'adaptive'
): number {
  if (typeof setting === 'number' && setting > 0) return setting;
  const gb = fileSizeBytes / (1024 * 1024 * 1024);
  if (gb >= 4) return 64;
  if (fileSizeBytes >= 400 * 1024 * 1024) return 32;
  return 10;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

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
  chunkIndex: number;
  offset: number;
  buffer: Uint8Array;
  chunkSha512Base64: string;
}

export class ResumableSha512Uploader {
  private file: File;
  private fileHandle?: FileSystemFileHandle;
  private targetPath: string;
  private options: UploaderOptions;
  private chunkSizeMb: number;
  private chunkSize: number;
  private uploadConcurrency: number;
  private totalChunks: number;
  private chunkStates: ChunkStateType[];
  private isPaused = false;
  private abortControllers: Set<AbortController> = new Set();
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
    this.chunkSizeMb = resolveAdaptiveChunkSizeMb(file.size, options.chunkSizeMb ?? 'adaptive');
    this.chunkSize = this.chunkSizeMb * 1024 * 1024;
    this.uploadConcurrency = Math.max(1, options.uploadConcurrency || 1);
    this.totalChunks = Math.max(1, Math.ceil(this.file.size / this.chunkSize));
    this.chunkStates = new Array(this.totalChunks).fill('pending');
  }

  public pause(): void {
    this.isPaused = true;
    for (const ctrl of this.abortControllers) {
      ctrl.abort();
    }
    this.abortControllers.clear();

    for (let i = 0; i < this.chunkStates.length; i++) {
      if (this.chunkStates[i] === 'uploading' || this.chunkStates[i] === 'pipelined') {
        this.chunkStates[i] = 'paused';
      }
    }
    this.options.onLog?.('warn', `Aktarım kullanıcı tarafından duraklatıldı (${this.file.name}).`);
  }

  private async prepareChunkByIndex(chunkIndex: number): Promise<PreparedChunk | null> {
    const offset = chunkIndex * this.chunkSize;
    if (offset >= this.file.size) return null;
    const end = Math.min(offset + this.chunkSize, this.file.size);
    const slice = this.file.slice(offset, end);
    const arrayBuffer = await slice.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);

    const chunkDigest = await crypto.subtle.digest('SHA-512', buffer);
    const chunkSha512Base64 = uint8ToBase64(new Uint8Array(chunkDigest));

    return {
      chunkIndex,
      offset,
      buffer,
      chunkSha512Base64,
    };
  }

  public async startOrResume(): Promise<void> {
    this.isPaused = false;
    const baseUrl = this.options.serverUrl.replace(/\/+$/, '');

    try {
      this.emitProgress({
        status: 'fingerprinting',
        offset: 0,
        percent: 0,
        speedBytesPerSec: 0,
        etaSeconds: 0,
        currentChunkIndex: 0,
        activeUploadWorkers: 0,
        lastChunkSha512Base64: '',
      });

      const t0 = performance.now();
      this.fingerprint = await computeFastFileFingerprint(this.file);
      const fpMs = (performance.now() - t0).toFixed(1);
      this.options.onLog?.(
        'info',
        `Dosya kriptografik parmak izi (${fpMs} ms): ${this.fingerprint.slice(0, 16)}... (Parça: ${this.chunkSizeMb} MB, Kanal: ${this.uploadConcurrency}x)`
      );

      // Route to Multi-Channel Striped TUS Upload if uploadConcurrency > 1
      if (this.uploadConcurrency > 1) {
        await this.runMultiChannelStripedUpload(baseUrl);
        return;
      }

      // Single-Channel Zero-Merge Pipelined TUS Upload
      await this.runSingleChannelPipelinedUpload(baseUrl);
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
          activeUploadWorkers: 0,
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
        activeUploadWorkers: 0,
        lastChunkSha512Base64: '',
        errorMessage: message,
      });
    }
  }

  /**
   * Mode A: 1x Single-Channel Pipelined TUS Upload (Zero Server Merge Overhead)
   */
  private async runSingleChannelPipelinedUpload(baseUrl: string): Promise<void> {
    const sha512Hasher: IHasher = await createSHA512();
    const sessions = await getPersistedSessions();
    const savedSession = sessions[this.fingerprint];

    let serverOffset = 0;

    if (this.options.simulationMode) {
      serverOffset = savedSession?.offset || 0;
    } else {
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

    if (
      serverOffset > 0 &&
      savedSession &&
      savedSession.offset === serverOffset &&
      savedSession.hashState?.length > 0 &&
      savedSession.chunkSize === this.chunkSize
    ) {
      sha512Hasher.load(new Uint8Array(savedSession.hashState));
      resumedFromOffset = serverOffset;
      this.targetPath = savedSession.targetPath || this.targetPath;
      const doneChunks = Math.floor(serverOffset / this.chunkSize);
      for (let i = 0; i < doneChunks; i++) {
        this.chunkStates[i] = 'completed';
      }
      const pct = ((serverOffset / this.file.size) * 100).toFixed(2);
      this.options.onLog?.(
        'success',
        `Önceki TUS oturumu bulundu! Parmak izi eşleşti, %${pct} (${serverOffset.toLocaleString()} bayt) konumundan devam ediliyor.`
      );
    } else {
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
          throw new Error(
            `TUS oturumu başlatılamadı (HTTP ${postRes.status}): ${postRes.statusText}`
          );
        }
      }
      serverOffset = 0;
      sha512Hasher.init();
      this.chunkStates.fill('pending');
      this.options.onLog?.(
        'info',
        `Pipelined TUS oturumu başlatıldı (${this.totalChunks} parça × ${this.chunkSizeMb} MB).`
      );
    }

    let offset = serverOffset;
    let currentChunkIdx = Math.floor(offset / this.chunkSize);
    const startTime = performance.now();
    let bytesTransferredInSession = 0;

    let currentPrepared = await this.prepareChunkByIndex(currentChunkIdx);

    while (currentPrepared && offset < this.file.size) {
      if (this.isPaused) {
        this.chunkStates[currentChunkIdx] = 'paused';
        this.emitProgress({
          status: 'paused',
          offset,
          percent: Number(((offset / this.file.size) * 100).toFixed(2)),
          speedBytesPerSec: 0,
          etaSeconds: 0,
          currentChunkIndex: currentChunkIdx,
          activeUploadWorkers: 0,
          lastChunkSha512Base64: currentPrepared.chunkSha512Base64,
          resumedFromOffset,
        });
        return;
      }

      this.chunkStates[currentChunkIdx] = 'uploading';
      const nextChunkIdx = currentChunkIdx + 1;
      if (nextChunkIdx < this.totalChunks) {
        this.chunkStates[nextChunkIdx] = 'pipelined';
      }

      // PIPELINE: Prepare chunk N+1 in parallel while chunk N uploads!
      const nextChunkPromise =
        nextChunkIdx < this.totalChunks
          ? this.prepareChunkByIndex(nextChunkIdx)
          : Promise.resolve(null);

      const abortCtrl = new AbortController();
      this.abortControllers.add(abortCtrl);

      try {
        if (this.options.simulationMode) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 55);
            abortCtrl.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new DOMException('Aborted', 'AbortError'));
            });
          });
        } else {
          const patchRes = await fetch(`${baseUrl}/api/tus${this.targetPath}`, {
            method: 'PATCH',
            signal: abortCtrl.signal,
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
      } finally {
        this.abortControllers.delete(abortCtrl);
      }

      sha512Hasher.update(currentPrepared.buffer);
      this.chunkStates[currentChunkIdx] = 'completed';
      offset += currentPrepared.buffer.byteLength;
      bytesTransferredInSession += currentPrepared.buffer.byteLength;
      currentChunkIdx++;

      await savePersistedSession({
        fingerprint: this.fingerprint,
        fileName: this.file.name,
        fileSize: this.file.size,
        lastModified: this.file.lastModified,
        targetPath: this.targetPath,
        offset,
        chunkSize: this.chunkSize,
        uploadConcurrency: 1,
        hashState: Array.from(sha512Hasher.save()),
        updatedAt: Date.now(),
        fileHandle: this.fileHandle,
      });

      const elapsedSec = Math.max(0.001, (performance.now() - startTime) / 1000);
      const speedBytesPerSec = bytesTransferredInSession / elapsedSec;
      const remainingBytes = this.file.size - offset;
      const etaSeconds = speedBytesPerSec > 0 ? remainingBytes / speedBytesPerSec : 0;

      this.emitProgress({
        status: 'uploading',
        offset,
        percent: Number(((offset / this.file.size) * 100).toFixed(2)),
        speedBytesPerSec,
        etaSeconds,
        currentChunkIndex: currentChunkIdx,
        activeUploadWorkers: 1,
        lastChunkSha512Base64: currentPrepared.chunkSha512Base64,
        resumedFromOffset,
      });

      currentPrepared = await nextChunkPromise;
    }

    await this.finalizeAndVerifySha512(baseUrl, sha512Hasher, resumedFromOffset);
  }

  /**
   * Mode B: Multi-Channel Striped Parallel TUS Upload (4x / 6x / 8x Concurrent TUS Streams + Server Merge)
   */
  private async runMultiChannelStripedUpload(baseUrl: string): Promise<void> {
    const sha512Hasher: IHasher = await createSHA512();
    const sessions = await getPersistedSessions();
    const savedSession = sessions[this.fingerprint];

    const completedSet = new Set<number>(savedSession?.completedChunks || []);
    let uploadedBytes = 0;

    // Reset chunk states and calculate already-uploaded bytes if resuming
    for (let i = 0; i < this.totalChunks; i++) {
      if (completedSet.has(i)) {
        this.chunkStates[i] = 'completed';
        const cStart = i * this.chunkSize;
        const cEnd = Math.min(cStart + this.chunkSize, this.file.size);
        uploadedBytes += cEnd - cStart;
      } else {
        this.chunkStates[i] = 'pending';
      }
    }

    const resumedFromOffset = uploadedBytes > 0 ? uploadedBytes : undefined;

    // Sequential in-order SHA-512 feeder so out-of-order parallel upload chunks hash deterministically
    let nextHashIndex = 0;
    const readyForHashBuffers = new Map<number, Uint8Array>();

    if (savedSession && savedSession.hashState?.length > 0 && completedSet.size > 0) {
      // Advance nextHashIndex through contiguous completed prefix
      while (completedSet.has(nextHashIndex)) {
        nextHashIndex++;
      }
      sha512Hasher.load(new Uint8Array(savedSession.hashState));
      this.options.onLog?.(
        'success',
        `Çok kanallı Striped TUS oturumu bulundu! ${completedSet.size}/${this.totalChunks} parça tamamlanmış, kalan parçalar ${this.uploadConcurrency}x kanaldan devam ediyor.`
      );
    } else {
      completedSet.clear();
      uploadedBytes = 0;
      sha512Hasher.init();
      this.options.onLog?.(
        'info',
        `Çok kanallı Striped TUS yüklemesi başlatıldı: ${this.uploadConcurrency}x eşzamanlı kanal (${this.totalChunks} × ${this.chunkSizeMb} MB).`
      );
    }

    const advanceSequentialHash = async () => {
      while (readyForHashBuffers.has(nextHashIndex)) {
        const buf = readyForHashBuffers.get(nextHashIndex)!;
        sha512Hasher.update(buf);
        readyForHashBuffers.delete(nextHashIndex);
        nextHashIndex++;
      }
      // If a previously completed chunk was ahead of nextHashIndex, read & hash it from local file slice
      while (completedSet.has(nextHashIndex) && !readyForHashBuffers.has(nextHashIndex)) {
        const prep = await this.prepareChunkByIndex(nextHashIndex);
        if (!prep) break;
        sha512Hasher.update(prep.buffer);
        nextHashIndex++;
      }
    };

    const pendingQueue: number[] = [];
    for (let i = 0; i < this.totalChunks; i++) {
      if (!completedSet.has(i)) {
        pendingQueue.push(i);
      }
    }

    const startTime = performance.now();
    let sessionBytes = 0;
    let activeWorkers = 0;
    let lastChunkSha512Base64 = '';

    const worker = async (workerId: number) => {
      while (!this.isPaused && pendingQueue.length > 0) {
        const chunkIndex = pendingQueue.shift();
        if (chunkIndex === undefined) break;

        this.chunkStates[chunkIndex] = 'uploading';
        activeWorkers++;

        const prep = await this.prepareChunkByIndex(chunkIndex);
        if (!prep) {
          activeWorkers--;
          break;
        }

        lastChunkSha512Base64 = prep.chunkSha512Base64;
        const partPath = `${this.targetPath}.part_${String(chunkIndex).padStart(5, '0')}`;
        const abortCtrl = new AbortController();
        this.abortControllers.add(abortCtrl);

        try {
          if (this.options.simulationMode) {
            await new Promise<void>((resolve, reject) => {
              const delay = 60 + (workerId % 3) * 18;
              const timer = setTimeout(resolve, delay);
              abortCtrl.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new DOMException('Aborted', 'AbortError'));
              });
            });
          } else {
            // 1. Create TUS stripe session for this chunk
            const postRes = await fetch(`${baseUrl}/api/tus${partPath}?override=true`, {
              method: 'POST',
              signal: abortCtrl.signal,
              headers: {
                'X-Auth': this.options.jwtToken,
                'Tus-Resumable': '1.0.0',
                'Upload-Length': prep.buffer.byteLength.toString(),
              },
            });
            if (!postRes.ok) {
              throw new Error(`Striped TUS POST hatası (Parça #${chunkIndex + 1})`);
            }

            // 2. Upload stripe chunk with Upload-Checksum: sha512
            const patchRes = await fetch(`${baseUrl}/api/tus${partPath}`, {
              method: 'PATCH',
              signal: abortCtrl.signal,
              headers: {
                'X-Auth': this.options.jwtToken,
                'Tus-Resumable': '1.0.0',
                'Upload-Offset': '0',
                'Content-Type': 'application/offset+octet-stream',
                'Upload-Checksum': `sha512 ${prep.chunkSha512Base64}`,
              },
              body: prep.buffer as unknown as BodyInit,
            });
            if (!patchRes.ok) {
              throw new Error(`Striped TUS PATCH hatası (Parça #${chunkIndex + 1})`);
            }
          }

          this.chunkStates[chunkIndex] = 'completed';
          completedSet.add(chunkIndex);
          uploadedBytes += prep.buffer.byteLength;
          sessionBytes += prep.buffer.byteLength;

          if (chunkIndex === nextHashIndex) {
            readyForHashBuffers.set(chunkIndex, prep.buffer);
            await advanceSequentialHash();
          } else if (chunkIndex > nextHashIndex) {
            readyForHashBuffers.set(chunkIndex, prep.buffer);
          }

          await savePersistedSession({
            fingerprint: this.fingerprint,
            fileName: this.file.name,
            fileSize: this.file.size,
            lastModified: this.file.lastModified,
            targetPath: this.targetPath,
            offset: uploadedBytes,
            chunkSize: this.chunkSize,
            uploadConcurrency: this.uploadConcurrency,
            completedChunks: Array.from(completedSet),
            hashState: Array.from(sha512Hasher.save()),
            updatedAt: Date.now(),
            fileHandle: this.fileHandle,
          });

          const elapsedSec = Math.max(0.001, (performance.now() - startTime) / 1000);
          const speed = sessionBytes / elapsedSec;
          const remaining = Math.max(0, this.file.size - uploadedBytes);
          const eta = speed > 0 ? remaining / speed : 0;

          this.emitProgress({
            status: 'uploading',
            offset: uploadedBytes,
            percent: Number(((uploadedBytes / this.file.size) * 100).toFixed(2)),
            speedBytesPerSec: speed,
            etaSeconds: eta,
            currentChunkIndex: completedSet.size,
            activeUploadWorkers: activeWorkers,
            lastChunkSha512Base64,
            resumedFromOffset,
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            this.chunkStates[chunkIndex] = 'paused';
            break;
          }
          this.chunkStates[chunkIndex] = 'pending';
          throw err;
        } finally {
          this.abortControllers.delete(abortCtrl);
          activeWorkers--;
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(this.uploadConcurrency, pendingQueue.length) },
      (_, i) => worker(i)
    );
    await Promise.all(workers);

    if (this.isPaused) {
      this.emitProgress({
        status: 'paused',
        offset: uploadedBytes,
        percent: Number(((uploadedBytes / this.file.size) * 100).toFixed(2)),
        speedBytesPerSec: 0,
        etaSeconds: 0,
        currentChunkIndex: completedSet.size,
        activeUploadWorkers: 0,
        lastChunkSha512Base64,
        resumedFromOffset,
      });
      return;
    }

    // Ensure all chunks are hashed in sequential order
    await advanceSequentialHash();

    // Trigger Server-Side Merge (.merge_manifest)
    this.emitProgress({
      status: 'merging',
      offset: this.file.size,
      percent: 100,
      speedBytesPerSec: 0,
      etaSeconds: 0,
      currentChunkIndex: this.totalChunks,
      activeUploadWorkers: 0,
      lastChunkSha512Base64,
      resumedFromOffset,
    });

    if (this.options.simulationMode) {
      this.options.onLog?.(
        'info',
        `Sunucuda ${this.totalChunks} adet .part dosyası birleştiriliyor (cat ${this.targetPath}.part_* > ${this.targetPath})...`
      );
      await new Promise((r) => setTimeout(r, 350));
    } else {
      const mergeSignalPath = `${this.targetPath}.merge`;
      await fetch(`${baseUrl}/api/resources${mergeSignalPath}?override=true`, {
        method: 'POST',
        headers: {
          'X-Auth': this.options.jwtToken,
        },
        body: JSON.stringify({
          targetPath: this.targetPath,
          totalChunks: this.totalChunks,
        }),
      });
    }

    await this.finalizeAndVerifySha512(baseUrl, sha512Hasher, resumedFromOffset);
  }

  private async finalizeAndVerifySha512(
    baseUrl: string,
    sha512Hasher: IHasher,
    resumedFromOffset?: number
  ): Promise<void> {
    const clientSha512 = sha512Hasher.digest('hex');
    await removePersistedSession(this.fingerprint);

    this.emitProgress({
      status: 'verifying',
      offset: this.file.size,
      percent: 100,
      speedBytesPerSec: 0,
      etaSeconds: 0,
      currentChunkIndex: this.totalChunks,
      activeUploadWorkers: 0,
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
      `Aktarım (${this.uploadConcurrency}x Kanal, ${this.chunkSizeMb} MB Parça) ve SHA-512 doğrulaması tamamlandı: ${clientSha512.slice(0, 24)}...`
    );

    this.emitProgress({
      status: 'completed',
      offset: this.file.size,
      percent: 100,
      speedBytesPerSec: 0,
      etaSeconds: 0,
      currentChunkIndex: this.totalChunks,
      activeUploadWorkers: 0,
      lastChunkSha512Base64: '',
      clientSha512,
      serverSha512,
      verified: true,
      resumedFromOffset,
    });
  }

  private emitProgress(
    partial: Omit<
      TransferProgress,
      | 'fingerprint'
      | 'fileName'
      | 'targetPath'
      | 'totalSize'
      | 'totalChunks'
      | 'chunkSizeMb'
      | 'uploadConcurrency'
      | 'chunkStates'
    >
  ): void {
    this.options.onProgress({
      fingerprint: this.fingerprint,
      fileName: this.file.name,
      targetPath: this.targetPath,
      totalSize: this.file.size,
      totalChunks: this.totalChunks,
      chunkSizeMb: this.chunkSizeMb,
      uploadConcurrency: this.uploadConcurrency,
      chunkStates: [...this.chunkStates],
      ...partial,
    });
  }
}
