// Where the candles and screenshots of trades live. The trade records stay in the shell's saved
// document (a few KB); this store holds the bulky part. The browser's IndexedDB is the default:
// it has room for hundreds of megabytes, works offline, and sends nothing anywhere.
import type { Candle } from './trade-window';

export type ShotKind = 'open' | 'close';

export interface EvidenceStore {
    putWindow(id: string, window: Candle[]): Promise<void>;
    getWindow(id: string): Promise<Candle[] | undefined>;
    putShot(id: string, kind: ShotKind, dataUrl: string): Promise<void>;
    getShot(id: string, kind: ShotKind): Promise<string | undefined>;
    removeShot(id: string, kind: ShotKind): Promise<void>;
    /** Drop the window and both screenshots of `id`. */
    remove(id: string): Promise<void>;
    clear(): Promise<void>;
}

const shotKey = (id: string, kind: ShotKind): string => `${id}:${kind}`;

/** A store in memory: the tests' double, and a fallback for hosts without IndexedDB. */
export class MemoryEvidenceStore implements EvidenceStore {
    private readonly windows = new Map<string, Candle[]>();
    private readonly shots = new Map<string, string>();

    async putWindow(id: string, window: Candle[]): Promise<void> {
        this.windows.set(id, window.map((c) => [...c] as Candle));
    }
    async getWindow(id: string): Promise<Candle[] | undefined> {
        return this.windows.get(id)?.map((c) => [...c] as Candle);
    }
    async putShot(id: string, kind: ShotKind, dataUrl: string): Promise<void> {
        this.shots.set(shotKey(id, kind), dataUrl);
    }
    async getShot(id: string, kind: ShotKind): Promise<string | undefined> {
        return this.shots.get(shotKey(id, kind));
    }
    async removeShot(id: string, kind: ShotKind): Promise<void> {
        this.shots.delete(shotKey(id, kind));
    }
    async remove(id: string): Promise<void> {
        this.windows.delete(id);
        this.shots.delete(shotKey(id, 'open'));
        this.shots.delete(shotKey(id, 'close'));
    }
    async clear(): Promise<void> {
        this.windows.clear();
        this.shots.clear();
    }
}

const DB_NAME = 'vela-trading-sim';
type StoreName = 'windows' | 'shots';

/** The IndexedDB store, or null where the browser has none. The database opens on first use. */
export function createIndexedDbStore(factory: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB): EvidenceStore | null {
    if (!factory) return null;
    let opened: Promise<IDBDatabase> | null = null;
    const open = (): Promise<IDBDatabase> =>
        (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
            const request = factory.open(DB_NAME, 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore('windows');
                request.result.createObjectStore('shots');
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
                opened = null;
                reject(request.error);
            };
        }));
    /** One transaction over `names`; resolves with the result of the last request `work` returns. */
    const run = async <T>(names: StoreName[], mode: IDBTransactionMode, work: (stores: Record<StoreName, IDBObjectStore>) => IDBRequest<T> | undefined): Promise<T | undefined> => {
        const db = await open();
        return new Promise<T | undefined>((resolve, reject) => {
            const tx = db.transaction(names, mode);
            const stores = Object.fromEntries(names.map((n) => [n, tx.objectStore(n)])) as Record<StoreName, IDBObjectStore>;
            const request = work(stores);
            tx.oncomplete = () => resolve(request?.result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    };
    return {
        putWindow: async (id, window) => void (await run(['windows'], 'readwrite', (s) => s.windows.put(window, id))),
        getWindow: async (id) => (await run<Candle[]>(['windows'], 'readonly', (s) => s.windows.get(id))) ?? undefined,
        putShot: async (id, kind, dataUrl) => void (await run(['shots'], 'readwrite', (s) => s.shots.put(dataUrl, shotKey(id, kind)))),
        getShot: async (id, kind) => (await run<string>(['shots'], 'readonly', (s) => s.shots.get(shotKey(id, kind)))) ?? undefined,
        removeShot: async (id, kind) => void (await run(['shots'], 'readwrite', (s) => s.shots.delete(shotKey(id, kind)))),
        remove: async (id) =>
            void (await run(['windows', 'shots'], 'readwrite', (s) => {
                s.windows.delete(id);
                s.shots.delete(shotKey(id, 'open'));
                return s.shots.delete(shotKey(id, 'close'));
            })),
        clear: async () =>
            void (await run(['windows', 'shots'], 'readwrite', (s) => {
                s.windows.clear();
                return s.shots.clear();
            })),
    };
}
