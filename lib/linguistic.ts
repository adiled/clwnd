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
export function resolveScope(source: string, target: string, filePath: string): ScopeResult {
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
        finder = findAllGeneric;
      }
    }
  }

  const matches = finder(source, anchor);
  return pickOccurrence(matches, anchor, occurrence);
}

// ─── Markdown ──────────────────────────────────────────────────────────────

function findAllMarkdown(source: string, anchor: string): ScopeMatch[] {
  const headingMatch = anchor.match(/^(#{1,6})\s+/);
  if (!headingMatch) return findAllGeneric(source, anchor);
  const level = headingMatch[1].length;
  const matches: ScopeMatch[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = source.indexOf(anchor, searchFrom);
    if (idx === -1) break;
    // Scope: from this heading to the next heading of same-or-higher level, or EOF
    const after = source.slice(idx + anchor.length);
    const peerPattern = new RegExp(`^#{1,${level}}\\s`, "m");
    const peerMatch = peerPattern.exec(after);
    let endIndex = peerMatch ? idx + anchor.length + peerMatch.index : source.length;
    while (endIndex > idx && (source[endIndex - 1] === "\n" || source[endIndex - 1] === "\r")) endIndex--;
    if (endIndex < source.length && source[endIndex] === "\n") endIndex++;
    matches.push({ startIndex: idx, endIndex, anchor, scope: "paragraph" });
    searchFrom = idx + anchor.length;
  }
  return matches;
}

// ─── Env files ─────────────────────────────────────────────────────────────

function findAllEnv(source: string, anchor: string): ScopeMatch[] {
  // Match KEY= at start of line — exact key match (word boundary after key name)
  const pattern = new RegExp(`^(export\\s+)?${escapeRegex(anchor)}\\s*=`, "gm");
  const matches: ScopeMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(source)) !== null) {
    const startIndex = m.index;
    const lineEnd = source.indexOf("\n", startIndex);
    const endIndex = lineEnd === -1 ? source.length : lineEnd + 1;
    matches.push({ startIndex, endIndex, anchor, scope: "phrase" });
  }
  return matches;
}

// ─── JSON ──────────────────────────────────────────────────────────────────

function findAllJson(source: string, anchor: string): ScopeMatch[] {
  const result = resolveJsonKey(source, anchor);
  return result ? [result] : [];
}

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

function findAllYaml(source: string, anchor: string): ScopeMatch[] {
  const result = resolveYamlKey(source, anchor);
  return result ? [result] : [];
}

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

function findAllToml(source: string, anchor: string): ScopeMatch[] {
  const result = resolveTomlSection(source, anchor);
  return result ? [result] : [];
}

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
