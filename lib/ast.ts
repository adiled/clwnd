/**
 * AST-powered symbol extraction using tree-sitter.
 * Language-agnostic — grammars loaded per file extension.
 * Used by MCP tools for smart read (by symbol) and structured grep.
 */

import { readFileSync, statSync } from "fs";
import { extname } from "path";

// Lazy-loaded parser and languages
let Parser: any = null;
const languages = new Map<string, any>();

const EXT_TO_GRAMMAR: Record<string, string> = {
  // TypeScript / JavaScript
  ".ts": "tree-sitter-typescript/typescript",
  ".tsx": "tree-sitter-typescript/tsx",
  ".js": "tree-sitter-javascript",
  ".jsx": "tree-sitter-javascript",
  ".mjs": "tree-sitter-javascript",
  ".cjs": "tree-sitter-javascript",
  // Python
  ".py": "tree-sitter-python",
  ".pyi": "tree-sitter-python",
  // Go / Rust
  ".go": "tree-sitter-go",
  ".rs": "tree-sitter-rust",
  // Java
  ".java": "tree-sitter-java",
  // C
  ".c": "tree-sitter-c",
  ".h": "tree-sitter-c",
  // C++
  ".cc": "tree-sitter-cpp",
  ".cpp": "tree-sitter-cpp",
  ".cxx": "tree-sitter-cpp",
  ".hpp": "tree-sitter-cpp",
  ".hxx": "tree-sitter-cpp",
  // Ruby / PHP / C# — note php uses sub-export
  ".rb": "tree-sitter-ruby",
  ".php": "tree-sitter-php/php",
  ".cs": "tree-sitter-c-sharp",
  // Shell — bash grammar handles .sh and .bash. .zsh and .fish are too
  // divergent (zsh-only constructs throw parse errors in tree-sitter-bash)
  // so they fall through to do_code's text-only validation path.
  ".sh": "tree-sitter-bash",
  ".bash": "tree-sitter-bash",
};

function getParser(): any {
  if (!Parser) {
    Parser = require("tree-sitter");
  }
  return Parser;
}

function getLanguage(ext: string): any | null {
  if (languages.has(ext)) return languages.get(ext)!;
  const grammar = EXT_TO_GRAMMAR[ext];
  if (!grammar) return null;
  try {
    const mod = require(grammar);
    // Real tree-sitter grammar packages export an object with a `language`
    // property (the native binding). Some older wrappers used `.default` or
    // the module itself — accept both. This was broken for months because
    // `.default ?? .typescript ?? mod` fell through to the raw module
    // object, which parser.setLanguage silently rejected and every code
    // file then returned empty symbols.
    const lang = mod.language ?? mod.default?.language ?? mod.default ?? mod;
    languages.set(ext, lang);
    return lang;
  } catch {
    return null;
  }
}

export interface Symbol {
  name: string;
  kind: string; // function, class, method, interface, type, property, enum
  startLine: number;
  endLine: number;
  children?: Symbol[];
}

/** Node types that represent named symbols */
const SYMBOL_TYPES: Record<string, string> = {
  // ── TypeScript / JavaScript ────────────────────────────────────────────
  function_declaration: "function",
  arrow_function: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
  method_definition: "method",
  method_declaration: "method",
  public_field_definition: "property",
  property_declaration: "property",
  property_signature: "property",
  // ── Python ─────────────────────────────────────────────────────────────
  function_definition: "function", // also C, C++, PHP, Bash
  class_definition: "class",
  // ── Rust ───────────────────────────────────────────────────────────────
  function_item: "function",
  struct_item: "struct",
  impl_item: "impl",
  enum_item: "enum",
  trait_item: "trait",
  // ── Go ─────────────────────────────────────────────────────────────────
  function_type: "function",
  // ── Java / C# (also use class_declaration / method_declaration above) ──
  constructor_declaration: "constructor",
  // ── C / C++ ────────────────────────────────────────────────────────────
  // function_definition reused. struct/enum/union_specifier are C/C++.
  struct_specifier: "struct",
  enum_specifier: "enum",
  union_specifier: "union",
  type_definition: "type",
  class_specifier: "class", // C++
  namespace_definition: "namespace", // C++
  // ── C# ─────────────────────────────────────────────────────────────────
  namespace_declaration: "namespace",
  struct_declaration: "struct",
  // ── Ruby ───────────────────────────────────────────────────────────────
  // Ruby uses bare `class`, `module`, `method` as the AST node type names.
  method: "method",
  singleton_method: "method",
  class: "class",
  module: "module",
  // ── PHP ────────────────────────────────────────────────────────────────
  // function_definition / class_declaration / method_declaration reused.
  trait_declaration: "trait",
};

/** Container types whose children we recurse into */
const CONTAINERS = new Set([
  // TS/JS
  "class_declaration", "class_definition", "class_body",
  "interface_declaration", "interface_body",
  "enum_declaration", "enum_body",
  "export_statement",
  // Rust
  "impl_item", "struct_item", "trait_item",
  // Python
  "decorated_definition", "block",
  // Java / C# / PHP — declaration_list wraps members inside class/namespace
  "declaration_list",
  // C / C++ — field_declaration_list wraps struct/class members; namespace
  // and class specifiers themselves are also containers so their members
  // surface as nested children of the parent symbol.
  "field_declaration_list",
  "namespace_definition",
  "class_specifier",
  "struct_specifier",
  // C#
  "namespace_declaration",
  "struct_declaration",
  // Ruby — body_statement holds methods inside class/module; the bare
  // `class` and `module` node types are themselves containers because
  // their children include the methods.
  "body_statement", "class", "module",
  // PHP
  "trait_declaration",
]);

// Resolve a symbol's display name from a tree-sitter node. Most languages
// expose the name via a `name` field (childForFieldName("name")), so the
// fast path is a single lookup. C and C++ are the exception: their
// function_definition wraps the name inside a function_declarator (and
// possibly a pointer_declarator on top), so we walk the declarator chain
// down to the leaf identifier.
function getSymbolName(node: any): string | null {
  const direct = node.childForFieldName?.("name")?.text;
  if (direct) return direct;
  if (node.type === "function_definition") {
    // C / C++: function_definition.declarator → (pointer_declarator)? →
    // function_declarator → declarator → identifier
    let cur = node.childForFieldName?.("declarator");
    while (cur) {
      if (cur.type === "function_declarator") {
        cur = cur.childForFieldName?.("declarator") ?? null;
        continue;
      }
      if (cur.type === "pointer_declarator" || cur.type === "parenthesized_declarator") {
        cur = cur.childForFieldName?.("declarator") ?? null;
        continue;
      }
      if (cur.type === "identifier" || cur.type === "field_identifier") {
        return cur.text;
      }
      break;
    }
  }
  return null;
}

function extractSymbols(node: any, depth = 0): Symbol[] {
  const symbols: Symbol[] = [];
  // Iterate NAMED children only — `child(i)` / `childCount` includes
  // anonymous keyword tokens like `class`, `def`, `function`, `end`,
  // and Ruby's tree-sitter grammar happens to give the literal keyword
  // token the same type name as the wrapping node ("class"). With raw
  // childCount iteration, the keyword gets matched against SYMBOL_TYPES
  // and emits a phantom `class:anonymous` symbol inside every Ruby class.
  // namedChild() skips those tokens.
  const count = node.namedChildCount as number;
  for (let i = 0; i < count; i++) {
    const child = node.namedChild(i);
    const type = child.type as string;
    const kind = SYMBOL_TYPES[type];

    if (kind) {
      const name = getSymbolName(child);
      // Skip unnamed matches that aren't containers — they're usually
      // tree-sitter artifacts (anonymous structs, lambda bodies, etc.)
      // we don't want cluttering the outline.
      if (!name) {
        if (CONTAINERS.has(type)) {
          symbols.push(...extractSymbols(child, depth + 1));
        }
        continue;
      }
      const sym: Symbol = {
        name,
        kind,
        startLine: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
      };

      // Recurse into class/interface/enum bodies for members
      if (CONTAINERS.has(type)) {
        const children = extractSymbols(child, depth + 1);
        if (children.length > 0) sym.children = children;
      }

      symbols.push(sym);
    } else if (CONTAINERS.has(type)) {
      // Container without its own symbol (class_body, export_statement)
      symbols.push(...extractSymbols(child, depth + 1));
    }
  }
  return symbols;
}

/**
 * Extract all symbols from a file.
 * Returns null if the language isn't supported.
 */
const MAX_FILE_SIZE = 500 * 1024; // 500KB — skip huge files

// ─── Parsed-file cache ─────────────────────────────────────────────────────
// Every symbol query, source slice, and AST grep used to re-run readFileSync
// + tree-sitter parse + symbol extraction on every call. That's 2-5ms per
// file for a 1500-line TS source, paid on every repeat call. Cache the
// parsed result by absolute path and auto-invalidate on mtime change.
//
// Insertion order = LRU order (Map preserves it). Over AST_CACHE_MAX, drop
// the oldest. A cache hit refreshes the entry's position so hot files stick.
// Memory budget at 100 entries × ~50KB source + small symbol tree ≈ 5-6 MB.

interface AstCacheEntry {
  mtime: number;
  symbols: Symbol[];
  source: string;
}

const AST_CACHE_MAX = 100;
const astCache = new Map<string, AstCacheEntry>();

function cachedParse(filePath: string): AstCacheEntry | null {
  let stat;
  try { stat = statSync(filePath); } catch { return null; }
  if (stat.size > MAX_FILE_SIZE) return null;

  const mtime = stat.mtimeMs;
  const existing = astCache.get(filePath);
  if (existing && existing.mtime === mtime) {
    // LRU refresh: re-insert so this entry is "most recent"
    astCache.delete(filePath);
    astCache.set(filePath, existing);
    return existing;
  }

  const ext = extname(filePath).toLowerCase();
  const lang = getLanguage(ext);
  if (!lang) return null;

  let source: string;
  try { source = readFileSync(filePath, "utf-8"); } catch { return null; }

  try {
    const P = getParser();
    const parser = new P();
    parser.setLanguage(lang);
    // tree-sitter 0.21 default bufferSize trips on files over ~32KB and
    // throws "Invalid argument". We raise it to 1MB (plenty of headroom
    // and still bounded by MAX_FILE_SIZE above). Before this fix every
    // file larger than ~32KB silently returned null, so fileSymbols/
    // readSymbol/astGrep were all no-ops on anything non-trivial.
    const tree = parser.parse(source, null, { bufferSize: 1024 * 1024 });
    const symbols = extractSymbols(tree.rootNode);
    const entry: AstCacheEntry = { mtime, symbols, source };

    // Evict oldest if at cap
    if (astCache.size >= AST_CACHE_MAX) {
      const oldest = astCache.keys().next().value;
      if (oldest) astCache.delete(oldest);
    }
    astCache.set(filePath, entry);
    return entry;
  } catch {
    return null;
  }
}

export function fileSymbols(filePath: string): Symbol[] | null {
  return cachedParse(filePath)?.symbols ?? null;
}

/**
 * Validate that a string of source code parses without syntax errors.
 * Used by do_code to guard edits — we refuse to write content that would
 * produce a syntactically-invalid file. Returns { ok: true } on success,
 * { ok: false, error: "…" } with a short description on failure. Files
 * whose extension has no registered grammar pass through as { ok: true }
 * — we don't block unsupported languages, we just don't verify them.
 */
export function validateSyntax(filePath: string, source: string): { ok: true } | { ok: false; error: string } {
  const ext = extname(filePath).toLowerCase();
  const lang = getLanguage(ext);
  if (!lang) return { ok: true }; // unsupported language, skip validation
  try {
    const P = getParser();
    const parser = new P();
    parser.setLanguage(lang);
    const tree = parser.parse(source, null, { bufferSize: 1024 * 1024 });
    if (tree.rootNode.hasError) {
      // Find the first ERROR or MISSING node for a useful message.
      const cursor = tree.walk();
      const path: string[] = [];
      const visit = (): string | null => {
        const node = cursor.currentNode;
        if (node.type === "ERROR" || node.isMissing) {
          return `parse error at line ${node.startPosition.row + 1} col ${node.startPosition.column + 1}: ${node.type === "ERROR" ? "unexpected tokens" : `missing ${node.type}`}`;
        }
        if (cursor.gotoFirstChild()) {
          const r = visit();
          if (r) return r;
          cursor.gotoParent();
        }
        while (cursor.gotoNextSibling()) {
          const r = visit();
          if (r) return r;
        }
        return null;
      };
      const detail = visit() ?? "tree contains error nodes";
      return { ok: false, error: detail };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `parser threw: ${(e as Error).message}` };
  }
}

/**
 * Locate a symbol by dot-separated name and return its inclusive line range.
 * Used by do_code for splice-based symbol replacement. Unlike readSymbol
 * which returns the source text, this returns just the numeric range so
 * the caller can do line-based splicing without re-reading the file.
 */
export function symbolLineRange(filePath: string, symbolPath: string): { startLine: number; endLine: number } | null {
  const entry = cachedParse(filePath);
  if (!entry) return null;
  const parts = symbolPath.split(".");
  let current: Symbol[] = entry.symbols;
  let found: Symbol | null = null;
  for (const part of parts) {
    found = current.find(s => s.name === part) ?? null;
    if (!found) return null;
    current = found.children ?? [];
  }
  if (!found) return null;
  return { startLine: found.startLine, endLine: found.endLine };
}

/**
 * Find a specific symbol by name (dot-separated for nested: "Server.start").
 * Returns the source lines for that symbol, or null if not found.
 */
export function readSymbol(filePath: string, symbolPath: string): { source: string; startLine: number; endLine: number } | null {
  const entry = cachedParse(filePath);
  if (!entry) return null;

  const parts = symbolPath.split(".");
  let current: Symbol[] = entry.symbols;
  let found: Symbol | null = null;

  for (const part of parts) {
    found = current.find(s => s.name === part) ?? null;
    if (!found) return null;
    current = found.children ?? [];
  }

  if (!found) return null;

  const lines = entry.source.split("\n");
  const source = lines.slice(found.startLine - 1, found.endLine).map((l, i) => `${found!.startLine + i}\t${l}`).join("\n");
  return { source, startLine: found.startLine, endLine: found.endLine };
}

/**
 * Format symbols as a compact outline string.
 */
export function formatSymbols(symbols: Symbol[], indent = 0): string {
  const lines: string[] = [];
  for (const s of symbols) {
    const pad = "  ".repeat(indent);
    const range = s.startLine === s.endLine ? `L${s.startLine}` : `L${s.startLine}-${s.endLine}`;
    lines.push(`${pad}${s.kind} ${s.name} ${range}`);
    if (s.children) {
      lines.push(formatSymbols(s.children, indent + 1));
    }
  }
  return lines.join("\n");
}

/**
 * Check if a file extension is supported by tree-sitter.
 */
export function isSupported(filePath: string): boolean {
  return extname(filePath).toLowerCase() in EXT_TO_GRAMMAR;
}

/**
 * Fuzzy search symbols by name across a file.
 * Matches substrings case-insensitively. Returns matching symbols with context.
 */
export function searchSymbols(filePath: string, query: string): Symbol[] {
  const entry = cachedParse(filePath);
  if (!entry) return [];
  const q = query.toLowerCase();
  const results: Symbol[] = [];

  function search(syms: Symbol[], parentName = "") {
    for (const s of syms) {
      const fullName = parentName ? `${parentName}.${s.name}` : s.name;
      if (fullName.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)) {
        results.push({ ...s, name: fullName });
      }
      if (s.children) search(s.children, fullName);
    }
  }
  search(entry.symbols);
  return results;
}

// ─── AST Grep ─────────────────────────────────────────────────────────────

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
  symbol: string; // enclosing symbol name (e.g. "Server.start")
  kind: string;   // enclosing symbol kind (e.g. "method")
}

/**
 * Search a file for a pattern using tree-sitter AST context.
 * Returns matches with their enclosing symbol — not just line numbers.
 */
export function astGrep(filePath: string, pattern: string): GrepMatch[] {
  const entry = cachedParse(filePath);
  if (!entry) return [];

  const lines = entry.source.split("\n");
  const regex = new RegExp(pattern, "i");

  // Build symbol map: line → enclosing symbol
  const lineSymbol = new Map<number, { name: string; kind: string }>();

  function mapLines(syms: Symbol[], parentName = "") {
    for (const s of syms) {
      const fullName = parentName ? `${parentName}.${s.name}` : s.name;
      for (let l = s.startLine; l <= s.endLine; l++) {
        lineSymbol.set(l, { name: fullName, kind: s.kind });
      }
      if (s.children) mapLines(s.children, fullName);
    }
  }
  mapLines(entry.symbols);

  const matches: GrepMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      const lineNum = i + 1;
      const sym = lineSymbol.get(lineNum) ?? { name: "(top-level)", kind: "module" };
      matches.push({
        file: filePath,
        line: lineNum,
        text: lines[i],
        symbol: sym.name,
        kind: sym.kind,
      });
    }
  }
  return matches;
}

/**
 * Format AST grep matches — grouped by symbol for readability.
 */
export function formatGrepMatches(matches: GrepMatch[], relativeTo?: string): string {
  if (matches.length === 0) return "No matches found";

  // Group by file, then by symbol
  const byFile = new Map<string, Map<string, GrepMatch[]>>();
  for (const m of matches) {
    const file = relativeTo ? m.file.replace(relativeTo + "/", "") : m.file;
    if (!byFile.has(file)) byFile.set(file, new Map());
    const bySymbol = byFile.get(file)!;
    const key = `${m.kind} ${m.symbol}`;
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key)!.push(m);
  }

  const lines: string[] = [];
  for (const [file, bySymbol] of byFile) {
    lines.push(file);
    for (const [sym, matches] of bySymbol) {
      lines.push(`  ${sym}:`);
      for (const m of matches) {
        lines.push(`    ${m.line}: ${m.text.trim()}`);
      }
    }
  }
  return lines.join("\n");
}
