// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none, printing what it changed
// or why it failed. In a trial the grader runs `node /bot/main.ts` with
// MAKEFUN_ENV_URL set, and this file hands over to runner.ts (last lines):
// keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function byteLess(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order, as [old, new] pairs. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Files and lines (SPEC.md section 3) and matching (section 5)
// ---------------------------------------------------------------------------

interface Split {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function splitFile(text: string): Split {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(s: Split): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** First tier at which O occurs in the file's lines, with every position. */
function occurrences(fileLines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const on = o.map((l) => normLine(l, t));
    const pos: number[] = [];
    for (let i = 0; i + o.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (normLine(fileLines[i + j]!, t) !== on[j]) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or an added line. */
interface NLine {
  text: string;
  /** Index into O of the context line this replaces, or null for an added line. */
  ctx: number | null;
}

/** Build the replacement lines for a match at `pos` of O at `tier`. */
function buildNew(fileLines: string[], o: string[], n: NLine[], pos: number, tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWs(fileLines[pos]!);
    p = leadingWs(o[0]!);
  }
  return n.map((e) => {
    if (e.ctx !== null) return fileLines[pos + e.ctx]!;
    if (tier === 2) {
      const t = e.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    }
    return e.text;
  });
}

/** Replace file lines [pos, pos+o.length) by N, or insert N at pos when o is empty. */
function spliceLines(cur: Split, o: string[], n: NLine[], pos: number, tier: number): void {
  const built = buildNew(cur.lines, o, n, pos, tier);
  cur.lines = [...cur.lines.slice(0, pos), ...built, ...cur.lines.slice(pos + o.length)];
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

type BodyKind = 'ctx' | 'old' | 'new' | 'mark';
interface BodyLine {
  kind: BodyKind;
  text: string;
}

interface Hunk {
  /** Old start line, 1-based (A in @@ -A[,B] +C[,D] @@). */
  a: number;
  items: BodyLine[];
  /** True when a `\` line follows the hunk's last context or `+` line. */
  noNl: boolean;
}

interface USection {
  oldRaw: string;
  newRaw: string;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, surrounding spaces removed, one a/ or b/ prefix removed. */
function unifiedPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunkNoNl(items: BodyLine[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'ctx' || it.kind === 'new') return items[i + 1]?.kind === 'mark';
  }
  return false;
}

/** O and N of a hunk, from its body lines. */
function hunkON(h: Hunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const it of h.items) {
    if (it.kind === 'ctx') {
      n.push({ text: it.text, ctx: o.length });
      o.push(it.text);
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else if (it.kind === 'new') {
      n.push({ text: it.text, ctx: null });
    }
  }
  return { o, n };
}

/** Apply a section's hunks in order to a file's text. `path` names the file for failure lines. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const cur = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h);
    if (o.length > 0) {
      const found = occurrences(cur.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + o.length === cur.lines.length;
      spliceLines(cur, o, n, best, found.tier);
      if (atEnd) cur.final = !h.noNl;
      d += n.length - o.length;
    } else {
      const ins = Math.min(Math.max(h.a + d, 0), cur.lines.length);
      const atEnd = ins === cur.lines.length;
      spliceLines(cur, o, n, ins, 0);
      if (atEnd) cur.final = !h.noNl;
      d += n.length;
    }
  }
  return joinFile(cur);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;
  const startSection = (oldRaw: string, newRaw: string): USection => {
    const s: USection = { oldRaw, newRaw, isNew: false, isDel: false, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = startSection(m[1]!, m[2]!.trim());
      inHeader = true;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      const items: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ') || (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ '))) break;
        if (bl === '') items.push({ kind: 'ctx', text: '' });
        else if (bl[0] === ' ') items.push({ kind: 'ctx', text: bl.slice(1) });
        else if (bl[0] === '-') items.push({ kind: 'old', text: bl.slice(1) });
        else if (bl[0] === '+') items.push({ kind: 'new', text: bl.slice(1) });
        else if (bl[0] === '\\') items.push({ kind: 'mark', text: bl.slice(1) });
        else break;
        j += 1;
      }
      while (items.length > 0 && items[items.length - 1]!.kind === 'ctx' && items[items.length - 1]!.text === '') items.pop();
      cur.hunks.push({ a, items, noNl: parseHunkNoNl(items) });
      inHeader = false;
      i = j;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.oldRaw = unifiedPath(l);
        cur.newRaw = unifiedPath(lines[i + 1]!);
      } else {
        cur = startSection(unifiedPath(l), unifiedPath(lines[i + 1]!));
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) cur.oldRaw = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.newRaw = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.isNew = true;
      else if (l.startsWith('deleted file mode')) cur.isDel = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldRaw = sec.oldRaw;
    const newRaw = sec.newRaw;
    const oldNull = oldRaw === '/dev/null';
    const newNull = newRaw === '/dev/null';
    if (sec.isNew || oldNull) {
      if (!safe(newRaw)) throw new Fail('unsafe', newRaw);
      if (tree.get(newRaw) !== null) throw new Fail('exists', newRaw);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
      let noNl = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const items = sec.hunks[hi]!.items;
        for (let k = items.length - 1; k >= 0; k--) {
          if (items[k]!.kind === 'new') {
            noNl = items[k + 1]?.kind === 'mark';
            break outer;
          }
        }
      }
      tree.now.set(newRaw, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    if (sec.isDel || newNull) {
      if (!safe(oldRaw)) throw new Fail('unsafe', oldRaw);
      if (tree.get(oldRaw) === null) throw new Fail('missing', oldRaw);
      tree.now.set(oldRaw, null);
      return;
    }
    if (oldRaw !== newRaw) {
      if (!safe(oldRaw)) throw new Fail('unsafe', oldRaw);
      if (!safe(newRaw)) throw new Fail('unsafe', newRaw);
      const before = tree.get(oldRaw);
      if (before === null) throw new Fail('missing', oldRaw);
      if (tree.get(newRaw) !== null) throw new Fail('exists', newRaw);
      const res = applyHunks(before, sec.hunks, strict, oldRaw);
      tree.now.set(newRaw, res);
      tree.now.set(oldRaw, null);
      tree.moves.push([oldRaw, newRaw]);
      return;
    }
    if (!safe(oldRaw)) throw new Fail('unsafe', oldRaw);
    const before = tree.get(oldRaw);
    if (before === null) throw new Fail('missing', oldRaw);
    tree.now.set(oldRaw, applyHunks(before, sec.hunks, strict, oldRaw));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const cur = splitFile(before);
    const found = occurrences(cur.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const n: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    spliceLines(cur, oldLines, n, found.pos[0]!, found.tier);
    tree.now.set(path, joinFile(cur));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

type VKind = 'add' | 'del' | 'upd';
interface VSection {
  kind: VKind;
  path: string;
  lineNo: number;
  raw: Array<{ text: string; idx: number }>;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyLine[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let lastIdx = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      lastIdx = k;
      break;
    }
  }
  if (lines[lastIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let i = first + 1;
  const start = (kind: VKind, path: string, lineNo: number): void => {
    cur = { kind, path, lineNo, raw: [] };
    sections.push(cur);
  };
  while (i < lastIdx) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ')) {
      start('add', l.slice('*** Add File: '.length).trim(), i + 1);
    } else if (l.startsWith('*** Delete File: ')) {
      start('del', l.slice('*** Delete File: '.length).trim(), i + 1);
    } else if (l.startsWith('*** Update File: ')) {
      start('upd', l.slice('*** Update File: '.length).trim(), i + 1);
    } else if (cur !== null) {
      cur.raw.push({ text: l, idx: i });
    } else if (!blank(l)) {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function v4aSectionEdit(sec: VSection, strict: boolean): Edit {
  // Blank lines at the end of a section are not part of it.
  const raw = [...sec.raw];
  while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
  if (sec.kind === 'add') {
    const fileLines: string[] = [];
    for (const r of raw) {
      if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
      else if (r.text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${r.idx + 1}`);
    }
    const p = sec.path;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'del') {
    for (const r of raw) throw new Exit2(`error: parse ${r.idx + 1}`);
    const p = sec.path;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  // Update File: optional `*** Move to:` first, then chunks.
  let moveTo: string | null = null;
  let k = 0;
  while (k < raw.length && blank(raw[k]!.text)) k += 1;
  if (k < raw.length && raw[k]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[k]!.text.slice('*** Move to: '.length).trim();
    k += 1;
  }
  const chunks: VChunk[] = [];
  let chunk: VChunk | null = null;
  let started = false;
  const closeChunk = (): void => {
    if (chunk !== null) {
      chunks.push(chunk);
      chunk = null;
    }
  };
  for (; k < raw.length; k++) {
    const r = raw[k]!;
    const l = r.text;
    if (l.startsWith('@@')) {
      closeChunk();
      chunk = { anchor: l.slice(2).trim(), eof: false, items: [] };
      started = true;
      continue;
    }
    if (l === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${r.idx + 1}`);
      chunk.eof = true;
      closeChunk();
      continue;
    }
    if (l.startsWith('*** ')) throw new Exit2(`error: parse ${r.idx + 1}`);
    const isBody = l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+';
    if (!isBody) throw new Exit2(`error: parse ${r.idx + 1}`);
    if (chunk === null) {
      // Blank lines before the first chunk, or between chunks, are not part of any chunk.
      if (blank(l)) continue;
      if (started) throw new Exit2(`error: parse ${r.idx + 1}`);
      chunk = { anchor: null, eof: false, items: [] };
      started = true;
    }
    if (l === '') chunk.items.push({ kind: 'ctx', text: '' });
    else if (l[0] === ' ') chunk.items.push({ kind: 'ctx', text: l.slice(1) });
    else if (l[0] === '-') chunk.items.push({ kind: 'old', text: l.slice(1) });
    else chunk.items.push({ kind: 'new', text: l.slice(1) });
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
  const p = sec.path;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const res = applyVChunks(before, chunks, strict, p);
    if (moveTo !== null) {
      tree.now.set(moveTo, res);
      tree.now.set(p, null);
      tree.moves.push([p, moveTo]);
    } else {
      tree.now.set(p, res);
    }
  };
}

/** Find the first occurrence of a single line at or after `from`, at the first tier with one. */
function findAnchorLine(fileLines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normLine(anchor, t);
    for (let i = from; i < fileLines.length; i++) {
      if (normLine(fileLines[i]!, t) === want) return i;
    }
  }
  return null;
}

function applyVChunks(before: string, chunks: VChunk[], strict: boolean, path: string): string {
  const cur = splitFile(before);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null && ch.anchor !== '') {
      const at = findAnchorLine(cur.lines, ch.anchor, cursor, strict);
      if (at === null) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const { o, n } = hunkON({ a: 0, items: ch.items, noNl: false });
    if (o.length > 0) {
      // First tier with an occurrence at or after the cursor (ending at the last line for EOF chunks).
      let found: { tier: number; pos: number } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const on = o.map((l) => normLine(l, t));
        for (let i = cursor; i + o.length <= cur.lines.length; i++) {
          if (ch.eof && i + o.length !== cur.lines.length) continue;
          let ok = true;
          for (let j = 0; j < o.length; j++) {
            if (normLine(cur.lines[i + j]!, t) !== on[j]) {
              ok = false;
              break;
            }
          }
          if (ok) {
            found = { tier: t, pos: i };
            break;
          }
        }
        if (found !== null) break;
      }
      if (found === null) throw new Fail('no-match', path);
      spliceLines(cur, o, n, found.pos, found.tier);
      cursor = found.pos + n.length;
    } else {
      const ins = ch.eof ? cur.lines.length : cursor;
      spliceLines(cur, o, n, ins, 0);
      cursor = ins + n.length;
    }
  }
  return joinFile(cur);
}

// ---------------------------------------------------------------------------
// Invocation, output and exit codes (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows, in byte order of the paths (a move sorts by its new path).
  // A move is an `R` line only when its old path existed before the patch and
  // does not after it, and its new path did not exist before it and does after
  // it; otherwise its two paths report as D/A/M like any other change.
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.original(newP) === null && tree.get(oldP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteLess(a.key, b.key));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    // Delete first, then write: a move may swap a file with its own parent path.
    for (const p of [...tree.now.keys()].sort(byteLess)) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()].sort(byteLess)) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
