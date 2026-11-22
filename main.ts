// mend — apply an AI-written edit to a tree of text files.
// Node 22, standard library only. Implements SPEC.md v1: unified diffs,
// SEARCH/REPLACE blocks, V4A patches and JSON edits, with three-tier
// line matching and all-or-nothing (atomic) writes.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------- utilities

function isBlank(s: string): boolean {
  return s.trim() === '';
}

/** Remove trailing spaces and tabs. */
function trimRightWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

/** Remove leading and trailing spaces and tabs. */
function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Byte-wise (UTF-8) comparison for sorting paths. */
function cmpUtf8(a: string, b: string): number {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return Buffer.compare(ba, bb);
}

// ---------------------------------------------------------------- file model

type Eol = '\n' | '\r\n';

interface FileDoc {
  eol: Eol;
  lines: string[];
  endsWithBreak: boolean;
}

/** Split file text into lines per SPEC section 3. */
function parseFileDoc(text: string): FileDoc {
  let eol: Eol = '\n';
  const firstLf = text.indexOf('\n');
  if (firstLf > 0 && text[firstLf - 1] === '\r') eol = '\r\n';
  if (text === '') return { eol, lines: [], endsWithBreak: false };
  const parts = text.split(eol);
  if (text.endsWith(eol)) {
    return { eol, lines: parts.slice(0, -1), endsWithBreak: true };
  }
  return { eol, lines: parts, endsWithBreak: false };
}

function renderFileDoc(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.eol) + (doc.endsWithBreak ? doc.eol : '');
}

/** Patch lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function splitPatchLines(text: string): string[] {
  const raw = text.split('\n');
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  return raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// ---------------------------------------------------------------- path safety

/** SPEC section 3: a path is safe when it is not empty, does not start with `/`,
 *  holds no `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const s of p.split('/')) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------- matching (section 5)

function lineEqAtTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimRightWs(a) === trimRightWs(b);
  return trimWs(a) === trimWs(b);
}

function findOccurrences(fileLines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  const n = O.length;
  if (n === 0) return out;
  for (let i = 0; i + n <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!lineEqAtTier(fileLines[i + j], O[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2) at which O occurs at least once. Strict: tier 0 only. */
function findTier(fileLines: string[], O: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const pos = findOccurrences(fileLines, O, t);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** One line of a replacement N. `oIndex` is the index into O for a context line,
 *  or null for a genuinely new line. */
interface NItem {
  text: string;
  oIndex: number | null;
}

/**
 * Build the replacement lines for N at a matched position.
 * Context lines are written as the file's own matched line, never the patch's.
 * At tier 2 every other line is re-indented from P (O's first line leading ws)
 * to F (the file's first matched line leading ws).
 */
function buildReplacement(
  nItems: NItem[],
  fileLines: string[],
  matchPos: number,
  O: string[],
  tier: number,
): string[] {
  const out: string[] = [];
  const F = matchPos < fileLines.length ? leadingWs(fileLines[matchPos]) : '';
  const P = O.length > 0 ? leadingWs(O[0]) : '';
  for (const it of nItems) {
    if (it.oIndex !== null) {
      out.push(fileLines[matchPos + it.oIndex]);
    } else {
      let t = it.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) {
        t = F + t.slice(P.length);
      }
      out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------- in-memory tree

/** Sentinel marking "this path was checked and did not exist on disk". */
const ABSENT = '\0absent';

/** A file tree held in memory while edits apply. `orig` is the on-disk state at
 *  start; `cur` is the working state. Absent from `cur` means deleted / not yet created. */
class Tree {
  orig = new Map<string, string>();
  cur = new Map<string, string>();

  /** Read a file from disk into the tree (only once per path). */
  load(path: string): string | undefined {
    if (this.cur.has(path)) return this.cur.get(path);
    if (this.orig.has(path)) return undefined; // was loaded and is absent
    let content: string | undefined;
    try {
      if (existsSync(path)) {
        content = readFileSync(path, 'utf8');
        this.orig.set(path, content);
        this.cur.set(path, content);
      } else {
        this.orig.set(path, ABSENT);
      }
    } catch {
      this.orig.set(path, ABSENT);
    }
    return content;
  }

  exists(path: string): boolean {
    return this.load(path) !== undefined;
  }

  /** Content of a file that must exist (caller checked). */
  get(path: string): string {
    const c = this.load(path);
    if (c === undefined) throw new Error('internal: missing file ' + path);
    return c;
  }

  set(path: string, content: string): void {
    this.cur.set(path, content);
    // Mark orig as loaded-absent if we never saw it, so the A/M classification works.
    if (!this.orig.has(path)) this.orig.set(path, ABSENT);
  }

  del(path: string): void {
    this.cur.delete(path);
    if (!this.orig.has(path)) this.orig.set(path, ABSENT);
  }

  /** Did this path exist on disk before the patch? */
  existedBefore(path: string): boolean {
    this.load(path);
    return this.orig.get(path) !== ABSENT;
  }
}

/** A single failed edit: code + the path the failure concerns. */
interface EditFailure {
  code: 'no-match' | 'ambiguous' | 'missing' | 'exists' | 'unsafe';
  path: string;
}

// ---------------------------------------------------------------- unified diffs (section 6)

interface UBodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

interface UHunk {
  a: number;
  body: UBodyLine[];
}

interface USection {
  oldPath: string | null; // null = /dev/null
  newPath: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: UHunk[];
}

/** Parse a `--- <path>` / `+++ <path>` header line. Returns the path or null for /dev/null. */
function parseDiffPathLine(line: string): string | null {
  // Text after the first 4 characters, up to the first tab, surrounding spaces removed.
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/')) rest = rest.slice(2);
  else if (rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

/** Parse a `diff --git a/<X> b/<Y>` line. Returns [X, Y] or null when malformed. */
function parseDiffGitLine(line: string): [string, string] | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
  if (!m) return null;
  return [m[1], m[2]];
}

/** Parse a hunk header `@@ -A[,B] +C[,D] @@` (+ optional text). Returns A or null. */
function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return parseInt(m[1], 10);
}

/**
 * Parse the patch lines as a unified diff.
 * Returns sections, or a 1-based parse-error line number.
 */
function parseUnified(lines: string[]): { sections: USection[] } | { parseError: number } {
  const sections: USection[] = [];
  const n = lines.length;
  let i = 0;
  // Current section under construction, or null when outside any section.
  let cur: USection | null = null;
  // Fallback / override path sources for the current section.
  let diffOld: string | null = null;
  let diffNew: string | null = null;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let pairSeen = false;
  let renameOld: string | null = null;
  let renameNew: string | null = null;
  // True while in a section's header (before its first hunk).
  let inHeader = false;

  const resolvePaths = (): void => {
    if (!cur) return;
    cur.oldPath = pairSeen ? pairOld : renameOld !== null ? renameOld : diffOld;
    cur.newPath = pairSeen ? pairNew : renameNew !== null ? renameNew : diffNew;
  };

  const startSection = (): void => {
    cur = { oldPath: null, newPath: null, newFileMode: false, deletedFileMode: false, hunks: [] };
    sections.push(cur);
    diffOld = null;
    diffNew = null;
    pairOld = null;
    pairNew = null;
    pairSeen = false;
    renameOld = null;
    renameNew = null;
    inHeader = true;
  };

  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const parsed = parseDiffGitLine(line);
      if (!parsed) return { parseError: i + 1 };
      if (cur) resolvePaths();
      startSection();
      diffOld = parsed[0];
      diffNew = parsed[1];
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      if (cur && inHeader) {
        // The current section's own ---/+++ pair.
        pairOld = parseDiffPathLine(line);
        pairNew = parseDiffPathLine(lines[i + 1]);
        pairSeen = true;
        i += 2;
        continue;
      }
      // A new section.
      if (cur) resolvePaths();
      startSection();
      pairOld = parseDiffPathLine(line);
      pairNew = parseDiffPathLine(lines[i + 1]);
      pairSeen = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur && inHeader) {
      // A --- line in a header not followed by +++.
      return { parseError: i + 2 };
    }
    if (line.startsWith('@@')) {
      const a = parseHunkHeader(line);
      if (a === null) return { parseError: i + 1 };
      if (!cur) return { parseError: i + 1 };
      resolvePaths();
      inHeader = false;
      const hunk: UHunk = { a, body: [] };
      cur.hunks.push(hunk);
      i++;
      // Collect the body.
      while (i < n) {
        const bl = lines[i];
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          if (bl === '') hunk.body.push({ kind: 'ctx', text: '' });
          else if (bl.startsWith(' ')) hunk.body.push({ kind: 'ctx', text: bl.slice(1) });
          else if (bl.startsWith('-')) hunk.body.push({ kind: 'old', text: bl.slice(1) });
          else if (bl.startsWith('+')) hunk.body.push({ kind: 'new', text: bl.slice(1) });
          else hunk.body.push({ kind: 'bs', text: bl.slice(1) });
          i++;
        } else {
          break;
        }
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1];
        if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      continue;
    }
    if (cur && inHeader) {
      if (line.startsWith('rename from ')) {
        renameOld = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        renameNew = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.newFileMode = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.deletedFileMode = true;
      }
      // index / old mode / new mode / similarity / dissimilarity / Index: / any other line: ignored.
      i++;
      continue;
    }
    // Outside a body and not a header line: ignored (prose, code fences).
    i++;
  }
  if (cur) resolvePaths();
  return { sections };
}

/** Build O and N (with context tracking) from a hunk body. */
function hunkON(body: UBodyLine[]): { O: string[]; N: NItem[] } {
  const O: string[] = [];
  const N: NItem[] = [];
  for (const bl of body) {
    if (bl.kind === 'ctx') {
      O.push(bl.text);
      N.push({ text: bl.text, oIndex: O.length - 1 });
    } else if (bl.kind === 'old') {
      O.push(bl.text);
    } else if (bl.kind === 'new') {
      N.push({ text: bl.text, oIndex: null });
    }
    // 'bs' lines contribute to neither O nor N.
  }
  return { O, N };
}

/** Is a `\` line immediately after the last context/`+` body line? */
function hunkNoNewlineAfterLastN(body: UBodyLine[]): boolean {
  let lastN = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k].kind === 'ctx' || body[k].kind === 'new') lastN = k;
  }
  if (lastN < 0) return false;
  return lastN + 1 < body.length && body[lastN + 1].kind === 'bs';
}

/** Apply one hunk to a FileDoc. Returns the new doc or an error code. */
function applyHunk(
  doc: FileDoc,
  hunk: UHunk,
  d: number,
  strict: boolean,
): { doc: FileDoc; d: number } | { code: 'no-match' } {
  const { O, N } = hunkON(hunk.body);
  const noNl = hunkNoNewlineAfterLastN(hunk.body);
  if (O.length === 0) {
    const pos = Math.min(hunk.a + d, doc.lines.length);
    const repl: string[] = N.map((it) => it.text);
    const lines = [...doc.lines.slice(0, pos), ...repl, ...doc.lines.slice(pos)];
    let endsWithBreak = doc.endsWithBreak;
    if (N.length > 0 && pos === doc.lines.length) endsWithBreak = !noNl;
    const nd = d + (N.length - O.length);
    return { doc: { eol: doc.eol, lines, endsWithBreak }, d: nd };
  }
  const found = findTier(doc.lines, O, strict);
  if (!found) return { code: 'no-match' };
  const target = hunk.a - 1 + d;
  let best = found.positions[0];
  let bestDist = Math.abs(best - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < bestDist || (dist === bestDist && p < best)) {
      best = p;
      bestDist = dist;
    }
  }
  const repl = buildReplacement(N, doc.lines, best, O, found.tier);
  const lines = [...doc.lines.slice(0, best), ...repl, ...doc.lines.slice(best + O.length)];
  let endsWithBreak = doc.endsWithBreak;
  const runsToEnd = best + O.length === doc.lines.length;
  if (lines.length === 0) {
    endsWithBreak = false;
  } else if (runsToEnd) {
    endsWithBreak = N.length > 0 ? !noNl : true;
  }
  const nd = d + (N.length - O.length);
  return { doc: { eol: doc.eol, lines, endsWithBreak }, d: nd };
}

/**
 * Apply one unified section as a single edit.
 * Returns the failure, or null on success (tree already updated).
 */
function applyUnifiedSection(sec: USection, tree: Tree, strict: boolean): EditFailure | null {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  const isCreate = oldP === null || sec.newFileMode;
  const isDelete = newP === null || sec.deletedFileMode;
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  // Safety first, before anything else about a path.
  if (oldP !== null && !isSafePath(oldP)) return { code: 'unsafe', path: oldP };
  if (newP !== null && !isSafePath(newP)) return { code: 'unsafe', path: newP };

  if (isCreate) {
    const p = newP as string;
    if (tree.exists(p)) return { code: 'exists', path: p };
    // The file is the + lines of all its hunks, in order.
    const plus: string[] = [];
    for (const h of sec.hunks) {
      for (const bl of h.body) {
        if (bl.kind === 'new') plus.push(bl.text);
      }
    }
    // A created file ends with a line break unless a \ line follows its last + line.
    let noNl = false;
    {
      let lastPlusHunk: UHunk | null = null;
      for (const h of sec.hunks) {
        if (h.body.some((b) => b.kind === 'new')) lastPlusHunk = h;
      }
      noNl = lastPlusHunk ? hunkNoNewlineAfterLastN(lastPlusHunk.body) : false;
    }
    const text = plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n');
    tree.set(p, text);
    return null;
  }
  if (isDelete) {
    const p = oldP as string;
    if (!tree.exists(p)) return { code: 'missing', path: p };
    tree.del(p);
    return null;
  }
  if (isMove) {
    const o = oldP as string;
    const nw = newP as string;
    if (!tree.exists(o)) return { code: 'missing', path: o };
    if (tree.exists(nw)) return { code: 'exists', path: nw };
    const doc = parseFileDoc(tree.get(o));
    let cur = doc;
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyHunk(cur, h, d, strict);
      if ('code' in r) return { code: r.code, path: o };
      cur = r.doc;
      d = r.d;
    }
    tree.del(o);
    tree.set(nw, renderFileDoc(cur));
    recordMove(o, nw);
    return null;
  }
  // Change of the one path.
  const p = (oldP ?? newP) as string;
  if (!tree.exists(p)) return { code: 'missing', path: p };
  const doc = parseFileDoc(tree.get(p));
  let cur = doc;
  let d = 0;
  for (const h of sec.hunks) {
    const r = applyHunk(cur, h, d, strict);
    if ('code' in r) return { code: r.code, path: p };
    cur = r.doc;
    d = r.d;
  }
  tree.set(p, renderFileDoc(cur));
  return null;
}

// Successful moves, for R-line reporting: [old, new].
const moves: [string, string][] = [];
function recordMove(oldP: string, newP: string): void {
  moves.push([oldP, newP]);
}

// ---------------------------------------------------------------- SEARCH/REPLACE (section 7)

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

/** Parse the patch lines as SEARCH/REPLACE blocks. */
function parseSearchReplace(lines: string[]): { blocks: SRBlock[] } | { parseError: number } {
  const blocks: SRBlock[] = [];
  const n = lines.length;
  let prevReplaceIdx = -1; // index of the previous block's >>>>>>> REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (trimRightWs(lines[i]) === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      // Path: nearest line before the SEARCH line, after the previous REPLACE
      // (or the start), that is not blank and does not start with three backticks.
      let path: string | null = null;
      for (let k = i - 1; k > prevReplaceIdx; k--) {
        const t = lines[k];
        if (isBlank(t)) continue;
        const trimmed = t.trim();
        if (trimmed.startsWith('```')) continue;
        path = trimmed;
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) return { parseError: searchLine };
      // Find ======= then >>>>>>> REPLACE after the SEARCH line.
      let eqIdx = -1;
      for (let k = i + 1; k < n; k++) {
        if (trimRightWs(lines[k]) === '=======') {
          eqIdx = k;
          break;
        }
      }
      if (eqIdx === -1) return { parseError: searchLine };
      let repIdx = -1;
      for (let k = eqIdx + 1; k < n; k++) {
        if (trimRightWs(lines[k]) === '>>>>>>> REPLACE') {
          repIdx = k;
          break;
        }
      }
      if (repIdx === -1) return { parseError: searchLine };
      const oldLines = lines.slice(i + 1, eqIdx);
      const newLines = lines.slice(eqIdx + 1, repIdx);
      blocks.push({ path, oldLines, newLines });
      prevPath = path;
      prevReplaceIdx = repIdx;
      i = repIdx + 1;
      continue;
    }
    i++;
  }
  return { blocks };
}

/** Apply one SEARCH/REPLACE block as a single edit. */
function applySRBlock(b: SRBlock, tree: Tree, strict: boolean): EditFailure | null {
  if (!isSafePath(b.path)) return { code: 'unsafe', path: b.path };
  if (b.oldLines.length === 0) {
    if (tree.exists(b.path)) return { code: 'exists', path: b.path };
    const text = b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n';
    tree.set(b.path, text);
    return null;
  }
  if (!tree.exists(b.path)) return { code: 'missing', path: b.path };
  const doc = parseFileDoc(tree.get(b.path));
  const found = findTier(doc.lines, b.oldLines, strict);
  if (!found) return { code: 'no-match', path: b.path };
  if (found.positions.length > 1) return { code: 'ambiguous', path: b.path };
  const pos = found.positions[0];
  const nItems: NItem[] = b.newLines.map((t) => ({ text: t, oIndex: null }));
  const repl = buildReplacement(nItems, doc.lines, pos, b.oldLines, found.tier);
  const lines = [...doc.lines.slice(0, pos), ...repl, ...doc.lines.slice(pos + b.oldLines.length)];
  const endsWithBreak = lines.length === 0 ? false : doc.endsWithBreak;
  tree.set(b.path, renderFileDoc({ eol: doc.eol, lines, endsWithBreak }));
  return null;
}

// ---------------------------------------------------------------- V4A (section 8)

type V4ASection =
  | { kind: 'add'; path: string; fileLines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4AChunk[] };

interface V4AChunk {
  anchor: string | null; // null = no anchor
  eof: boolean;
  body: UBodyLine[];
}

/** Parse the patch lines as a V4A patch. */
function parseV4A(lines: string[]): { sections: V4ASection[] } | { parseError: number } {
  const n = lines.length;
  let first = -1;
  for (let k = 0; k < n; k++) {
    if (!isBlank(lines[k])) {
      first = k;
      break;
    }
  }
  if (first === -1) return { parseError: 1 };
  if (lines[first].trim() !== '*** Begin Patch') return { parseError: first + 1 };
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!isBlank(lines[k])) {
      last = k;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') return { parseError: n + 1 };

  const sections: V4ASection[] = [];
  // Scan the middle lines (first+1 .. last-1) for sections.
  let i = first + 1;
  const end = last; // exclusive
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      // Collect content lines until the next section start or the end.
      const content: string[] = [];
      let j = i + 1;
      while (j < end && !isSectionStart(lines[j])) {
        content.push(lines[j]);
        j++;
      }
      // Blank lines at the end of a section are not part of it (a line that is
      // empty or only whitespace is blank, including a lone context prefix).
      while (content.length > 0 && isBlank(content[content.length - 1])) content.pop();
      const fileLines: string[] = [];
      for (let k = 0; k < content.length; k++) {
        const cl = content[k];
        if (cl === '') fileLines.push('');
        else if (cl.startsWith('+')) fileLines.push(cl.slice(1));
        else return { parseError: i + 2 + k };
      }
      sections.push({ kind: 'add', path, fileLines });
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      // A Delete File section has no lines: the next non-blank line must be a section start or the end.
      let j = i + 1;
      while (j < end && isBlank(lines[j])) j++;
      if (j < end && !isSectionStart(lines[j])) return { parseError: j + 1 };
      sections.push({ kind: 'delete', path });
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      // Collect content lines until the next section start or the end.
      const content: string[] = [];
      let j = i + 1;
      while (j < end && !isSectionStart(lines[j])) {
        content.push(lines[j]);
        j++;
      }
      // Blank lines at the end of a section are not part of it.
      while (content.length > 0 && isBlank(content[content.length - 1])) content.pop();
      // Optional *** Move to: as the first line.
      let moveTo: string | null = null;
      let bodyStart = 0;
      if (content.length > 0 && content[0].startsWith('*** Move to: ')) {
        moveTo = content[0].slice('*** Move to: '.length).trim();
        bodyStart = 1;
      }
      // Parse chunks from content[bodyStart..].
      const chunks: V4AChunk[] = [];
      let curChunk: V4AChunk | null = null;
      const pushChunk = (): void => {
        if (curChunk) {
          chunks.push(curChunk);
          curChunk = null;
        }
      };
      for (let k = bodyStart; k < content.length; k++) {
        const cl = content[k];
        const origLine = i + 2 + k; // 1-based line number of this content line
        if (cl.startsWith('@@')) {
          pushChunk();
          const anchorText = cl.slice(2).trim();
          curChunk = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
        } else if (cl === '*** End of File') {
          if (!curChunk) return { parseError: origLine };
          curChunk.eof = true;
          pushChunk();
        } else if (cl === '' || cl.startsWith(' ') || cl.startsWith('-') || cl.startsWith('+')) {
          if (!curChunk) curChunk = { anchor: null, eof: false, body: [] };
          if (cl === '') curChunk.body.push({ kind: 'ctx', text: '' });
          else if (cl.startsWith(' ')) curChunk.body.push({ kind: 'ctx', text: cl.slice(1) });
          else if (cl.startsWith('-')) curChunk.body.push({ kind: 'old', text: cl.slice(1) });
          else curChunk.body.push({ kind: 'new', text: cl.slice(1) });
        } else {
          return { parseError: origLine };
        }
      }
      pushChunk();
      if (chunks.length === 0 && moveTo === null) return { parseError: updateLine };
      sections.push({ kind: 'update', path, moveTo, chunks });
      i = j;
      continue;
    }
    return { parseError: i + 1 };
  }
  return { sections };
}

/** Find the first line at or after `from` equal to a single-line anchor, at the first tier with one. */
function findAnchor(fileLines: string[], anchor: string, from: number, strict: boolean): number | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    for (let p = from; p < fileLines.length; p++) {
      if (lineEqAtTier(fileLines[p], anchor, t)) return p;
    }
  }
  return null;
}

/** Apply one V4A chunk to a FileDoc, tracking the cursor. */
function applyV4AChunk(
  doc: FileDoc,
  chunk: V4AChunk,
  cursor: number,
  strict: boolean,
): { doc: FileDoc; cursor: number } | { code: 'no-match' } {
  let cur = cursor;
  if (chunk.anchor !== null) {
    const aPos = findAnchor(doc.lines, chunk.anchor, cur, strict);
    if (aPos === null) return { code: 'no-match' };
    cur = aPos + 1;
  }
  const { O, N } = hunkON(chunk.body);
  if (O.length === 0) {
    const pos = chunk.eof ? doc.lines.length : cur;
    const repl: string[] = N.map((it) => it.text);
    const lines = [...doc.lines.slice(0, pos), ...repl, ...doc.lines.slice(pos)];
    const endsWithBreak = lines.length === 0 ? false : doc.endsWithBreak;
    return { doc: { eol: doc.eol, lines, endsWithBreak }, cursor: pos + repl.length };
  }
  // Find the first occurrence of O at or after the cursor, at the first tier with one.
  const maxTier = strict ? 0 : 2;
  let foundTier = -1;
  let foundPos = -1;
  for (let t = 0; t <= maxTier; t++) {
    const occ = findOccurrences(doc.lines, O, t).filter((p) => p >= cur);
    if (chunk.eof) {
      const eofOcc = occ.filter((p) => p + O.length === doc.lines.length);
      if (eofOcc.length > 0) {
        foundTier = t;
        foundPos = eofOcc[0];
        break;
      }
    } else if (occ.length > 0) {
      foundTier = t;
      foundPos = occ[0];
      break;
    }
  }
  if (foundPos === -1) return { code: 'no-match' };
  const repl = buildReplacement(N, doc.lines, foundPos, O, foundTier);
  const lines = [...doc.lines.slice(0, foundPos), ...repl, ...doc.lines.slice(foundPos + O.length)];
  const endsWithBreak = lines.length === 0 ? false : doc.endsWithBreak;
  return { doc: { eol: doc.eol, lines, endsWithBreak }, cursor: foundPos + repl.length };
}

/** Apply one V4A section as a single edit. */
function applyV4ASection(sec: V4ASection, tree: Tree, strict: boolean): EditFailure | null {
  if (sec.kind === 'add') {
    if (!isSafePath(sec.path)) return { code: 'unsafe', path: sec.path };
    if (tree.exists(sec.path)) return { code: 'exists', path: sec.path };
    const text = sec.fileLines.length === 0 ? '' : sec.fileLines.join('\n') + '\n';
    tree.set(sec.path, text);
    return null;
  }
  if (sec.kind === 'delete') {
    if (!isSafePath(sec.path)) return { code: 'unsafe', path: sec.path };
    if (!tree.exists(sec.path)) return { code: 'missing', path: sec.path };
    tree.del(sec.path);
    return null;
  }
  // update
  if (!isSafePath(sec.path)) return { code: 'unsafe', path: sec.path };
  if (sec.moveTo !== null && !isSafePath(sec.moveTo)) return { code: 'unsafe', path: sec.moveTo };
  if (!tree.exists(sec.path)) return { code: 'missing', path: sec.path };
  if (sec.moveTo !== null && tree.exists(sec.moveTo)) return { code: 'exists', path: sec.moveTo };
  const doc = parseFileDoc(tree.get(sec.path));
  let cur = doc;
  let cursor = 0;
  for (const ch of sec.chunks) {
    const r = applyV4AChunk(cur, ch, cursor, strict);
    if ('code' in r) return { code: r.code, path: sec.path };
    cur = r.doc;
    cursor = r.cursor;
  }
  if (sec.moveTo !== null) {
    tree.del(sec.path);
    tree.set(sec.moveTo, renderFileDoc(cur));
    recordMove(sec.path, sec.moveTo);
  } else {
    tree.set(sec.path, renderFileDoc(cur));
  }
  return null;
}

// ---------------------------------------------------------------- JSON edits (section 9)

type JsonEdit =
  | { command: 'create'; path: string; file_text: string }
  | { command: 'str_replace'; path: string; old_str: string; new_str: string }
  | { command: 'insert'; path: string; insert_line: number; new_str: string };

/** Validate one parsed JSON value as an edit object. Returns the edit or null. */
function asJsonEdit(v: unknown): JsonEdit | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { command: 'create', path: o.path, file_text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { command: 'str_replace', path: o.path, old_str: o.old_str, new_str: typeof o.new_str === 'string' ? o.new_str : '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { command: 'insert', path: o.path, insert_line: o.insert_line, new_str: o.new_str };
  }
  return null;
}

/** Parse the patch text as JSON edits (array form or JSON Lines). */
function parseJson(patchText: string, lines: string[]): { edits: JsonEdit[] } | { parseError: number } {
  // First non-blank line decides the form.
  let firstIdx = -1;
  for (let k = 0; k < lines.length; k++) {
    if (!isBlank(lines[k])) {
      firstIdx = k;
      break;
    }
  }
  if (firstIdx === -1) return { edits: [] };
  const firstNonWs = lines[firstIdx].trimStart();
  if (firstNonWs.startsWith('[')) {
    // Array form: any fault is parse <the line where the array starts>.
    let parsed: unknown;
    try {
      parsed = JSON.parse(patchText);
    } catch {
      return { parseError: firstIdx + 1 };
    }
    if (!Array.isArray(parsed)) return { parseError: firstIdx + 1 };
    const edits: JsonEdit[] = [];
    for (const el of parsed) {
      const e = asJsonEdit(el);
      if (!e) return { parseError: firstIdx + 1 };
      edits.push(e);
    }
    return { edits };
  }
  // JSON Lines form: one edit object a line, blank lines ignored.
  const edits: JsonEdit[] = [];
  for (let k = 0; k < lines.length; k++) {
    if (isBlank(lines[k])) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[k]);
    } catch {
      return { parseError: k + 1 };
    }
    const e = asJsonEdit(parsed);
    if (!e) return { parseError: k + 1 };
    edits.push(e);
  }
  return { edits };
}

/** Count occurrences of `needle` in `hay`, allowing overlaps. */
function countOccurrences(hay: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = hay.indexOf(needle, idx);
    if (found === -1) break;
    count++;
    idx = found + 1;
  }
  return count;
}

/** Apply one JSON edit. */
function applyJsonEdit(e: JsonEdit, tree: Tree): EditFailure | null {
  if (!isSafePath(e.path)) return { code: 'unsafe', path: e.path };
  if (e.command === 'create') {
    if (tree.exists(e.path)) return { code: 'exists', path: e.path };
    tree.set(e.path, e.file_text);
    return null;
  }
  if (e.command === 'str_replace') {
    if (!tree.exists(e.path)) return { code: 'missing', path: e.path };
    const raw = tree.get(e.path);
    const doc = parseFileDoc(raw);
    if (doc.eol === '\r\n') {
      const normText = raw.replace(/\r\n/g, '\n');
      const normOld = e.old_str.replace(/\r\n/g, '\n');
      const normNew = e.new_str.replace(/\r\n/g, '\n');
      const count = countOccurrences(normText, normOld);
      if (count === 0) return { code: 'no-match', path: e.path };
      if (count > 1) return { code: 'ambiguous', path: e.path };
      const replaced = normText.replace(normOld, normNew);
      tree.set(e.path, replaced.replace(/\n/g, '\r\n'));
      return null;
    }
    const count = countOccurrences(raw, e.old_str);
    if (count === 0) return { code: 'no-match', path: e.path };
    if (count > 1) return { code: 'ambiguous', path: e.path };
    tree.set(e.path, raw.replace(e.old_str, e.new_str));
    return null;
  }
  // insert
  if (!tree.exists(e.path)) return { code: 'missing', path: e.path };
  const doc = parseFileDoc(tree.get(e.path));
  if (e.insert_line < 0 || e.insert_line > doc.lines.length) return { code: 'no-match', path: e.path };
  const newLines = splitPatchLines(e.new_str);
  const lines = [...doc.lines.slice(0, e.insert_line), ...newLines, ...doc.lines.slice(e.insert_line)];
  const endsWithBreak = lines.length === 0 ? false : doc.endsWithBreak;
  tree.set(e.path, renderFileDoc({ eol: doc.eol, lines, endsWithBreak }));
  return null;
}

// ---------------------------------------------------------------- format detection (section 4)

/** Detect the patch format (auto). Returns null when no format is detected. */
function detectFormat(lines: string[]): string | null {
  let firstIdx = -1;
  for (let k = 0; k < lines.length; k++) {
    if (!isBlank(lines[k])) {
      firstIdx = k;
      break;
    }
  }
  if (firstIdx !== -1) {
    if (lines[firstIdx].trim() === '*** Begin Patch') return 'v4a';
    const firstNonWs = lines[firstIdx].trimStart();
    if (firstNonWs.startsWith('[') || firstNonWs.startsWith('{')) return 'json';
  }
  for (const l of lines) {
    if (trimRightWs(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].startsWith('diff --git ')) return 'unified';
    if (lines[k].startsWith('--- ') && k + 1 < lines.length && lines[k + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------- output

/** Compute the change lines (A/D/M/R) from the tree, sorted by path in UTF-8 byte order. */
function computeChanges(tree: Tree): { sortKey: string; line: string }[] {
  const changes: { sortKey: string; line: string }[] = [];
  const handled = new Set<string>();
  for (const [oldP, newP] of moves) {
    const oldBefore = tree.existedBefore(oldP);
    const oldAfter = tree.cur.has(oldP);
    const newBefore = tree.existedBefore(newP);
    const newAfter = tree.cur.has(newP);
    if (oldBefore && !oldAfter && !newBefore && newAfter) {
      changes.push({ sortKey: newP, line: `R ${oldP} -> ${newP}` });
      handled.add(oldP);
      handled.add(newP);
    }
  }
  const allPaths = new Set<string>();
  for (const [p, v] of tree.orig) {
    if (v !== ABSENT) allPaths.add(p);
  }
  for (const p of tree.cur.keys()) allPaths.add(p);
  for (const p of allPaths) {
    if (handled.has(p)) continue;
    const before = tree.existedBefore(p);
    const after = tree.cur.has(p);
    if (before && !after) {
      changes.push({ sortKey: p, line: `D ${p}` });
    } else if (!before && after) {
      changes.push({ sortKey: p, line: `A ${p}` });
    } else if (before && after) {
      const origContent = tree.orig.get(p) as string;
      const curContent = tree.cur.get(p) as string;
      if (origContent !== curContent) {
        changes.push({ sortKey: p, line: `M ${p}` });
      }
    }
  }
  changes.sort((a, b) => cmpUtf8(a.sortKey, b.sortKey));
  return changes;
}

/** Write the tree's final state to disk (deletions, then creations/changes). */
function writeTree(tree: Tree): void {
  for (const [p, v] of tree.orig) {
    if (v !== ABSENT && !tree.cur.has(p)) {
      try {
        rmSync(p, { force: true });
      } catch {
        // Ignore removal errors.
      }
    }
  }
  for (const [p, content] of tree.cur) {
    const before = tree.orig.get(p);
    if (before === content) continue;
    const dir = dirname(p);
    if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true });
    writeFileSync(p, content);
  }
}

// ---------------------------------------------------------------- trial hand-over (MAKEFUN_ENV_URL)

async function trialSend(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
}

function readTreeLocal(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && Object.keys(out).length < 64) {
        out[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
      }
    }
  };
  walk(dir);
  return out;
}

interface TrialCheck {
  id: string;
  argv: string[];
  stdin: string | null;
  files: Record<string, string>;
}

function runCheckLocal(c: TrialCheck): { id: string; exit: number; stdout: string; files: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'mend-'));
  try {
    for (const [p, text] of Object.entries(c.files)) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const env = { ...process.env };
    delete env.MAKEFUN_ENV_URL;
    const program = process.argv[1];
    const r = spawnSync(process.execPath, [program, ...c.argv], {
      cwd: dir,
      env,
      input: c.stdin ?? '',
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 4 * 64 * 1024,
    });
    const exit = r.error !== undefined || r.status === null ? 124 : r.status;
    let stdout = r.stdout ?? '';
    while (Buffer.byteLength(stdout, 'utf8') > 64 * 1024) {
      stdout = stdout.slice(0, Math.floor(stdout.length / 2));
    }
    return { id: c.id, exit, stdout, files: readTreeLocal(dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runTrial(envUrl: string): Promise<void> {
  const base = envUrl.replace(/\/+$/, '');
  const post = async (results: unknown[]): Promise<void> => {
    const res = await trialSend(`${base}/results`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ results }),
    });
    const body = await res.text();
    if (!res.ok && res.status !== 409) throw new Error(`POST /results answered ${res.status}: ${body}`);
  };
  const res = await trialSend(`${base}/checks`);
  if (!res.ok) throw new Error(`GET /checks answered ${res.status}`);
  const { checks } = (await res.json()) as { checks: TrialCheck[] };
  let batch: unknown[] = [];
  for (const c of checks) {
    batch.push(runCheckLocal(c));
    if (batch.length === 10) {
      await post(batch);
      batch = [];
    }
  }
  if (batch.length > 0) await post(batch);
  process.stdout.write(`posted ${checks.length} results\n`);
}

// ---------------------------------------------------------------- main (sections 1-2, 10)

async function main(): Promise<number> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl) {
    await runTrial(envUrl);
    return 0;
  }

  const argv = process.argv.slice(2);
  let format: string | null = null;
  let check = false;
  let strict = false;
  const positionals: string[] = [];
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOfOptions = false;
  const usage = (): number => {
    process.stdout.write('error: usage\n');
    return 2;
  };

  for (const arg of argv) {
    if (!endOfOptions && arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (seenCheck) return usage();
        seenCheck = true;
        check = true;
      } else if (arg === '--strict') {
        if (seenStrict) return usage();
        seenStrict = true;
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seenFormat) return usage();
        seenFormat = true;
        const v = arg.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return usage();
        format = v;
      } else {
        return usage();
      }
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) return usage();
  const patchArg = positionals.length === 1 ? positionals[0] : null;

  // Read the patch (file or stdin).
  let patchText: string;
  if (patchArg === null || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      return 2;
    }
  }
  const patchLines = splitPatchLines(patchText);

  // Detect the format.
  let fmt = format;
  if (fmt === null || fmt === 'auto') {
    fmt = detectFormat(patchLines);
    if (fmt === null) {
      process.stdout.write('error: format\n');
      return 2;
    }
  }

  // Parse the patch into edits, then apply them to an in-memory tree.
  const tree = new Tree();
  const failures: EditFailure[] = [];
  let totalEdits = 0;

  if (fmt === 'unified') {
    const parsed = parseUnified(patchLines);
    if ('parseError' in parsed) {
      process.stdout.write(`error: parse ${parsed.parseError}\n`);
      return 2;
    }
    if (parsed.sections.length === 0) {
      process.stdout.write('error: parse 1\n');
      return 2;
    }
    totalEdits = parsed.sections.length;
    for (const sec of parsed.sections) {
      const f = applyUnifiedSection(sec, tree, strict);
      if (f) failures.push(f);
    }
  } else if (fmt === 'search-replace') {
    const parsed = parseSearchReplace(patchLines);
    if ('parseError' in parsed) {
      process.stdout.write(`error: parse ${parsed.parseError}\n`);
      return 2;
    }
    if (parsed.blocks.length === 0) {
      process.stdout.write('error: parse 1\n');
      return 2;
    }
    totalEdits = parsed.blocks.length;
    for (const b of parsed.blocks) {
      const f = applySRBlock(b, tree, strict);
      if (f) failures.push(f);
    }
  } else if (fmt === 'v4a') {
    const parsed = parseV4A(patchLines);
    if ('parseError' in parsed) {
      process.stdout.write(`error: parse ${parsed.parseError}\n`);
      return 2;
    }
    if (parsed.sections.length === 0) {
      process.stdout.write('error: parse 1\n');
      return 2;
    }
    totalEdits = parsed.sections.length;
    for (const sec of parsed.sections) {
      const f = applyV4ASection(sec, tree, strict);
      if (f) failures.push(f);
    }
  } else {
    const parsed = parseJson(patchText, patchLines);
    if ('parseError' in parsed) {
      process.stdout.write(`error: parse ${parsed.parseError}\n`);
      return 2;
    }
    if (parsed.edits.length === 0) {
      process.stdout.write('error: parse 1\n');
      return 2;
    }
    totalEdits = parsed.edits.length;
    for (const e of parsed.edits) {
      const f = applyJsonEdit(e, tree);
      if (f) failures.push(f);
    }
  }

  if (failures.length > 0) {
    for (const f of failures) {
      process.stdout.write(`error: ${f.code} ${f.path}\n`);
    }
    process.stdout.write(`failed: ${failures.length} of ${totalEdits} edits\n`);
    return 1;
  }

  const changes = computeChanges(tree);
  if (!check) writeTree(tree);
  for (const c of changes) {
    process.stdout.write(c.line + '\n');
  }
  if (changes.length === 1) process.stdout.write('ok: 1 file\n');
  else process.stdout.write(`ok: ${changes.length} files\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(String(err) + '\n');
    process.exit(2);
  });
