// Work state as data (Phase 8 Task 5): queue items, done entries and board
// rows as typed records, with markdown as a first-class EXPORT rather than the
// datastore.
//
// WHY THIS SHAPE. `docs/QUEUE.md` / `docs/DONE.md` were parsed under a contract
// requiring exact `—` (U+2014) and ` · ` (U+00B7). A parser once returned ZERO
// items on the real file while passing every synthetic test, and the consuming
// UI rendered an empty panel — no error, no signal. The files themselves are
// good: David edits them, git diffs them, they grep. So markdown stays the
// INTERFACE and stops being the DATASTORE.
//
// MARKDOWN REMAINS AUTHORITATIVE. Delete the store and the documents still
// stand alone: every field here is recoverable from the file it came from, the
// exporter is byte-exact, and nothing downstream is required to read records.
// The store is a derived index until a consumer chooses otherwise.
//
// The round-trip guarantee is structural, not incidental: everything this
// module does NOT model — prose, the write-rule paragraphs, the Cross-project
// section, fenced examples — is captured verbatim as a `text` block and
// replayed in place. Only lines it genuinely understands are re-rendered, so
// an unmodelled construct can never be silently dropped.

import { createHash } from "node:crypto";

// ---------- record shapes ----------

export type Priority = "P1" | "P2" | "P3";

// Fields taken from what the pre-existing parser extracted, no more.
export type QueueItem = {
  id: string;
  priority: Priority;
  text: string;
  done: boolean;
  // The `### Subsection` this item sits under, when the document groups them.
  section?: string;
};

// `ref` and `date` are parsed separately today and stay separate fields — a
// reassembled "ref · date" string would put the glyph contract right back into
// the data model, which is the bug this task exists to delete.
export type DoneEntry = {
  id: string;
  text: string;
  ref?: string;
  date?: string;
  section?: string;
};

// WORKSTREAMS.md's Lanes table, as it genuinely exists: a 5-column markdown
// table. Column headers are carried so a renamed column round-trips.
export type BoardRow = {
  id: string;
  lane: string;
  owner: string;
  state: string;
  currentSlice: string;
  nextGo: string;
  // The line this row was read from. Markdown tables are hand-aligned and
  // there is no canonical spacing, so an UNCHANGED row replays its original
  // bytes; edit any field and the renderer notices the mismatch and re-renders
  // in the normalized form. Absent on rows built from scratch.
  raw?: string;
};

// The one arity BoardRow can hold. boardCells() and the parser's arity guard
// both reference this constant so the two sides cannot drift; a test pins
// boardCells().length === BOARD_ARITY.
export const BOARD_ARITY = 5;

// A table row whose column count does not match BoardRow. It is REFUSED a
// record (boardRowsOf never returns it) but PRESERVED byte-exactly — the
// alternative, destructuring whatever arity into a fixed 5-tuple, silently
// narrowed 6-column rows and widened 4-column ones on export (hit live
// 2026-07-29: #38's extra `Pane` column was dropped on write-back). Refusing
// the row rather than throwing keeps one bad row from taking down the whole
// document's import. The schema decision stays with the board owner: widening
// BoardRow is a deliberate act (change BOARD_ARITY, boardCells, and this
// guard together), never something a docs commit does by accident.
export type MalformedRow = {
  malformed: true;
  // Replayed byte-exactly on render — never narrowed, never widened.
  verbatim: string;
  // Names the line, quotes the row, states expected/actual — loud enough to
  // fix from the message alone.
  issue: string;
};

export function isMalformedRow(r: BoardRow | MalformedRow): r is MalformedRow {
  return (r as MalformedRow).malformed === true;
}

// A parsed document: an ordered block list. `text` blocks are verbatim lines
// (never interpreted); the others carry records rendered back in place.
export type Block =
  | { kind: "text"; lines: string[] }
  | { kind: "queue"; items: QueueItem[] }
  | { kind: "done"; entries: DoneEntry[] }
  // `header` and `align` are kept as raw lines for the same reason as
  // BoardRow.raw — the alignment row (`|---|---|`) has no canonical form.
  | { kind: "board"; header: string; align: string; rows: (BoardRow | MalformedRow)[] };

export type WorkDoc = {
  // Kept so an export can be written back with the exact byte tail it had.
  trailingNewline: boolean;
  blocks: Block[];
};

// ---------- the glyph contract ----------
//
// Pinned in docs/DONE.md and consumed by external parsers: the ref splits on
// the LAST ` — ` (space, U+2014, space) and the date is a trailing ` · `
// (space, U+00B7, space) + ISO date. Written as explicit escapes so a source
// file normalization or a copy-paste through an ASCII-mangling tool can never
// change them silently — the constants are the contract.
export const EM_DASH_SEP = " — ";
export const MIDDOT_SEP = " · ";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Deterministic ids: same content in → same id out, so import→export→import is
// stable and no id has to be written into the markdown (which would change the
// bytes the round trip is measured on).
function idFor(kind: string, seed: string): string {
  return `${kind}-${createHash("sha1").update(seed).digest("hex").slice(0, 8)}`;
}

// ---------- line-level recognizers ----------

const QUEUE_LINE = /^- \[( |x)\] \((P1|P2|P3)\) (.*)$/;
const DONE_LINE = /^- \[( |x)\] (.*)$/;

export function parseQueueLine(line: string, section?: string): QueueItem | null {
  const m = QUEUE_LINE.exec(line);
  if (!m) return null;
  const [, mark, priority, text] = m;
  return {
    id: idFor("q", text ?? ""),
    priority: priority as Priority,
    text: text ?? "",
    done: mark === "x",
    ...(section ? { section } : {}),
  };
}

// Split on the LAST ` — `, then peel a trailing ` · YYYY-MM-DD`. Both parts are
// optional: an entry with neither is still a done entry, it just carries no
// verifiable ref — which is a fact about the entry, not a parse failure. The
// old parser treated the same line as nothing at all.
export function parseDoneLine(line: string, section?: string): DoneEntry | null {
  const m = DONE_LINE.exec(line);
  if (!m) return null;
  let body = m[2] ?? "";
  let ref: string | undefined;
  let date: string | undefined;

  const cut = body.lastIndexOf(EM_DASH_SEP);
  if (cut !== -1) {
    const tail = body.slice(cut + EM_DASH_SEP.length);
    const dot = tail.lastIndexOf(MIDDOT_SEP);
    if (dot !== -1) {
      const maybeDate = tail.slice(dot + MIDDOT_SEP.length);
      if (ISO_DATE.test(maybeDate)) {
        date = maybeDate;
        ref = tail.slice(0, dot);
      }
    }
    // A tail with no date is still a ref, as long as it isn't prose with
    // spaces — refs are `owner/repo#N` or `owner/repo@sha`.
    if (date === undefined && /^\S+$/.test(tail)) ref = tail;
    if (ref !== undefined) body = body.slice(0, cut);
  }
  return {
    id: idFor("d", `${body}|${ref ?? ""}|${date ?? ""}`),
    text: body,
    ...(ref !== undefined ? { ref } : {}),
    ...(date !== undefined ? { date } : {}),
    ...(section ? { section } : {}),
  };
}

export function renderQueueLine(item: QueueItem): string {
  return `- [${item.done ? "x" : " "}] (${item.priority}) ${item.text}`;
}

export function renderDoneLine(entry: DoneEntry): string {
  let line = `- [x] ${entry.text}`;
  if (entry.ref !== undefined) line += `${EM_DASH_SEP}${entry.ref}`;
  if (entry.date !== undefined) line += `${MIDDOT_SEP}${entry.date}`;
  return line;
}

// ---------- board table ----------

const TABLE_ROW = /^\|(.*)\|\s*$/;
const TABLE_ALIGN = /^\|[\s:|-]+\|\s*$/;

function splitRow(line: string): string[] {
  const m = TABLE_ROW.exec(line);
  if (!m) return [];
  return (m[1] ?? "").split("|").map((c) => c.trim());
}

function renderRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function boardCells(r: BoardRow): string[] {
  return [r.lane, r.owner, r.state, r.currentSlice, r.nextGo];
}

// Replay the original line when the fields still say what it said; re-render
// once anything actually changed. A malformed row has no fields to have
// changed — it replays its bytes, always.
export function renderBoardRow(r: BoardRow | MalformedRow): string {
  if (isMalformedRow(r)) return r.verbatim;
  if (r.raw !== undefined) {
    const cells = splitRow(r.raw);
    if (cells.length === BOARD_ARITY && cells.every((c, i) => c === boardCells(r)[i])) return r.raw;
  }
  return renderRow(boardCells(r));
}

// ---------- document parsing ----------

type SectionKind = "queue" | "done" | "none";

// Which record kind a `## Heading` opens. `## Queue` → queue items,
// `## Done` → done entries; anything else closes the record region, so the
// Cross-project section's bullets stay verbatim prose.
function sectionKindOf(heading: string): SectionKind {
  const h = heading.replace(/^#+\s*/, "").trim().toLowerCase();
  if (h === "queue") return "queue";
  if (h === "done") return "done";
  return "none";
}

export function parseWorkDoc(source: string): WorkDoc {
  const trailingNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (trailingNewline) lines.pop(); // the split's empty tail, restored on render

  const blocks: Block[] = [];
  let text: string[] = [];
  let kind: SectionKind = "none";
  let subsection: string | undefined;
  let inFence = false;

  const flushText = () => {
    if (text.length) blocks.push({ kind: "text", lines: text });
    text = [];
  };
  // Consecutive item lines coalesce into one block; anything in between (a
  // blank line, a subsection heading) flushes as text first and therefore
  // starts a new one, which is what keeps rendering order faithful.
  const pushItem = (item: QueueItem) => {
    flushText();
    const last = blocks[blocks.length - 1];
    if (last?.kind === "queue") last.items.push(item);
    else blocks.push({ kind: "queue", items: [item] });
  };
  const pushEntry = (entry: DoneEntry) => {
    flushText();
    const last = blocks[blocks.length - 1];
    if (last?.kind === "done") last.entries.push(entry);
    else blocks.push({ kind: "done", entries: [entry] });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Fenced blocks are never interpreted — docs/DONE.md pins the done-line
    // FORMAT inside a fence, and parsing that example as an entry would
    // invent a record out of documentation.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      text.push(line);
      continue;
    }
    if (inFence) {
      text.push(line);
      continue;
    }

    if (/^#{1,6}\s/.test(line)) {
      const level = (line.match(/^#+/) ?? [""])[0].length;
      if (level <= 2) {
        kind = sectionKindOf(line);
        subsection = undefined;
      } else if (kind !== "none") {
        subsection = line.replace(/^#+\s*/, "").trim();
      }
      text.push(line);
      continue;
    }

    if (kind === "queue") {
      const item = parseQueueLine(line, subsection);
      if (item) {
        pushItem(item);
        continue;
      }
    } else if (kind === "done") {
      const entry = parseDoneLine(line, subsection);
      if (entry) {
        pushEntry(entry);
        continue;
      }
    }

    // Lanes table: a header row followed by an alignment row.
    if (TABLE_ROW.test(line) && TABLE_ALIGN.test(lines[i + 1] ?? "")) {
      const rows: (BoardRow | MalformedRow)[] = [];
      let j = i + 2;
      for (; j < lines.length && TABLE_ROW.test(lines[j] ?? ""); j++) {
        const raw = lines[j] ?? "";
        const cells = splitRow(raw);
        // Arity guard: a row BoardRow cannot hold is refused a record, kept
        // verbatim, and named loudly — destructuring it into the 5-tuple is
        // exactly the silent narrow/widen this exists to prevent. An empty
        // trailing cell (`| a | b | c | d | |`) is still five columns and
        // still a legitimate row.
        if (cells.length !== BOARD_ARITY) {
          rows.push({
            malformed: true,
            verbatim: raw,
            issue:
              `board row at line ${j + 1} has ${cells.length} column(s), expected ${BOARD_ARITY} — ` +
              `refused (kept verbatim, excluded from board records). Fix the row, or widen BoardRow ` +
              `deliberately (BOARD_ARITY + boardCells + this guard together). Row: ${raw}`,
          });
          continue;
        }
        const [lane = "", owner = "", state = "", currentSlice = "", nextGo = ""] = cells;
        rows.push({ id: idFor("b", lane), lane, owner, state, currentSlice, nextGo, raw });
      }
      flushText();
      blocks.push({ kind: "board", header: line, align: lines[i + 1] ?? "", rows });
      i = j - 1;
      continue;
    }

    text.push(line);
  }
  flushText();
  return { trailingNewline, blocks };
}

export function renderWorkDoc(doc: WorkDoc): string {
  const out: string[] = [];
  for (const block of doc.blocks) {
    if (block.kind === "text") out.push(...block.lines);
    else if (block.kind === "queue") out.push(...block.items.map(renderQueueLine));
    else if (block.kind === "done") out.push(...block.entries.map(renderDoneLine));
    else {
      out.push(block.header);
      out.push(block.align);
      for (const r of block.rows) out.push(renderBoardRow(r));
    }
  }
  return out.join("\n") + (doc.trailingNewline ? "\n" : "");
}

// ---------- record extraction ----------

export function queueItemsOf(doc: WorkDoc): QueueItem[] {
  return doc.blocks.flatMap((b) => (b.kind === "queue" ? b.items : []));
}

export function doneEntriesOf(doc: WorkDoc): DoneEntry[] {
  return doc.blocks.flatMap((b) => (b.kind === "done" ? b.entries : []));
}

export function boardRowsOf(doc: WorkDoc): BoardRow[] {
  return doc.blocks.flatMap((b) =>
    b.kind === "board" ? b.rows.filter((r): r is BoardRow => !isMalformedRow(r)) : [],
  );
}

// Every refused row's issue, in document order — what makes the parse-time
// rejection LOUD at the tool layer (import_work/list_work/export_work all
// surface it) instead of a filtered-out record nobody notices.
export function workDocIssues(doc: WorkDoc): string[] {
  return doc.blocks.flatMap((b) =>
    b.kind === "board" ? b.rows.filter(isMalformedRow).map((r) => r.issue) : [],
  );
}
