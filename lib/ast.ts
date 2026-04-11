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
  ".ts": "tree-sitter-typescript/typescript",
  ".tsx": "tree-sitter-typescript/tsx",
  ".js": "tree-sitter-javascript",
  ".jsx": "tree-sitter-javascript",
  ".py": "tree-sitter-python",
  ".go": "tree-sitter-go",
  ".rs": "tree-sitter-rust",
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
    const lang = mod.default ?? mod.typescript ?? mod.tsx ?? mod;
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
  function_declaration: "function",
  function_definition: "function", // Python
  arrow_function: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  class_definition: "class", // Python
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
  method_definition: "method",
  method_declaration: "method",
  public_field_definition: "property",
  property_declaration: "property",
  property_signature: "property",
  function_item: "function", // Rust
  struct_item: "struct", // Rust
  impl_item: "impl", // Rust
  enum_item: "enum", // Rust
  trait_item: "trait", // Rust
  function_type: "function", // Go
  method_declaration_go: "method", // Go (type_declaration contains methods)
};

/** Container types whose children we recurse into */
const CONTAINERS = new Set([
  "class_declaration", "class_definition", "class_body",
  "interface_declaration", "interface_body",
  "enum_declaration", "enum_body",
  "export_statement",
  "impl_item", // Rust
  "struct_item", // Rust
  "trait_item", // Rust
  "decorated_definition", // Python decorators
  "block", // Python class body
]);

function extractSymbols(node: any, depth = 0): Symbol[] {
  const symbols: Symbol[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const type = child.type as string;
    const kind = SYMBOL_TYPES[type];

    if (kind) {
      const nameNode = child.childForFieldName("name");
      const name = nameNode?.text ?? "anonymous";
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
    const tree = parser.parse(source);
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
