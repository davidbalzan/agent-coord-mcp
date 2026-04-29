import { promises as fs, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";

export const ROOT =
  process.env.AGENT_COORD_DIR ??
  process.env.CLAUDE_COORD_DIR ??
  path.join(homedir(), "agent-coord");
export const AGENTS_FILE = path.join(ROOT, "agents.json");
export const ROOM_FILE = path.join(ROOT, "room.jsonl");
export const STATUS_FILE = path.join(ROOT, "status.jsonl");
export const INBOX_DIR = path.join(ROOT, "inbox");
export const CURSOR_DIR = path.join(ROOT, "cursors");

export function ensureDirs(): void {
  for (const d of [ROOT, INBOX_DIR, CURSOR_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  for (const f of [ROOM_FILE, STATUS_FILE]) {
    if (!existsSync(f)) mkdirSync(path.dirname(f), { recursive: true });
  }
}

async function ensureFile(file: string): Promise<void> {
  if (!existsSync(file)) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "", "utf8");
  }
}

async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  await ensureFile(file);
  const release = await lockfile.lock(file, {
    retries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
    stale: 5000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function appendJsonl(file: string, entry: unknown): Promise<void> {
  await withLock(file, async () => {
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(file, line, "utf8");
  });
}

export async function readJsonl<T = unknown>(file: string): Promise<T[]> {
  if (!existsSync(file)) return [];
  const raw = await fs.readFile(file, "utf8");
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  if (!existsSync(file)) return fallback;
  try {
    const raw = await fs.readFile(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await withLock(file, async () => {
    await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
  });
}

async function readJsonNoLock<T>(file: string, fallback: T): Promise<T> {
  if (!existsSync(file)) return fallback;
  try {
    const raw = await fs.readFile(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function updateJson<T>(file: string, fallback: T, mutate: (current: T) => T | Promise<T>): Promise<T> {
  return withLock(file, async () => {
    const current = await readJsonNoLock(file, fallback);
    const next = await mutate(current);
    await fs.writeFile(file, JSON.stringify(next, null, 2), "utf8");
    return next;
  });
}

export function inboxFile(agentId: string): string {
  return path.join(INBOX_DIR, `${sanitize(agentId)}.jsonl`);
}

export function cursorFile(agentId: string): string {
  return path.join(CURSOR_DIR, `${sanitize(agentId)}.json`);
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function rewriteJsonl<T>(
  file: string,
  filter: (entry: T) => boolean
): Promise<{ kept: number; removed: number }> {
  if (!existsSync(file)) return { kept: 0, removed: 0 };
  return withLock(file, async () => {
    const raw = await fs.readFile(file, "utf8");
    let kept = 0;
    let removed = 0;
    const out: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as T;
        if (filter(entry)) {
          out.push(line);
          kept++;
        } else {
          removed++;
        }
      } catch {
        removed++;
      }
    }
    await fs.writeFile(file, out.length ? out.join("\n") + "\n" : "", "utf8");
    return { kept, removed };
  });
}

export async function deleteFile(file: string): Promise<boolean> {
  if (!existsSync(file)) return false;
  await fs.unlink(file);
  return true;
}

export async function listInboxFiles(): Promise<string[]> {
  if (!existsSync(INBOX_DIR)) return [];
  const names = await fs.readdir(INBOX_DIR);
  return names.filter((n) => n.endsWith(".jsonl"));
}

export async function fileSize(file: string): Promise<number> {
  if (!existsSync(file)) return 0;
  const st = await fs.stat(file);
  return st.size;
}
