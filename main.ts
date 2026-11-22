// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** SPEC.md section 3: a file's lines, its line break and whether it ends with one. */
interface FileLines {
  lines: string[];
  br: string;
  eol: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const eol = text.endsWith(br);
  if (eol) parts.pop();
  return { lines: parts, br, eol };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.eol ? f.br : '');
}

/** SPEC.md section 5: line matching at three tiers. */
function lineAtTier(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function lineEq(a: string, b: string, tier: number): boolean {
  return lineAtTier(a, tier) === lineAtTier(b, tier);
}

function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0..2, or 0 only when strict) at which O occurs at/after `from`, else -1. */
function findTier(O: string[], lines: string[], from: number, strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    if (occurrences(O, lines, t, from).length > 0) return t;
  }
  return -1;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/**
 * Build the replacement lines N for a match of O at position `pos` in the file's lines.
 * ctx[i] is the index in O of the context line N[i] corresponds to, or -1 for a new line.
 * Context lines are written as the file's own matched line; at tier 2 every other line of N
 * is re-indented from O's first line's indent P to the file's first matched line's indent F.
 */
function buildN(N: string[], ctx: number[], O: string[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  for (let j = 0; j < N.length; j++) {
    const cj = ctx[j]!;
    if (cj >= 0) {
      out.push(fileLines[pos + cj]!);
      continue;
    }
    let s = N[j]!;
    if (tier === 2 && O.length > 0) {
      const P = leadingWs(O[0]!);
      const F = leadingWs(fileLines[pos]!);
      if (s !== '' && s.trim() !== '' && s.startsWith(P)) s = F + s.slice(P.length);
    }
    out.push(s);
  }
  return out;
}

/** One body line of a unified hunk or a V4A chunk: kind ` ` context, `-` old, `+` new, `\` marker. */
interface BodyLine {
  k: ' ' | '-' | '+' | '\\';
  text: string;
}

function bodyON(body: BodyLine[]): { O: string[]; N: string[]; ctx: number[] } {
  const O: string[] = [];
  const N: string[] = [];
  const ctx: number[] = [];
  for (const b of body) {
    if (b.k === ' ') {
      ctx.push(O.length);
      O.push(b.text);
      N.push(b.text);
    } else if (b.k === '-') {
      O.push(b.text);
    } else if (b.k === '+') {
      ctx.push(-1);
      N.push(b.text);
    }
  }
  return { O, N, ctx };
}

/** True when a `\` line follows the hunk/chunk's last context or `+` body line. */
function hasNoEol(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.k === ' ' || body[i]!.k === '+') last = i;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1]!.k === '\\';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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
  return edits;
}

/** SPEC.md section 6: unified diffs. */
interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function uniPath(text: string): string {
  return text.split('\t')[0]!.trim();
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function parseUnified(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  interface RawSection {
    mmOld: string | null;
    mmNew: string | null;
    rnOld: string | null;
    rnNew: string | null;
    dgOld: string | null;
    dgNew: string | null;
    create: boolean;
    del: boolean;
    hunks: Hunk[];
  }
  const raw: RawSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    let sec: RawSection | null = null;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      sec = { mmOld: null, mmNew: null, rnOld: null, rnNew: null, dgOld: m[1]!, dgNew: m[2]!, create: false, del: false, hunks: [] };
      i += 1;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { mmOld: null, mmNew: null, rnOld: null, rnNew: null, dgOld: null, dgNew: null, create: false, del: false, hunks: [] };
    } else {
      i += 1;
      continue;
    }
    raw.push(sec);
    let inHeader = true;
    while (i < lines.length) {
      const s = lines[i]!;
      if (s.startsWith('diff --git ')) break;
      if (!inHeader && s.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (s.startsWith('@@')) {
        const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(s);
        if (!hm) throw new Exit2(`error: parse ${i + 1}`);
        inHeader = false;
        const hunk: Hunk = { a: parseInt(hm[1]!, 10), body: [] };
        i += 1;
        while (i < lines.length) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
            hunk.body.push({ k: b === '' ? ' ' : (b[0] as BodyLine['k']), text: b === '' ? '' : b.slice(1) });
            i += 1;
          } else break;
        }
        while (hunk.body.length > 0) {
          const lastB = hunk.body[hunk.body.length - 1]!;
          if (lastB.k === ' ' && lastB.text === '') hunk.body.pop();
          else break;
        }
        sec.hunks.push(hunk);
        continue;
      }
      if (inHeader) {
        if (s.startsWith('--- ')) {
          if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
          sec.mmOld = uniPath(s.slice(4));
          sec.mmNew = uniPath(lines[i + 1]!.slice(4));
          i += 2;
          continue;
        }
        if (s.startsWith('rename from ')) {
          sec.rnOld = s.slice(12).trim();
          i += 1;
          continue;
        }
        if (s.startsWith('rename to ')) {
          sec.rnNew = s.slice(10).trim();
          i += 1;
          continue;
        }
        if (s.startsWith('new file mode')) {
          sec.create = true;
          i += 1;
          continue;
        }
        if (s.startsWith('deleted file mode')) {
          sec.del = true;
          i += 1;
          continue;
        }
      }
      i += 1;
    }
  }
  if (raw.length === 0) throw new Exit2('error: parse 1');
  return raw.map((r) => {
    const pick = (mm: string | null, rn: string | null, dg: string | null): string | null => {
      if (mm !== null) return mm === '/dev/null' ? null : stripAB(mm);
      if (rn !== null) return rn === '/dev/null' ? null : stripAB(rn);
      if (dg !== null) return dg === '/dev/null' ? null : stripAB(dg);
      return null;
    };
    const oldPath = pick(r.mmOld, r.rnOld, r.dgOld);
    const newPath = pick(r.mmNew, r.rnNew, r.dgNew);
    const create = oldPath === null || r.create;
    const del = newPath === null || r.del;
    const isMove = !create && !del && oldPath !== null && newPath !== null && oldPath !== newPath;
    const target = isMove ? newPath! : create ? newPath! : oldPath!;
    const failPath = isMove || !create ? oldPath! : newPath!;
    return (tree: Tree): void => {
      if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
      if (create) {
        if (tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
        const out: string[] = [];
        let eol = true;
        for (const h of r.hunks) {
          for (const b of h.body) if (b.k === '+') out.push(b.text);
        }
        for (let hi = r.hunks.length - 1; hi >= 0; hi--) {
          const h = r.hunks[hi]!;
          if (h.body.some((b) => b.k === '+')) {
            eol = !hasNoEol(h.body);
            break;
          }
        }
        tree.now.set(newPath!, out.length === 0 ? '' : out.join('\n') + (eol ? '\n' : ''));
        return;
      }
      if (del) {
        if (tree.get(oldPath!) === null) throw new Fail('missing', oldPath!);
        tree.now.set(oldPath!, null);
        return;
      }
      const before = tree.get(oldPath!);
      if (before === null) throw new Fail('missing', oldPath!);
      if (isMove && tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
      const after = applyHunks(before, r.hunks, strict, failPath);
      if (isMove) {
        tree.now.set(newPath!, after);
        tree.now.set(oldPath!, null);
        moves.push([oldPath!, newPath!]);
      } else {
        tree.now.set(oldPath!, after);
      }
    };
  });
}

/** Apply a section's hunks in order to a file's text (SPEC.md section 6). */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const f = splitFile(before);
  let d = 0;
  for (const hunk of hunks) {
    const { O, N, ctx } = bodyON(hunk.body);
    if (O.length === 0) {
      const at = Math.min(hunk.a + d, f.lines.length);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...N);
      if (atEnd) f.eol = !hasNoEol(hunk.body);
      d += N.length;
      continue;
    }
    const tier = findTier(O, f.lines, 0, strict);
    if (tier < 0) throw new Fail('no-match', failPath);
    const occs = occurrences(O, f.lines, tier, 0);
    const target = hunk.a - 1 + d;
    let best = occs[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of occs) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const atEnd = best + O.length === f.lines.length;
    const repl = buildN(N, ctx, O, f.lines, best, tier);
    f.lines.splice(best, O.length, ...repl);
    if (atEnd) f.eol = !hasNoEol(hunk.body);
    d += N.length - O.length;
  }
  return joinFile(f);
}

/** SPEC.md section 7: SEARCH/REPLACE blocks. */
function parseSR(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    let end = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (eq < 0 || end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchLine + 1, eq), newLines: lines.slice(eq + 1, end) });
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    const path = b.path;
    const oldLines = b.oldLines;
    const newLines = b.newLines;
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const f = splitFile(before);
      const tier = findTier(oldLines, f.lines, 0, strict);
      if (tier < 0) throw new Fail('no-match', path);
      const occs = occurrences(oldLines, f.lines, tier, 0);
      if (occs.length > 1) throw new Fail('ambiguous', path);
      const pos = occs[0]!;
      const repl = buildN(newLines, newLines.map(() => -1), oldLines, f.lines, pos, tier);
      f.lines.splice(pos, oldLines.length, ...repl);
      tree.now.set(path, joinFile(f));
    };
  });
}

/** SPEC.md section 8: V4A patches. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function isVSectionStart(s: string): boolean {
  return s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ');
}

function parseV4A(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const prefixLen = kind === 'add' ? 14 : 17;
      const path = l.slice(prefixLen).trim();
      const startLine = i;
      i += 1;
      let end = i;
      while (end < last && !isVSectionStart(lines[end]!)) end += 1;
      const raw = lines.slice(i, end);
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      i = end;
      if (kind === 'add') {
        const addLines: string[] = [];
        for (let k = 0; k < raw.length; k++) {
          const s = raw[k]!;
          if (s.startsWith('+')) addLines.push(s.slice(1));
          else if (blank(s)) addLines.push('');
          else throw new Exit2(`error: parse ${startLine + 2 + k}`);
        }
        edits.push((tree: Tree): void => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) !== null) throw new Fail('exists', path);
          tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
        });
        continue;
      }
      if (kind === 'delete') {
        for (let k = 0; k < raw.length; k++) {
          if (!blank(raw[k]!)) throw new Exit2(`error: parse ${startLine + 2 + k}`);
        }
        edits.push((tree: Tree): void => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) === null) throw new Fail('missing', path);
          tree.now.set(path, null);
        });
        continue;
      }
      let moveTo: string | null = null;
      let k = 0;
      if (k < raw.length && raw[k]!.startsWith('*** Move to: ')) {
        moveTo = raw[k]!.slice(13).trim();
        k += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const pushCur = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; k < raw.length; k++) {
        const s = raw[k]!;
        if (s.startsWith('@@')) {
          pushCur();
          const anchor = s.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          continue;
        }
        if (s === '*** End of File') {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.eof = true;
          pushCur();
          continue;
        }
        if (s === '' || s[0] === ' ' || s[0] === '-' || s[0] === '+') {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.body.push({ k: s === '' ? ' ' : (s[0] as BodyLine['k']), text: s === '' ? '' : s.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${startLine + 2 + k}`);
      }
      pushCur();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine + 1}`);
      edits.push((tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const after = applyVChunks(before, chunks, strict, path);
        if (moveTo !== null) {
          tree.now.set(moveTo, after);
          tree.now.set(path, null);
          moves.push([path, moveTo]);
        } else {
          tree.now.set(path, after);
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** Apply V4A chunks in order with the cursor machine (SPEC.md section 8). */
function applyVChunks(before: string, chunks: VChunk[], strict: boolean, failPath: string): string {
  const f = splitFile(before);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const tier = findTier([ch.anchor], f.lines, cursor, strict);
      if (tier < 0) throw new Fail('no-match', failPath);
      const occs = occurrences([ch.anchor], f.lines, tier, cursor);
      cursor = occs[0]! + 1;
    }
    const { O, N, ctx } = bodyON(ch.body);
    if (O.length === 0) {
      const at = ch.eof ? f.lines.length : cursor;
      f.lines.splice(at, 0, ...N);
      cursor = at + N.length;
      continue;
    }
    const tier = findTier(O, f.lines, cursor, strict);
    if (tier < 0) throw new Fail('no-match', failPath);
    let occs = occurrences(O, f.lines, tier, cursor);
    if (ch.eof) occs = occs.filter((p) => p + O.length === f.lines.length);
    if (occs.length === 0) throw new Fail('no-match', failPath);
    const pos = occs[0]!;
    const repl = buildN(N, ctx, O, f.lines, pos, tier);
    f.lines.splice(pos, O.length, ...repl);
    cursor = pos + repl.length;
  }
  return joinFile(f);
}

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
  const moves: [string, string][] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, moves);
    else if (kind === 'search-replace') edits = parseSR(lines, strict);
    else if (kind === 'v4a') edits = parseV4A(lines, strict, moves);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: { key: string; text: string }[] = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [oldP, newP] of moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      usedOld.add(oldP);
      usedNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
