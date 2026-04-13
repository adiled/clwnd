/**
 * Linguistic scope resolution for non-code text.
 *
 * Non-code files don't have ASTs, but they do have linguistic structure:
 * words, phrases, sentences, paragraphs. Every text format humans write
 * is organized around these four units — headings, keys, sections, vars
 * are all just these primitives wearing format-specific costumes.
 *
 * This module finds an anchor in a text file by CONTENT (not position),
 * determines the scope that anchor governs (how much text it "owns"),
 * and returns the byte range for splicing. The addressing is linguistic,
 * not geometric — no line numbers, no byte offsets in the API. You say
 * WHAT you're looking at, clwnd figures out WHERE it is and how far it
 * extends.
 *
 * Scope hierarchy:
 *   word      → a single token (env var name, JSON key, YAML key)
 *   phrase    → anchor + its value (key=value, heading text, JSON pair)
 *   sentence  → a complete unit (a config block, a paragraph of prose)
 *   paragraph → anchor + everything it governs until the next peer
 *               (heading → until next same-or-higher heading, TOML
 *               section → until next section, etc.)
 *
 * The agent doesn't pick the scope level explicitly — the anchor text
 * itself implies the scope. `## Installation` is a paragraph anchor.
 * `DATABASE_URL` in an env file is a phrase anchor. clwnd infers.
 */

import { extname } from "path";

export interface ScopeMatch {
  /** 0-based byte offset of the scope start (inclusive). */
  startIndex: number;
  /** 0-based byte offset of the scope end (exclusive). */
  endIndex: number;
  /** What we matched — for diagnostics. */
  anchor: string;
  /** Inferred scope level. */
  scope: "word" | "phrase" | "sentence" | "paragraph";
}

export interface ScopeResult {
  match: ScopeMatch | null;
  /** Total number of matches found for this anchor (before disambiguation). */
  totalMatches: number;
  /** Error message when ambiguous or not found. */
  error?: string;
}

/**
 * Parse a target string like "## Setup" or "## Setup#2" into the anchor
 * text and a 1-based occurrence index. Same #N convention as do_code's
 * symbol disambiguation.
 */
function parseTarget(target: string): { anchor: string; occurrence: number } {
  const m = target.match(/^(.+)#(\d+)$/);
  if (m) return { anchor: m[1], occurrence: parseInt(m[2], 10) };
  return { anchor: target, occurrence: 1 };
}

/**
 * Pick the Nth match from an array. Returns a ScopeResult with either
 * the match or a clear error explaining ambiguity.
 */
function pickOccurrence(matches: ScopeMatch[], anchor: string, occurrence: number): ScopeResult {
  if (matches.length === 0) return { match: null, totalMatches: 0 };
  if (occurrence > matches.length) {
    return {
      match: null,
      totalMatches: matches.length,
      error: `'${anchor}' has ${matches.length} match(es) but you asked for #${occurrence}. Use #1 through #${matches.length}.`,
    };
  }
  if (matches.length > 1 && occurrence === 1) {
    // First match, but there are ambiguous duplicates. Still return it
    // (backward compat) but surface a warning in the anchor field so
    // the agent knows disambiguation is available.
    const m = { ...matches[0], anchor: `${anchor} (1 of ${matches.length} — use ${anchor}#N to disambiguate)` };
    return { match: m, totalMatches: matches.length };
  }
  return { match: matches[occurrence - 1], totalMatches: matches.length };
}

/**
 * Find an anchor in text and resolve its scope. Returns a ScopeResult
 * with the match, total match count, and an error if ambiguous.
 *
 * Supports #N disambiguation: "## Setup#2" targets the second ## Setup
 * heading. Bare "## Setup" targets the first (with a warning if there
 * are duplicates).
 */
/**
 * Word: space-delimited token. Format-agnostic. Find the exact token
 * bounded by word boundaries, replace it. The atomic linguistic unit.
 */
export function resolveWord(source: string, token: string): ScopeResult {
  const { anchor, occurrence } = parseTarget(token);
  const matches: ScopeMatch[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = source.indexOf(anchor, searchFrom);
    if (idx === -1) break;
    // Verify word boundaries — char before/after must not be part of the same token
    const before = idx > 0 ? source[idx - 1] : "\0";
    const after = idx + anchor.length < source.length ? source[idx + anchor.length] : "\0";
    const isTokenChar = (ch: string) => /[a-zA-Z0-9_]/.test(ch);
    if (!isTokenChar(before) && !isTokenChar(after)) {
      matches.push({ startIndex: idx, endIndex: idx + anchor.length, anchor, scope: "word" });
    }
    searchFrom = idx + anchor.length;
  }
  return pickOccurrence(matches, anchor, occurrence);
}

/**
 * Phrase: format-dispatched structural scope. Headings, key paths, env
 * vars, section headers — the format's natural phrase unit. Falls back
 * to exact substring match for unknown formats.
 */
export function resolvePhrase(source: string, target: string, filePath: string): ScopeResult {
  const { anchor, occurrence } = parseTarget(target);
  const ext = extname(filePath).toLowerCase();

  let finder: (s: string, a: string) => ScopeMatch[];

  switch (ext) {
    case ".md": case ".mdx": case ".markdown":
      finder = findAllMarkdown; break;
    case ".env": case ".env.local": case ".env.development": case ".env.production":
      finder = findAllEnv; break;
    case ".json": case ".jsonc":
      finder = findAllJson; break;
    case ".yaml": case ".yml":
      finder = findAllYaml; break;
    case ".toml":
      finder = findAllToml; break;
    case ".ini": case ".cfg": case ".conf":
      finder = findAllToml; break;
    default: {
      const basename = filePath.split("/").pop() ?? "";
      if (basename.startsWith(".env")) {
        finder = findAllEnv;
      } else {
        finder = findAllExactPhrase;
      }
    }
  }

  const matches = finder(source, anchor);
  return pickOccurrence(matches, anchor, occurrence);
}

/** Exact substring match — fallback phrase for unknown formats. */
function findAllExactPhrase(source: string, anchor: string): ScopeMatch[] {
  const matches: ScopeMatch[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = source.indexOf(anchor, searchFrom);
    if (idx === -1) break;
    matches.push({ startIndex: idx, endIndex: idx + anchor.length, anchor, scope: "phrase" });
    searchFrom = idx + anchor.length;
  }
  return matches;
}

// ─── Sentence: format-dispatched ──────────────────────────────────────────
// The smallest complete independent statement in each format.

export function resolveSentence(source: string, quoted: string, filePath: string): ScopeResult {
  const { anchor, occurrence } = parseTarget(quoted);
  const ext = extname(filePath).toLowerCase();
  const basename = filePath.split("/").pop() ?? "";

  let finder: (s: string, a: string) => ScopeMatch[];
  switch (ext) {
    case ".json": case ".jsonc": finder = findSentenceJson; break;
    case ".yaml": case ".yml":   finder = findSentenceYaml; break;
    case ".env": case ".toml": case ".ini": case ".cfg": case ".conf":
      finder = findSentenceLine; break;
    case ".md": case ".mdx": case ".markdown":
      finder = findSentenceLine; break;
    default:
      finder = basename.startsWith(".env") ? findSentenceLine : findSentenceBlankLine;
      break;
  }
  return pickOccurrence(finder(source, anchor), anchor, occurrence);
}

/** JSON sentence: comma-delimited entry. One key-value pair. */
function findSentenceJson(source: string, anchor: string): ScopeMatch[] {
  const matches: ScopeMatch[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = source.indexOf(anchor, searchFrom);
    if (idx === -1) break;
    // Expand backward to start of this entry (previous comma+newline, or opening brace)
    let start = idx;
    while (start > 0 && source[start - 1] !== "\n") start--;
    // Expand forward to end of entry (next comma+newline, or closing brace line)
    let end = idx + anchor.length;
    while (end < source.length && source[end] !== "\n") end++;
    if (end < source.length) end++; // include the newline
    matches.push({ startIndex: start, endIndex: end, anchor, scope: "sentence" });
    searchFrom = idx + anchor.length;
  }
  return matches;
}

/** YAML sentence: one sibling key-value at the same indent, plus any deeper children. */
function findSentenceYaml(source: string, anchor: string): ScopeMatch[] {
  const matches: ScopeMatch[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = source.indexOf(anchor, searchFrom);
    if (idx === -1) break;
    // Find the line containing the match
    let start = idx;
    while (start > 0 && source[start - 1] !== "\n") start--;
    const lineIndent = idx - start - (source.slice(start, idx).length - source.slice(start, idx).trimStart().length);
    const actualIndent = source.slice(start, idx).length - source.slice(start, idx).trimStart().length;
    // Expand forward: include lines indented deeper than this one
    let end = idx + anchor.length;
    while (end < source.length && source[end] !== "\n") end++;
    if (end < source.length) end++; // past the newline
    while (end < source.length) {
      const nextNewline = source.indexOf("\n", end);
      const line = nextNewline === -1 ? source.slice(end) : source.slice(end, nextNewline);
      if (line.trim() === "") break;
      const indent = line.length - line.trimStart().length;
      if (indent <= actualIndent) break;
      end = nextNewline === -1 ? source.length : nextNewline + 1;
    }
    matches.push({ startIndex: start, endIndex: end, anchor, scope: "sentence" });
    searchFrom = idx + anchor.length;
  }
  return matches;
}

/** Single-line sentence: env, toml keys, markdown lines within paragraphs. */
function findSentenceLine(source: string, anchor: string): ScopeMatch[] {
  const matches: ScopeMatch[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = source.indexOf(anchor, searchFrom);
    if (idx === -1) break;
    let start = idx;
    while (start > 0 && source[start - 1] !== "\n") start--;
    let end = idx + anchor.length;
    while (end < source.length && source[end] !== "\n") end++;
    if (end < source.length) end++; // include newline
    matches.push({ startIndex: start, endIndex: end, anchor, scope: "sentence" });
    searchFrom = idx + anchor.length;
  }
  return matches;
}

/** Generic sentence: collapses to blank-line expansion (= paragraph). */
function findSentenceBlankLine(source: string, anchor: string): ScopeMatch[] {
  return findParagraphBlankLine(source, anchor).map(m => ({ ...m, scope: "sentence" as const }));
}

// ─── Paragraph: format-dispatched ────────────────────────────────────────
// A group of related sentences. The largest sub-file unit.

export function resolveParagraph(source: string, quoted: string, filePath: string): ScopeResult {
  const { anchor, occurrence } = parseTarget(quoted);
  const ext = extname(filePath).toLowerCase();
  const basename = filePath.split("/").pop() ?? "";

  let finder: (s: string, a: string) => ScopeMatch[];
  switch (ext) {
    case ".json": case ".jsonc": finder = findParagraphJson; break;
    case ".yaml": case ".yml":   finder = findParagraphYaml; break;
    case ".toml": case ".ini": case ".cfg": case ".conf":
      finder = findParagraphToml; break;
    case ".env": finder = findParagraphEnv; break;
    case ".md": case ".mdx": case ".markdown":
      finder = findParagraphBlankLine; break;
    default:
      finder = basename.startsWith(".env") ? findParagraphEnv : findParagraphBlankLine;
      break;
  }
  return pickOccurrence(finder(source, anchor), anchor, occurrence);
}

/** JSON paragraph: find the innermost enclosing { } or [ ]. */
function findParagraphJson(source: string, anchor: string): ScopeMatch[] {
  const matches: ScopeMatch[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = source.indexOf(anchor, searchFrom);
    if (idx === -1) break;
    // Scan backward for nearest unmatched { or [
    let depth = 0;
    let start = idx;
    let inStr = false;
    for (let i = idx - 1; i >= 0; i--) {
      if (source[i] === '\\' && i > 0 && inStr) continue;
      if (source[i] === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (source[i] === '}' || source[i] === ']') depth++;
      if (source[i] === '{' || source[i] === '[') {
        if (depth === 0) { start = i; break; }
        depth--;
      }
    }
    // Scan forward for the matching close
    const end = findJsonValueEnd(source, start);
    if (end !== -1) {
      matches.push({ startIndex: start, endIndex: end, anchor, scope: "paragraph" });
    }
    searchFrom = idx + anchor.length;
  }
  return matches;
}

/** YAML paragraph: expand to parent indentation boundary. */
function findParagraphYaml(source: string, anchor: string): ScopeMatch[] {
  const matches: ScopeMatch[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = source.indexOf(anchor, searchFrom);
    if (idx === -1) break;
    // Find the line containing the match and its indentation
    let lineStart = idx;
    while (lineStart > 0 && source[lineStart - 1] !== "\n") lineStart--;
    const matchIndent = source.slice(lineStart, idx).length - source.slice(lineStart, idx).trimStart().length;
    // Find the parent: scan backward for a line with LESS indentation
    let start = lineStart;
    while (start > 0) {
      const prevNl = source.lastIndexOf("\n", start - 2);
      const prevLine = prevNl === -1 ? source.slice(0, start) : source.slice(prevNl + 1, start);
      if (prevLine.trim() === "") { start = prevNl === -1 ? 0 : prevNl + 1; continue; }
      const prevIndent = prevLine.length - prevLine.trimStart().length;
      if (prevIndent < matchIndent) { start = prevNl === -1 ? 0 : prevNl + 1; break; }
      start = prevNl === -1 ? 0 : prevNl + 1;
    }
    // Expand forward: include everything at greater indent than parent
    const parentIndent = matchIndent > 0 ? matchIndent - 2 : 0; // assume 2-space indent
    let end = idx + anchor.length;
    while (end < source.length && source[end] !== "\n") end++;
    if (end < source.length) end++;
    while (end < source.length) {
      const nextNl = source.indexOf("\n", end);
      const line = nextNl === -1 ? source.slice(end) : source.slice(end, nextNl);
      if (line.trim() === "") { end = nextNl === -1 ? source.length : nextNl + 1; continue; }
      const indent = line.length - line.trimStart().length;
      if (indent <= parentIndent) break;
      end = nextNl === -1 ? source.length : nextNl + 1;
    }
    matches.push({ startIndex: start, endIndex: end, anchor, scope: "paragraph" });
    searchFrom = idx + anchor.length;
  }
  return matches;
}

/** TOML paragraph: expand to [section] boundaries. */
function findParagraphToml(source: string, anchor: string): ScopeMatch[] {
  const matches: ScopeMatch[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = source.indexOf(anchor, searchFrom);
    if (idx === -1) break;
    // Scan backward for [section] header or BOF
    let start = idx;
    while (start > 0 && source[start - 1] !== "\n") start--;
    while (start > 0) {
      const prevNl = source.lastIndexOf("\n", start - 2);
      const prevLine = prevNl === -1 ? source.slice(0, start) : source.slice(prevNl + 1, start);
      if (prevLine.trimStart().startsWith("[")) { start = prevNl === -1 ? 0 : prevNl + 1; break; }
      start = prevNl === -1 ? 0 : prevNl + 1;
    }
    // Scan forward for next [section] header or EOF
    let end = idx + anchor.length;
    while (end < source.length && source[end] !== "\n") end++;
    if (end < source.length) end++;
    while (end < source.length) {
      const nextNl = source.indexOf("\n", end);
      const line = nextNl === -1 ? source.slice(end) : source.slice(end, nextNl);
      if (line.trimStart().startsWith("[")) break;
      end = nextNl === -1 ? source.length : nextNl + 1;
    }
    matches.push({ startIndex: start, endIndex: end, anchor, scope: "paragraph" });
    searchFrom = idx + anchor.length;
  }
  return matches;
}

/** Env paragraph: expand to blank line or # comment boundary. */
function findParagraphEnv(source: string, anchor: string): ScopeMatch[] {
  const matches: ScopeMatch[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = source.indexOf(anchor, searchFrom);
    if (idx === -1) break;
    let start = idx;
    while (start > 0 && source[start - 1] !== "\n") start--;
    while (start > 0) {
      const prevNl = source.lastIndexOf("\n", start - 2);
      const prevLine = prevNl === -1 ? source.slice(0, start) : source.slice(prevNl + 1, start);
      if (prevLine.trim() === "") break;
      start = prevNl === -1 ? 0 : prevNl + 1;
    }
    let end = idx + anchor.length;
    while (end < source.length && source[end] !== "\n") end++;
    if (end < source.length) end++;
    while (end < source.length) {
      const nextNl = source.indexOf("\n", end);
      const line = nextNl === -1 ? source.slice(end) : source.slice(end, nextNl);
      if (line.trim() === "") break;
      end = nextNl === -1 ? source.length : nextNl + 1;
    }
    matches.push({ startIndex: start, endIndex: end, anchor, scope: "paragraph" });
    searchFrom = idx + anchor.length;
  }
  return matches;
}

/** Blank-line paragraph: markdown, generic prose, unknown formats. */
function findParagraphBlankLine(source: string, anchor: string): ScopeMatch[] {
  const matches: ScopeMatch[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = source.indexOf(anchor, searchFrom);
    if (idx === -1) break;
    let start = idx;
    while (start > 0 && source[start - 1] !== "\n") start--;
    while (start > 0) {
      const prevNl = source.lastIndexOf("\n", start - 2);
      const prevLine = prevNl === -1 ? source.slice(0, start) : source.slice(prevNl + 1, start);
      if (prevLine.trim() === "") break;
      start = prevNl === -1 ? 0 : prevNl + 1;
    }
    let end = idx + anchor.length;
    while (end < source.length) {
      const nextNl = source.indexOf("\n", end);
      if (nextNl === -1) { end = source.length; break; }
      const lineAfter = nextNl + 1;
      if (lineAfter >= source.length) { end = source.length; break; }
      const peekEnd = source.indexOf("\n", lineAfter);
      const peekLine = peekEnd === -1 ? source.slice(lineAfter) : source.slice(lineAfter, peekEnd);
      if (peekLine.trim() === "") { end = lineAfter; break; }
      end = lineAfter;
    }
    matches.push({ startIndex: start, endIndex: end, anchor, scope: "paragraph" });
    searchFrom = idx + anchor.length;
  }
  return matches;
}

// ─── Markdown ──────────────────────────────────────────────────────────────

function findAllMarkdown(source: string, anchor: string): ScopeMatch[] {
  const headingMatch = anchor.match(/^(#{1,6})\s+/);
  if (!headingMatch) return findAllExactPhrase(source, anchor);
  const level = headingMatch[1].length;
  const matches: ScopeMatch[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = source.indexOf(anchor, searchFrom);
    if (idx === -1) break;
    // Scope: the BODY governed by this heading — everything AFTER the
    // heading line until the next peer-or-higher heading. The heading
    // itself (the word) stays; only its governed scope (the paragraph) moves.
    const headingLineEnd = source.indexOf("\n", idx);
    const bodyStart = headingLineEnd === -1 ? source.length : headingLineEnd + 1;
    const after = source.slice(bodyStart);
    const peerPattern = new RegExp(`^#{1,${level}}\\s`, "m");
    const peerMatch = peerPattern.exec(after);
    let endIndex = peerMatch ? bodyStart + peerMatch.index : source.length;
    // Trim trailing blank lines from the scope but keep one newline
    while (endIndex > bodyStart && (source[endIndex - 1] === "\n" || source[endIndex - 1] === "\r")) endIndex--;
    if (endIndex < source.length && source[endIndex] === "\n") endIndex++;
    matches.push({ startIndex: bodyStart, endIndex, anchor, scope: "paragraph" });
    searchFrom = bodyStart;
  }
  return matches;
}

// ─── Env files ─────────────────────────────────────────────────────────────

function findAllEnv(source: string, anchor: string): ScopeMatch[] {
  // Match KEY= at start of line — scope is the VALUE only (after =).
  // The word (KEY=) stays; the governed phrase (the value) gets replaced.
  const pattern = new RegExp(`^(export\\s+)?${escapeRegex(anchor)}\\s*=`, "gm");
  const matches: ScopeMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(source)) !== null) {
    const valStart = m.index + m[0].length;
    const lineEnd = source.indexOf("\n", valStart);
    const endIndex = lineEnd === -1 ? source.length : lineEnd;
    matches.push({ startIndex: valStart, endIndex, anchor, scope: "phrase" });
  }
  return matches.length > 0 ? matches : findAllExactPhrase(source, anchor);
}

// ─── JSON ──────────────────────────────────────────────────────────────────

function findAllJson(source: string, anchor: string): ScopeMatch[] {
  const result = resolveJsonKey(source, anchor);
  return result ? [result] : findAllExactPhrase(source, anchor);
}

function resolveJsonKey(source: string, anchor: string): ScopeMatch | null {
  const parts = anchor.split(".");
  // Walk the JSON textually — find each key in sequence.
  // Track matchEnd (past the regex match including colon) to avoid
  // finding colons INSIDE key names like "gemma3:4b".
  let searchFrom = 0;
  let lastMatchEnd = -1;
  for (const part of parts) {
    const keyPattern = new RegExp(`"${escapeRegex(part)}"\\s*:`);
    const rest = source.slice(searchFrom);
    const match = keyPattern.exec(rest);
    if (!match) return null;
    lastMatchEnd = searchFrom + match.index + match[0].length;
    searchFrom = lastMatchEnd;
  }
  if (lastMatchEnd === -1) return null;
  // Skip whitespace after the colon to find value start.
  // lastMatchEnd is right after "key": — the colon is already consumed
  // by the regex, so we won't hit an internal colon in the key name.
  let valStart = lastMatchEnd;
  while (valStart < source.length && /\s/.test(source[valStart])) valStart++;
  // Determine value end based on its opening character
  const endIdx = findJsonValueEnd(source, valStart);
  if (endIdx === -1) return null;
  // Scope is the VALUE only — the key is the address, not the content.
  // The user provides the replacement value; the key stays intact.
  return { startIndex: valStart, endIndex: endIdx, anchor, scope: "phrase" };
}

function findJsonValueEnd(source: string, start: number): number {
  if (start >= source.length) return -1;
  const ch = source[start];
  if (ch === '"') {
    // String: scan to closing unescaped quote
    let i = start + 1;
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue; }
      if (source[i] === '"') return i + 1;
      i++;
    }
    return -1;
  }
  if (ch === '{' || ch === '[') {
    // Object or array: count balanced braces/brackets
    const close = ch === '{' ? '}' : ']';
    let depth = 1;
    let i = start + 1;
    let inString = false;
    while (i < source.length && depth > 0) {
      if (source[i] === '\\' && inString) { i += 2; continue; }
      if (source[i] === '"') { inString = !inString; i++; continue; }
      if (!inString) {
        if (source[i] === ch) depth++;
        if (source[i] === close) depth--;
      }
      i++;
    }
    return depth === 0 ? i : -1;
  }
  // Primitive: number, boolean, null — read until comma, }, ], or newline
  let i = start;
  while (i < source.length && !/[,\}\]\n]/.test(source[i])) i++;
  return i;
}

// ─── YAML ──────────────────────────────────────────────────────────────────

function findAllYaml(source: string, anchor: string): ScopeMatch[] {
  const result = resolveYamlKey(source, anchor);
  return result ? [result] : findAllExactPhrase(source, anchor);
}

function resolveYamlKey(source: string, anchor: string): ScopeMatch | null {
  const parts = anchor.split(".");
  let searchFrom = 0;
  let lastKeyStart = -1;
  let lastKeyIndent = 0;
  let lastMatchEnd = -1;

  for (const part of parts) {
    const pattern = new RegExp(`^(\\s*)${escapeRegex(part)}\\s*:`, "m");
    const rest = source.slice(searchFrom);
    const match = pattern.exec(rest);
    if (!match) return null;
    lastKeyStart = searchFrom + match.index;
    lastKeyIndent = match[1].length;
    lastMatchEnd = lastKeyStart + match[0].length;
    searchFrom = lastMatchEnd;
  }
  if (lastKeyStart === -1) return null;

  // Scope is the VALUE only — the word (key:) stays.
  // Two shapes: scalar (key: value) or block (key:\n  children).
  const lineEnd = source.indexOf("\n", lastKeyStart);
  const restOfLine = lineEnd === -1
    ? source.slice(lastMatchEnd)
    : source.slice(lastMatchEnd, lineEnd);

  if (restOfLine.trim().length > 0) {
    // Scalar value on the same line: "key: value" → scope is " value"
    // Include the space after colon so replacement is clean
    const valStart = lastMatchEnd;
    const valEnd = lineEnd === -1 ? source.length : lineEnd;
    return { startIndex: valStart, endIndex: valEnd, anchor, scope: "phrase" };
  }

  // Block value: "key:\n  child: ..." → scope is the indented children
  if (lineEnd === -1) return { startIndex: source.length, endIndex: source.length, anchor, scope: "paragraph" };
  let pos = lineEnd + 1;
  while (pos < source.length) {
    const nextNewline = source.indexOf("\n", pos);
    const line = nextNewline === -1 ? source.slice(pos) : source.slice(pos, nextNewline);
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      pos = nextNewline === -1 ? source.length : nextNewline + 1;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= lastKeyIndent) break;
    pos = nextNewline === -1 ? source.length : nextNewline + 1;
  }
  return { startIndex: lineEnd + 1, endIndex: pos, anchor, scope: "paragraph" };
}

// ─── TOML ──────────────────────────────────────────────────────────────────

function findAllToml(source: string, anchor: string): ScopeMatch[] {
  const result = resolveTomlSection(source, anchor);
  return result ? [result] : findAllExactPhrase(source, anchor);
}

function resolveTomlSection(source: string, anchor: string): ScopeMatch | null {
  // Try as a section header first: [anchor] or [[anchor]]
  // Strip surrounding brackets if the user passed them (e.g. "[server]" → "server")
  const bare = anchor.replace(/^\[+/, "").replace(/\]+$/, "");
  const sectionPattern = new RegExp(`^\\[\\[?${escapeRegex(bare)}\\]\\]?`, "m");
  const sectionMatch = sectionPattern.exec(source);
  if (sectionMatch) {
    // Scope is the BODY after the section header — the header (word) stays.
    const headerEnd = source.indexOf("\n", sectionMatch.index);
    const bodyStart = headerEnd === -1 ? source.length : headerEnd + 1;
    const after = source.slice(bodyStart);
    const nextSection = /^\[/m.exec(after);
    const endIndex = nextSection ? bodyStart + nextSection.index : source.length;
    return { startIndex: bodyStart, endIndex, anchor, scope: "paragraph" };
  }
  // Try as a key: anchor = value → scope is the value only
  const keyPattern = new RegExp(`^\\s*${escapeRegex(anchor)}\\s*=\\s*`, "m");
  const keyMatch = keyPattern.exec(source);
  if (!keyMatch) return null;
  const valStart = keyMatch.index + keyMatch[0].length;
  const lineEnd = source.indexOf("\n", valStart);
  const endIndex = lineEnd === -1 ? source.length : lineEnd;
  return { startIndex: valStart, endIndex, anchor, scope: "phrase" };
}

// ─── INI / conf ────────────────────────────────────────────────────────────
// (uses findAllToml — same shape)

// ─── Generic fallback ──────────────────────────────────────────────────────

function findAllGeneric(source: string, anchor: string): ScopeMatch[] {
  const matches: ScopeMatch[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = source.indexOf(anchor, searchFrom);
    if (idx === -1) break;

    let lineStart = idx;
    while (lineStart > 0 && source[lineStart - 1] !== "\n") lineStart--;
    let lineEnd = source.indexOf("\n", idx);
    if (lineEnd === -1) lineEnd = source.length;
    else lineEnd++;

    const isLineStart = idx === lineStart || source.slice(lineStart, idx).trim() === "";
    if (!isLineStart) {
      matches.push({ startIndex: lineStart, endIndex: lineEnd, anchor, scope: "phrase" });
      searchFrom = lineEnd;
      continue;
    }

    // Line-start anchor: check for paragraph scope
    let pos = lineEnd;
    const anchorIndent = idx - lineStart;
    while (pos < source.length) {
      const nextNl = source.indexOf("\n", pos);
      const line = nextNl === -1 ? source.slice(pos) : source.slice(pos, nextNl);
      if (line.trim() === "") {
        pos = nextNl === -1 ? source.length : nextNl + 1;
        let peek = pos;
        while (peek < source.length) {
          const pnl = source.indexOf("\n", peek);
          const pl = pnl === -1 ? source.slice(peek) : source.slice(peek, pnl);
          if (pl.trim() !== "") break;
          peek = pnl === -1 ? source.length : pnl + 1;
        }
        if (peek >= source.length) break;
        const peekLine = source.slice(peek, source.indexOf("\n", peek) === -1 ? source.length : source.indexOf("\n", peek));
        if ((peekLine.length - peekLine.trimStart().length) <= anchorIndent) break;
        pos = nextNl === -1 ? source.length : nextNl + 1;
        continue;
      }
      if ((line.length - line.trimStart().length) <= anchorIndent) break;
      pos = nextNl === -1 ? source.length : nextNl + 1;
    }

    matches.push({
      startIndex: lineStart,
      endIndex: pos > lineEnd ? pos : lineEnd,
      anchor,
      scope: pos > lineEnd ? "paragraph" : "phrase",
    });
    searchFrom = matches[matches.length - 1].endIndex;
  }
  return matches;
}

// ═══════════════════════════════════════════════════════════════════════════
// Anchor discovery — the read side.
//
// resolveScope finds ONE anchor given by the caller. discoverAnchors
// finds ALL anchors in a file — the structural outline for non-code,
// parallel to fileSymbols for code. Called by read's studyTextFile path
// to show the agent what's targetable before they edit.
// ═══════════════════════════════════════════════════════════════════════════

export interface Anchor {
  /** The text that addresses this anchor in do_noncode target mode. */
  target: string;
  /** What kind of scope it governs. */
  scope: "phrase" | "paragraph";
  /** 1-based line number for display. */
  line: number;
  /** Nesting depth (0 = top-level, 1 = child, etc.) */
  depth: number;
}

/**
 * Discover all addressable anchors in a non-code file. Returns them in
 * source order. The agent can pass any anchor's `target` string to
 * do_noncode(target: ...) for precise editing.
 */
export function discoverAnchors(source: string, filePath: string): Anchor[] {
  const ext = extname(filePath).toLowerCase();
  const basename = filePath.split("/").pop() ?? "";

  if (ext === ".md" || ext === ".mdx" || ext === ".markdown") return discoverMarkdown(source);
  if (ext === ".json" || ext === ".jsonc") return discoverJson(source);
  if (ext === ".yaml" || ext === ".yml") return discoverYaml(source);
  if (ext === ".toml") return discoverToml(source);
  if (ext === ".ini" || ext === ".cfg" || ext === ".conf") return discoverToml(source);
  if (ext === ".env" || basename.startsWith(".env")) return discoverEnv(source);

  // Generic: look for indentation-based structure
  return discoverGeneric(source);
}

function lineNumber(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

function discoverMarkdown(source: string): Anchor[] {
  const anchors: Anchor[] = [];
  const re = /^(#{1,6})\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const level = m[1].length;
    anchors.push({
      target: m[0],
      scope: "paragraph",
      line: lineNumber(source, m.index),
      depth: level - 1,
    });
  }
  return anchors;
}

function discoverEnv(source: string): Anchor[] {
  const anchors: Anchor[] = [];
  const re = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    anchors.push({
      target: m[1],
      scope: "phrase",
      line: lineNumber(source, m.index),
      depth: 0,
    });
  }
  return anchors;
}

function discoverJson(source: string): Anchor[] {
  // Walk top-level and one-deep keys. Full recursive JSON walking is
  // overkill — the agent can drill deeper with read(file, pattern).
  const anchors: Anchor[] = [];
  try {
    const obj = JSON.parse(source);
    if (typeof obj !== "object" || obj === null) return anchors;
    // Find each key's line in the source for display
    for (const key of Object.keys(obj)) {
      const keyPattern = new RegExp(`"${escapeRegex(key)}"\\s*:`);
      const match = keyPattern.exec(source);
      const line = match ? lineNumber(source, match.index) : 0;
      anchors.push({ target: key, scope: "phrase", line, depth: 0 });
      // One level deep for objects
      const val = obj[key];
      if (val && typeof val === "object" && !Array.isArray(val)) {
        for (const subkey of Object.keys(val)) {
          const subPattern = new RegExp(`"${escapeRegex(subkey)}"\\s*:`);
          // Search after the parent key
          const subSource = match ? source.slice(match.index) : source;
          const subMatch = subPattern.exec(subSource);
          const subLine = subMatch ? lineNumber(source, (match?.index ?? 0) + subMatch.index) : 0;
          anchors.push({ target: `${key}.${subkey}`, scope: "phrase", line: subLine, depth: 1 });
        }
      }
    }
  } catch {
    // Invalid JSON — fall through to generic
    return discoverGeneric(source);
  }
  return anchors;
}

function discoverYaml(source: string): Anchor[] {
  const anchors: Anchor[] = [];
  const re = /^(\s*)([A-Za-z_][A-Za-z0-9_.-]*)\s*:/gm;
  let m: RegExpExecArray | null;
  const depthStack: number[] = []; // indent levels
  while ((m = re.exec(source)) !== null) {
    const indent = m[1].length;
    const key = m[2];
    // Determine depth from indentation
    while (depthStack.length > 0 && depthStack[depthStack.length - 1] >= indent) {
      depthStack.pop();
    }
    const depth = depthStack.length;
    depthStack.push(indent);
    // Build dot-path for nested keys
    // For the outline we show top-level and first-level only
    if (depth <= 1) {
      anchors.push({
        target: key,
        scope: indent === 0 ? "paragraph" : "phrase",
        line: lineNumber(source, m.index),
        depth,
      });
    }
  }
  return anchors;
}

function discoverToml(source: string): Anchor[] {
  const anchors: Anchor[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Section headers: [name] or [[name]]
    const sectionMatch = line.match(/^\[(\[)?([^\]]+)\]?\]/);
    if (sectionMatch) {
      anchors.push({
        target: `[${sectionMatch[2]}]`,
        scope: "paragraph",
        line: i + 1,
        depth: sectionMatch[1] ? 1 : 0, // [[]] is nested
      });
      continue;
    }
    // Top-level keys: key = value
    const keyMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=/);
    if (keyMatch) {
      anchors.push({
        target: keyMatch[1],
        scope: "phrase",
        line: i + 1,
        depth: 0,
      });
    }
  }
  return anchors;
}

function discoverGeneric(source: string): Anchor[] {
  // For unknown formats, look for lines that appear to be "headers" —
  // non-indented, non-blank lines that are followed by indented content
  // or that look like labels (end with : or are ALL CAPS etc.)
  const anchors: Anchor[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent > 0) continue; // skip indented lines
    // Does this line look like a header/label?
    const trimmed = line.trim();
    const isLabel = trimmed.endsWith(":") ||
      /^[A-Z][A-Z0-9_\s]{2,}$/.test(trimmed) || // ALL CAPS
      /^[-=#*]{3,}/.test(trimmed); // separator lines
    if (!isLabel) continue;
    anchors.push({
      target: trimmed,
      scope: "paragraph",
      line: i + 1,
      depth: 0,
    });
  }
  return anchors;
}

/**
 * Format discovered anchors as a compact outline string, parallel to
 * formatSymbols for code. Shows what the agent can target with
 * do_noncode(target: ...).
 */
export function formatAnchors(anchors: Anchor[]): string {
  if (anchors.length === 0) return "(no addressable anchors detected)";
  const lines: string[] = [];
  for (const a of anchors) {
    const pad = "  ".repeat(a.depth);
    lines.push(`${pad}${a.scope === "paragraph" ? "§" : "·"} ${a.target}  L${a.line}`);
  }
  return lines.join("\n");
}

// ─── Util ──────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
