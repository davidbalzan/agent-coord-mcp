import { existsSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { WORK_DIR, workFile, readJson } from "../store.js";
import {
  type BoardRow,
  type DoneEntry,
  type QueueItem,
  type WorkDoc,
  boardRowsOf,
  doneEntriesOf,
  parseWorkDoc,
  queueItemsOf,
  renderWorkDoc,
  workDocIssues,
} from "../work.js";
import { loadScopes, ownsDocument } from "./scopes.js";
import { AGENTS_FILE } from "../store.js";
import type { AgentRegistry } from "./shared.js";

// ---------- work state as data (Phase 8 Task 5) ----------
//
// THE MARKDOWN IS AUTHORITATIVE. This store is a derived index: `import_work`
// fills it from the repo's documents, `export_work` renders those documents
// back byte-for-byte, and `list_work` falls back to reading the files directly
// when no import has happened. Delete ~/agent-coord/work/ and nothing is lost —
// the documents still stand alone, which is the property the round-trip test
// pins.
//
// NOT A WRITE GATE. `export_work` is a write PATH (it can rewrite the
// documents on request), not an interception point for anyone else's writes:
// agents still edit these files with ordinary file tools and this code never
// sees that. It reports the Task 4 scope verdict alongside a write so the
// caller can see whose document it is, and it never refuses on that basis —
// Task 4 shipped scopes as declaration + detection, and quietly upgrading that
// to enforcement here would break the promise it made.

// Which documents make up a project's work state, in precedence order: the
// split QUEUE/DONE layout wins, and the legacy single BACKLOG.md is read only
// when neither split file exists (already-documented behaviour).
export const QUEUE_DOC = "docs/QUEUE.md";
export const DONE_DOC = "docs/DONE.md";
export const BOARD_DOC = "docs/WORKSTREAMS.md";
export const LEGACY_DOC = "docs/BACKLOG.md";

export type WorkFileKind = "queue" | "done" | "board" | "legacy";

export type StoredDoc = {
  kind: WorkFileKind;
  // Repo-relative, exactly as it will be written back.
  path: string;
  doc: WorkDoc;
};

export type WorkState = {
  project: string;
  repo: string;
  importedAt: number;
  // `legacy` is present instead of queue/done when the split files are absent.
  docs: StoredDoc[];
};

function resolveDocs(repo: string): { kind: WorkFileKind; path: string }[] {
  const has = (rel: string) => existsSync(path.join(repo, rel));
  const out: { kind: WorkFileKind; path: string }[] = [];
  if (has(QUEUE_DOC) || has(DONE_DOC)) {
    if (has(QUEUE_DOC)) out.push({ kind: "queue", path: QUEUE_DOC });
    if (has(DONE_DOC)) out.push({ kind: "done", path: DONE_DOC });
  } else if (has(LEGACY_DOC)) {
    // One file carrying `## Queue` and `## Done` regions — same parser, since
    // the sections are what select the record kind, not the filename.
    out.push({ kind: "legacy", path: LEGACY_DOC });
  }
  if (has(BOARD_DOC)) out.push({ kind: "board", path: BOARD_DOC });
  return out;
}

async function loadState(project: string): Promise<WorkState | null> {
  return readJson<WorkState | null>(workFile(project), null);
}

async function saveState(state: WorkState): Promise<void> {
  await fsp.mkdir(WORK_DIR, { recursive: true });
  await fsp.writeFile(workFile(state.project), JSON.stringify(state, null, 2) + "\n", "utf8");
}

// ---------- import_work ----------

export const importWorkSchema = {
  project: z.string().min(1),
  // Repo root holding docs/. Defaults to the server's cwd.
  repo: z.string().optional(),
};

export async function importWorkTool(args: { project: string; repo?: string }) {
  const repo = args.repo ?? process.cwd();
  const found = resolveDocs(repo);
  if (!found.length) {
    return {
      ok: false as const,
      error: `no work documents under '${repo}' — expected ${QUEUE_DOC}/${DONE_DOC} or the legacy ${LEGACY_DOC}`,
    };
  }

  const docs: StoredDoc[] = [];
  for (const f of found) {
    const source = await fsp.readFile(path.join(repo, f.path), "utf8");
    docs.push({ kind: f.kind, path: f.path, doc: parseWorkDoc(source) });
  }
  const state: WorkState = { project: args.project, repo, importedAt: Date.now(), docs };
  await saveState(state);

  const allIssues = docs.flatMap((d) => workDocIssues(d.doc).map((issue) => `${d.path}: ${issue}`));
  return {
    ok: true as const,
    project: args.project,
    repo,
    file: workFile(args.project),
    imported: docs.map((d) => {
      const issues = workDocIssues(d.doc);
      return {
        path: d.path,
        kind: d.kind,
        queue: queueItemsOf(d.doc).length,
        done: doneEntriesOf(d.doc).length,
        board: boardRowsOf(d.doc).length,
        ...(issues.length ? { issues } : {}),
      };
    }),
    ...(allIssues.length
      ? {
          warning: `${allIssues.length} table row(s) were refused a record (wrong column count) and kept verbatim — the documents round-trip unchanged, but these rows are invisible to board consumers until fixed. See imported[].issues.`,
        }
      : {}),
    note: "the markdown remains authoritative — this store is a derived index",
  };
}

// ---------- list_work ----------

export const listWorkSchema = {
  project: z.string().min(1),
  kind: z.enum(["queue", "done", "board"]).optional(),
  priority: z.enum(["P1", "P2", "P3"]).optional(),
  // Include queue items already ticked off (default false).
  includeDone: z.boolean().optional(),
  repo: z.string().optional(),
};

export async function listWorkTool(args: {
  project: string;
  kind?: "queue" | "done" | "board";
  priority?: "P1" | "P2" | "P3";
  includeDone?: boolean;
  repo?: string;
}) {
  // No import yet (or the store was deleted) → read the documents directly.
  // This is the fallback that makes "the markdown stands alone" true in code
  // rather than in a comment.
  let state = await loadState(args.project);
  let source: "store" | "markdown" = "store";
  if (!state) {
    const imported = await importFromDisk(args.project, args.repo ?? process.cwd());
    if (!imported) {
      return { ok: false as const, error: `no work state for '${args.project}' and no documents under '${args.repo ?? process.cwd()}'` };
    }
    state = imported;
    source = "markdown";
  }

  const queue: QueueItem[] = [];
  const done: DoneEntry[] = [];
  const board: BoardRow[] = [];
  const issues: string[] = [];
  for (const d of state.docs) {
    queue.push(...queueItemsOf(d.doc));
    done.push(...doneEntriesOf(d.doc));
    board.push(...boardRowsOf(d.doc));
    issues.push(...workDocIssues(d.doc).map((issue) => `${d.path}: ${issue}`));
  }

  const openQueue = args.includeDone ? queue : queue.filter((q) => !q.done);
  const filtered = args.priority ? openQueue.filter((q) => q.priority === args.priority) : openQueue;

  return {
    ok: true as const,
    project: state.project,
    repo: state.repo,
    source,
    ...(args.kind === "queue" || args.kind === undefined ? { queue: filtered } : {}),
    ...(args.kind === "done" || args.kind === undefined ? { done } : {}),
    ...(args.kind === "board" || args.kind === undefined ? { board } : {}),
    // A row refused for wrong arity is absent from `board` — say so rather
    // than let the absence read as "that lane doesn't exist".
    ...(issues.length ? { issues } : {}),
  };
}

// Parse the documents without persisting — used by the list fallback so a
// read never has the side effect of writing a store file.
async function importFromDisk(project: string, repo: string): Promise<WorkState | null> {
  const found = resolveDocs(repo);
  if (!found.length) return null;
  const docs: StoredDoc[] = [];
  for (const f of found) {
    const src = await fsp.readFile(path.join(repo, f.path), "utf8");
    docs.push({ kind: f.kind, path: f.path, doc: parseWorkDoc(src) });
  }
  return { project, repo, importedAt: Date.now(), docs };
}

// ---------- export_work ----------

export const exportWorkSchema = {
  project: z.string().min(1),
  // Default false: an export REPORTS by default and only writes when asked.
  write: z.boolean().optional(),
  // Where to write; defaults to the repo the state was imported from.
  repo: z.string().optional(),
  // Whose write this is, for the (advisory) Task 4 scope verdict.
  agentId: z.string().optional(),
};

export async function exportWorkTool(args: {
  project: string;
  write?: boolean;
  repo?: string;
  agentId?: string;
}) {
  const state = await loadState(args.project);
  // Refuse rather than render nothing. An export from an absent or empty store
  // would blank a real document — the store is derived, so "no records" means
  // "not imported", never "the queue is empty".
  if (!state || !state.docs.length) {
    return {
      ok: false as const,
      error: `no imported work state for '${args.project}' — run import_work first. (Refusing to export from an empty store: that would blank the documents, and the markdown is authoritative.)`,
    };
  }

  const repo = args.repo ?? state.repo;
  const scopes = await loadScopes();
  const reg = await readJson<AgentRegistry>(AGENTS_FILE, {});
  const write = args.write ?? false;

  const files = [];
  for (const d of state.docs) {
    const target = path.join(repo, d.path);
    const rendered = renderWorkDoc(d.doc);
    const current = existsSync(target) ? await fsp.readFile(target, "utf8") : null;
    const declared = scopes.documents.find((s) => s.path === d.path);
    // ADVISORY ONLY — reported, never enforced. See the header note.
    const scope = declared
      ? {
          owner: declared.owner,
          mode: declared.mode,
          callerOwns: args.agentId ? ownsDocument(args.agentId, reg[args.agentId], declared.owner) : null,
          advisory: true as const,
        }
      : undefined;

    if (write && rendered !== current) await fsp.writeFile(target, rendered, "utf8");
    const issues = workDocIssues(d.doc);
    files.push({
      path: d.path,
      bytes: Buffer.byteLength(rendered, "utf8"),
      identical: rendered === current,
      written: write && rendered !== current,
      // Refused rows replay verbatim — the write is byte-faithful — but a
      // caller rewriting a document should hear that some rows carry no
      // record, rather than infer health from `identical:true`.
      ...(issues.length ? { issues } : {}),
      ...(scope ? { scope } : {}),
    });
  }

  return {
    ok: true as const,
    project: state.project,
    repo,
    write,
    files,
    ...(write ? {} : { note: "dry run — pass write:true to rewrite the documents" }),
  };
}
