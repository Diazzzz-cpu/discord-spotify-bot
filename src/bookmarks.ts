import fs from 'node:fs/promises';
import path from 'node:path';

export const SUPREME_MASTER_ID = '458543563970576386';

export interface Bookmark {
  name: string;
  url: string;
  createdBy: string;
  createdById?: string;
  createdAt: number;
}

interface MasterStateData {
  locked: boolean;
  banishedIds: string[];
  coMasterIds?: string[];
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const BOOKMARKS_FILE = path.join(DATA_DIR, 'bookmarks.json');
const MASTER_STATE_FILE = path.join(DATA_DIR, 'master-state.json');

// O(1) in-memory map: key = lowercase name
const bookmarksCache = new Map<string, Bookmark>();

// O(1) in-memory state for Lock, Banish List, & Pipeline Punch (Co-Masters)
let masterLocked = false;
const banishedSet = new Set<string>();
const coMasterSet = new Set<string>();

let initialized = false;

export async function initBookmarks(): Promise<void> {
  if (initialized) return;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {
    // ignore
  }

  try {
    const raw = await fs.readFile(BOOKMARKS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Bookmark[];
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item?.name && item?.url) {
          bookmarksCache.set(item.name.toLowerCase(), item);
        }
      }
    }
  } catch {
    // File doesn't exist yet; will be created on first save
  }

  try {
    const rawState = await fs.readFile(MASTER_STATE_FILE, 'utf-8');
    const parsedState = JSON.parse(rawState) as MasterStateData;
    masterLocked = Boolean(parsedState?.locked);
    if (Array.isArray(parsedState?.banishedIds)) {
      for (const id of parsedState.banishedIds) {
        if (id) banishedSet.add(String(id));
      }
    }
    if (Array.isArray(parsedState?.coMasterIds)) {
      for (const id of parsedState.coMasterIds) {
        if (id && id !== SUPREME_MASTER_ID) coMasterSet.add(String(id));
      }
    }
  } catch {
    // File doesn't exist yet
  }

  initialized = true;
}

async function persistBookmarks(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const data = Array.from(bookmarksCache.values());
    await fs.writeFile(BOOKMARKS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Bookmarks] Failed to persist bookmarks to disk:', err);
  }
}

async function persistMasterState(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const data: MasterStateData = {
      locked: masterLocked,
      banishedIds: Array.from(banishedSet),
      coMasterIds: Array.from(coMasterSet),
    };
    await fs.writeFile(MASTER_STATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[MasterState] Failed to persist master state to disk:', err);
  }
}

export function getBookmark(name: string): Bookmark | undefined {
  return bookmarksCache.get(name.trim().toLowerCase());
}

export function listBookmarks(): Bookmark[] {
  return Array.from(bookmarksCache.values());
}

export async function saveBookmark(
  name: string,
  url: string,
  createdBy: string,
  createdById?: string
): Promise<Bookmark> {
  const cleanName = name.trim();
  const key = cleanName.toLowerCase();
  const entry: Bookmark = {
    name: cleanName,
    url: url.trim(),
    createdBy,
    createdById,
    createdAt: Date.now(),
  };
  bookmarksCache.set(key, entry);
  persistBookmarks();
  return entry;
}

export async function removeBookmark(name: string): Promise<boolean> {
  const key = name.trim().toLowerCase();
  const deleted = bookmarksCache.delete(key);
  if (deleted) {
    persistBookmarks();
  }
  return deleted;
}

// ── Flavor Hierarchy Helpers (2 = Zero Ultra, 1 = Pipeline Punch, 0 = Original) ──

export function isSupremeMaster(userId: string | undefined): boolean {
  return userId === SUPREME_MASTER_ID;
}

export function isCoMaster(userId: string | undefined): boolean {
  return Boolean(userId && coMasterSet.has(userId));
}

export function isAnyMaster(userId: string | undefined): boolean {
  return isSupremeMaster(userId) || isCoMaster(userId);
}

export function getMasterRank(userId: string | undefined): number {
  if (!userId) return 0;
  if (userId === SUPREME_MASTER_ID) return 2;
  if (coMasterSet.has(userId)) return 1;
  return 0;
}

export function getFlavorName(rank: number): string {
  if (rank === 2) return '🤍 Zero Ultra';
  if (rank === 1) return '🌸 Pipeline Punch';
  return '🟢 Original';
}

export function addCoMaster(userId: string): void {
  if (userId === SUPREME_MASTER_ID) return;
  banishedSet.delete(userId);
  coMasterSet.add(userId);
  persistMasterState();
}

export function removeCoMaster(userId: string): boolean {
  const removed = coMasterSet.delete(userId);
  if (removed) {
    persistMasterState();
  }
  return removed;
}

export function getCoMasters(): string[] {
  return Array.from(coMasterSet);
}

export function isMasterModeLocked(): boolean {
  return masterLocked;
}

export function setMasterModeLocked(locked: boolean): void {
  masterLocked = locked;
  persistMasterState();
}

export function isUserBanished(userId: string): boolean {
  return banishedSet.has(userId);
}

export function banishUser(userId: string): void {
  banishedSet.add(userId);
  persistMasterState();
}

export function forgiveUser(userId: string): void {
  banishedSet.delete(userId);
  persistMasterState();
}

export function getBanishedUsers(): string[] {
  return Array.from(banishedSet);
}
