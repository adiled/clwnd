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

/**
 * Find an anchor in text and resolve its scope. Returns null if the
 * anchor doesn't match anything in the source.
 */
export function resolveScope(source: string, anchor: string, filePath: string): ScopeMatch | null {
  const ext = extname(filePath).toLowerCase();

  // Format-aware resolution first — these know their own structure.
  switch (ext) {
    case ".md": case ".mdx": case ".markdown":
      return resolveMarkdown(source, anchor);
    case ".env": case ".env.local": case ".env.development": case ".env.production":
      return resolveEnvLine(source, anchor);
    case ".json": case ".jsonc":
      return resolveJsonKey(source, anchor);
    case ".yaml": case ".yml":
      return resolveYamlKey(source, anchor);
    case ".toml":
      return resolveTomlSection(source, anchor);
    case ".ini": case ".cfg": case ".conf":
      return resolveIniSection(source, anchor);
  }

  // Also catch .env files that don't have a standard extension but the
  // filename starts with .env (e.g., .env.staging)
  const basename = filePath.split("/").pop() ?? "";
  if (basename.startsWith(".env")) {
    return resolveEnvLine(source, anchor);
  }

  // Generic fallback: find the anchor as a literal string and scope it
  // as a phrase (the line it appears on) or paragraph (if it looks like
  // a section header).
  return resolveGeneric(source, anchor);
}

// ─── Markdown ──────────────────────────────────────────────────────────────
// A heading is a paragraph anchor. Its scope runs from the heading line
// to just before the next heading of the same or higher level (or EOF).

function resolveMarkdown(source: string, anchor: string): ScopeMatch | null {
  // Is the anchor a heading pattern?
  const headingMatch = anchor.match(/^(#{1,6})\s+/);
  if (headingMatch) {
    const level = headingMatch[1].length;
    const idx = source.indexOf(anchor);
    if (idx === -1) return null;
    // Scope: from this heading to the next heading of same-or-higher level, or EOF
    const after = source.slice(idx + anchor.length);
    const peerPattern = new RegExp(`^#{1,${level}}\\s`, "m");
    const peerMatch = peerPattern.exec(after);
    const endIndex = peerMatch
      ? idx + anchor.length + peerMatch.index
      : source.length;
    // Trim trailing whitespace from the scope
    let end = endIndex;
    while (end > idx && (source[end - 1] === "\n" || source[end - 1] === "\r")) end--;
    // But keep one trailing newline for clean splicing
    if (end < source.length && source[end] === "\n") end++;
    return { startIndex: idx, endIndex: end, anchor, scope: "paragraph" };
  }

  // Not a heading — fall through to generic
  return resolveGeneric(source, anchor);
}

// ─── Env files ─────────────────────────────────────────────────────────────
// Each line is a phrase: KEY=value. The anchor is the key name.

function resolveEnvLine(source: string, anchor: string): ScopeMatch | null {
  // Match KEY= at start of line (possibly with export prefix)
  const pattern = new RegExp(`^(export\\s+)?${escapeRegex(anchor)}\\s*=`, "m");
  const match = pattern.exec(source);
  if (!match) return null;
  const startIndex = match.index;
  // Scope: the entire line (including the newline)
  const lineEnd = source.indexOf("\n", startIndex);
  const endIndex = lineEnd === -1 ? source.length : lineEnd + 1;
  return { startIndex, endIndex, anchor, scope: "phrase" };
}

// ─── JSON ──────────────────────────────────────────────────────────────────
// Target a key by its path (e.g., "dependencies.lodash" or "name").
// Scope: the key-value pair including trailing comma if present.

function resolveJsonKey(source: string, anchor: string): ScopeMatch | null {
  const parts = anchor.split(".");
  // Walk the JSON textually — find each key in sequence
  let searchFrom = 0;
  let lastKeyStart = -1;
  for (const part of parts) {
    // Find "key": pattern after searchFrom
    const keyPattern = new RegExp(`"${escapeRegex(part)}"\\s*:`);
    const rest = source.slice(searchFrom);
    const match = keyPattern.exec(rest);
    if (!match) return null;
    lastKeyStart = searchFrom + match.index;
    // Move past this key's colon to search for nested keys
    searchFrom = lastKeyStart + match[0].length;
  }
  if (lastKeyStart === -1) return null;
  // Now determine the value extent: from the key to the end of its value
  // Find the colon after the key
  const colonIdx = source.indexOf(":", lastKeyStart);
  if (colonIdx === -1) return null;
  // Skip whitespace after colon to find value start
  let valStart = colonIdx + 1;
  while (valStart < source.length && /\s/.test(source[valStart])) valStart++;
  // Determine value end based on its opening character
  const endIdx = findJsonValueEnd(source, valStart);
  if (endIdx === -1) return null;
  // Include trailing comma + whitespace
  let scopeEnd = endIdx;
  while (scopeEnd < source.length && /[\s,]/.test(source[scopeEnd])) {
    if (source[scopeEnd] === ",") { scopeEnd++; break; }
    scopeEnd++;
  }
  // Extend startIndex backward to include leading whitespace on the line
  let startIndex = lastKeyStart;
  while (startIndex > 0 && source[startIndex - 1] !== "\n") startIndex--;
  // Include the trailing newline if present
  if (scopeEnd < source.length && source[scopeEnd] === "\n") scopeEnd++;
  return { startIndex, endIndex: scopeEnd, anchor, scope: "phrase" };
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
// Target a key at the top level (e.g., "server" or "server.port").
// Scope: the key + its value block (everything indented under it).

function resolveYamlKey(source: string, anchor: string): ScopeMatch | null {
  const parts = anchor.split(".");
  let searchFrom = 0;
  let lastKeyStart = -1;
  let lastKeyIndent = 0;

  for (const part of parts) {
    const pattern = new RegExp(`^(\\s*)${escapeRegex(part)}\\s*:`, "m");
    const rest = source.slice(searchFrom);
    const match = pattern.exec(rest);
    if (!match) return null;
    lastKeyStart = searchFrom + match.index;
    lastKeyIndent = match[1].length;
    searchFrom = lastKeyStart + match[0].length;
  }
  if (lastKeyStart === -1) return null;

  // Scope: from this key's line to just before the next line at the same
  // or lesser indentation (the YAML "block" this key owns).
  const lineEnd = source.indexOf("\n", lastKeyStart);
  if (lineEnd === -1) return { startIndex: lastKeyStart, endIndex: source.length, anchor, scope: "paragraph" };
  let pos = lineEnd + 1;
  while (pos < source.length) {
    const nextNewline = source.indexOf("\n", pos);
    const line = nextNewline === -1 ? source.slice(pos) : source.slice(pos, nextNewline);
    // Blank lines or comment-only lines belong to the current block
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      pos = nextNewline === -1 ? source.length : nextNewline + 1;
      continue;
    }
    // Check indentation of this non-blank line
    const indent = line.length - line.trimStart().length;
    if (indent <= lastKeyIndent) break; // peer or parent — stop
    pos = nextNewline === -1 ? source.length : nextNewline + 1;
  }
  return { startIndex: lastKeyStart, endIndex: pos, anchor, scope: "paragraph" };
}

// ─── TOML ──────────────────────────────────────────────────────────────────
// Sections are [name] headers. Keys are name = value lines.

function resolveTomlSection(source: string, anchor: string): ScopeMatch | null {
  // Try as a section header first: [anchor] or [[anchor]]
  const sectionPattern = new RegExp(`^\\[\\[?${escapeRegex(anchor)}\\]\\]?`, "m");
  const sectionMatch = sectionPattern.exec(source);
  if (sectionMatch) {
    const startIndex = sectionMatch.index;
    // Scope until next section header or EOF
    const after = source.slice(startIndex + sectionMatch[0].length);
    const nextSection = /^\[/m.exec(after);
    const endIndex = nextSection
      ? startIndex + sectionMatch[0].length + nextSection.index
      : source.length;
    return { startIndex, endIndex, anchor, scope: "paragraph" };
  }
  // Try as a key: anchor = ...
  const keyPattern = new RegExp(`^\\s*${escapeRegex(anchor)}\\s*=`, "m");
  const keyMatch = keyPattern.exec(source);
  if (!keyMatch) return null;
  const startIndex = keyMatch.index;
  const lineEnd = source.indexOf("\n", startIndex);
  const endIndex = lineEnd === -1 ? source.length : lineEnd + 1;
  return { startIndex, endIndex, anchor, scope: "phrase" };
}

// ─── INI / conf ────────────────────────────────────────────────────────────

function resolveIniSection(source: string, anchor: string): ScopeMatch | null {
  // Same shape as TOML sections
  return resolveTomlSection(source, anchor);
}

// ─── Generic fallback ──────────────────────────────────────────────────────
// For unknown formats: find the anchor as a literal string. If it looks
// like a section header (starts a line, followed by content underneath
// at greater indentation or until a blank-line boundary), scope it as a
// paragraph. Otherwise scope it as the line it appears on (phrase).

function resolveGeneric(source: string, anchor: string): ScopeMatch | null {
  const idx = source.indexOf(anchor);
  if (idx === -1) return null;

  // Find the line this anchor is on
  let lineStart = idx;
  while (lineStart > 0 && source[lineStart - 1] !== "\n") lineStart--;
  let lineEnd = source.indexOf("\n", idx);
  if (lineEnd === -1) lineEnd = source.length;
  else lineEnd++; // include the newline

  // Is this anchor at the start of its line (a "header")?
  const isLineStart = idx === lineStart || source.slice(lineStart, idx).trim() === "";
  if (!isLineStart) {
    // Mid-line anchor: scope is just the line (phrase)
    return { startIndex: lineStart, endIndex: lineEnd, anchor, scope: "phrase" };
  }

  // Line-start anchor: check if subsequent lines are "owned" by it
  // (indented deeper, or non-blank before a blank-line boundary)
  let pos = lineEnd;
  const anchorIndent = idx - lineStart;
  while (pos < source.length) {
    const nextNl = source.indexOf("\n", pos);
    const line = nextNl === -1 ? source.slice(pos) : source.slice(pos, nextNl);
    if (line.trim() === "") {
      // Blank line: check if content continues after
      pos = nextNl === -1 ? source.length : nextNl + 1;
      // Peek at next non-blank line
      let peek = pos;
      while (peek < source.length && source.slice(peek, source.indexOf("\n", peek) === -1 ? source.length : source.indexOf("\n", peek)).trim() === "") {
        const nl = source.indexOf("\n", peek);
        peek = nl === -1 ? source.length : nl + 1;
      }
      if (peek >= source.length) break;
      const peekLine = source.slice(peek, source.indexOf("\n", peek) === -1 ? source.length : source.indexOf("\n", peek));
      const peekIndent = peekLine.length - peekLine.trimStart().length;
      if (peekIndent <= anchorIndent) break; // peer or parent
      pos = nextNl === -1 ? source.length : nextNl + 1;
      continue;
    }
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= anchorIndent) break;
    pos = nextNl === -1 ? source.length : nextNl + 1;
  }

  if (pos > lineEnd) {
    return { startIndex: lineStart, endIndex: pos, anchor, scope: "paragraph" };
  }
  return { startIndex: lineStart, endIndex: lineEnd, anchor, scope: "phrase" };
}

// ─── Util ──────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
