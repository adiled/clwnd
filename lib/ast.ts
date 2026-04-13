/**
 * AST-powered code analysis using tree-sitter Queries.
 *
 * Refactored from a hand-rolled SYMBOL_TYPES walker to the maintainer-blessed
 * Query API. Each grammar ships a `queries/tags.scm` file written by the
 * grammar author that captures definitions and references in S-expression
 * patterns — exactly what GitHub's code navigation uses. We load those at
 * runtime, compile them into tree-sitter Query objects, and run them
 * against parsed trees. The output gives us byte ranges, capture names,
 * and language-specific definition shapes for free.
 *
 * Two architectural shifts vs the previous version:
 *
 *   1. SYMBOLS — extracted via Query.matches() instead of an ad-hoc tree
 *      walker over a hand-maintained SYMBOL_TYPES dict. The dict was
 *      brittle (Ruby `class` keyword collision, missing struct/enum/union
 *      types per language, no constructor coverage, etc.) and only as
 *      good as I happened to remember to update it. Queries are owned by
 *      the grammar maintainer and cover their language's edge cases for us.
 *
 *   2. RANGES — symbols carry byte offsets (startIndex/endIndex) in
 *      addition to lines. do_code now splices by byte range instead of
 *      line range, which makes single-line code (`def f(): pass; def g(): pass`)
 *      safe to edit, and lets us extend a symbol's range to include
 *      leading comments / decorators / `export` wrappers without losing
 *      precision.
 */

import { readFileSync, statSync } from "fs";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

// Native addon packages (tree-sitter-*) are CJS with .node bindings.
// ESM `import` can't resolve their subpath exports. One createRequire
// to load them all — no gymnastics, just the standard Node interop.
const _require = createRequire(join(process.cwd(), "package.json"));

const Parser = _require("tree-sitter");
const TSTypescript = _require("tree-sitter-typescript/typescript");
const TSTsx = _require("tree-sitter-typescript/tsx");
const TSJavaScript = _require("tree-sitter-javascript");
const TSPython = _require("tree-sitter-python");
const TSGo = _require("tree-sitter-go");
const TSRust = _require("tree-sitter-rust");
const TSJava = _require("tree-sitter-java");
const TSC = _require("tree-sitter-c");
const TSCpp = _require("tree-sitter-cpp");
const TSRuby = _require("tree-sitter-ruby");
const TSPhp = _require("tree-sitter-php/php");
const TSCSharp = _require("tree-sitter-c-sharp");
const TSBash = _require("tree-sitter-bash");
const TSJson = _require("tree-sitter-json");

const languages = new Map<string, any>();
const queries = new Map<string, any>();

interface LanguageEntry {
  /**
   * Runtime: "native" uses node-tree-sitter, "wasm" uses web-tree-sitter.
   * WASM is the fallback for grammars that have no working native npm
   * package (vue). Default: native.
   */
  runtime?: "native" | "wasm";
  /** Pre-imported language object for native grammars. */
  language?: any;
  /** Path to the .wasm file for WASM grammars. Resolved relative to VENDORED_WASM_DIR. */
  wasmFile?: string;
  /**
   * tags.scm file paths (relative to node_modules) to compile into the
   * query for this language. Listed in order — JS+TS combine because TS
   * inherits from JS, and we extend a few with vendored extras.
   */
  queryPaths: string[];
  /** Optional vendored extra .scm in lib/queries/ that we add to the query. */
  vendoredExtra?: string;
  /**
   * Parent node types whose presence around a captured definition node
   * should EXPAND the symbol's byte range to cover them. Examples: a
   * Python class is wrapped in `decorated_definition` when it has any
   * decorators; a TypeScript class can be wrapped in `export_statement`.
   * Without expansion, replace would leave dangling decorators/`export`
   * keywords in front of the new code.
   */
  expandWrappers?: string[];
}

const EXT_TO_LANG: Record<string, LanguageEntry> = {
  ".ts":   { language: TSTypescript, queryPaths: ["tree-sitter-javascript/queries/tags.scm", "tree-sitter-typescript/queries/tags.scm"], expandWrappers: ["export_statement"] },
  ".tsx":  { language: TSTsx,        queryPaths: ["tree-sitter-javascript/queries/tags.scm", "tree-sitter-typescript/queries/tags.scm"], expandWrappers: ["export_statement"] },
  ".js":   { language: TSJavaScript, queryPaths: ["tree-sitter-javascript/queries/tags.scm"], expandWrappers: ["export_statement"] },
  ".jsx":  { language: TSJavaScript, queryPaths: ["tree-sitter-javascript/queries/tags.scm"], expandWrappers: ["export_statement"] },
  ".mjs":  { language: TSJavaScript, queryPaths: ["tree-sitter-javascript/queries/tags.scm"], expandWrappers: ["export_statement"] },
  ".cjs":  { language: TSJavaScript, queryPaths: ["tree-sitter-javascript/queries/tags.scm"], expandWrappers: ["export_statement"] },
  ".py":   { language: TSPython,     queryPaths: ["tree-sitter-python/queries/tags.scm"],     expandWrappers: ["decorated_definition"] },
  ".pyi":  { language: TSPython,     queryPaths: ["tree-sitter-python/queries/tags.scm"],     expandWrappers: ["decorated_definition"] },
  ".go":   { language: TSGo,         queryPaths: ["tree-sitter-go/queries/tags.scm"] },
  ".rs":   { language: TSRust,       queryPaths: ["tree-sitter-rust/queries/tags.scm"] },
  ".java": { language: TSJava,       queryPaths: ["tree-sitter-java/queries/tags.scm"], vendoredExtra: "java.scm" },
  ".c":    { language: TSC,          queryPaths: ["tree-sitter-c/queries/tags.scm"] },
  ".h":    { language: TSC,          queryPaths: ["tree-sitter-c/queries/tags.scm"] },
  ".cc":   { language: TSCpp,        queryPaths: ["tree-sitter-cpp/queries/tags.scm"], vendoredExtra: "cpp.scm" },
  ".cpp":  { language: TSCpp,        queryPaths: ["tree-sitter-cpp/queries/tags.scm"], vendoredExtra: "cpp.scm" },
  ".cxx":  { language: TSCpp,        queryPaths: ["tree-sitter-cpp/queries/tags.scm"], vendoredExtra: "cpp.scm" },
  ".hpp":  { language: TSCpp,        queryPaths: ["tree-sitter-cpp/queries/tags.scm"], vendoredExtra: "cpp.scm" },
  ".hxx":  { language: TSCpp,        queryPaths: ["tree-sitter-cpp/queries/tags.scm"], vendoredExtra: "cpp.scm" },
  ".rb":   { language: TSRuby,       queryPaths: ["tree-sitter-ruby/queries/tags.scm"] },
  ".php":  { language: TSPhp,        queryPaths: ["tree-sitter-php/queries/tags.scm"] },
  ".cs":   { language: TSCSharp,     queryPaths: ["tree-sitter-c-sharp/queries/tags.scm"] },
  ".sh":   { language: TSBash,       queryPaths: [], vendoredExtra: "bash.scm" },
  ".bash": { language: TSBash,       queryPaths: [], vendoredExtra: "bash.scm" },
  // JSON handled by config-ast.ts for do_noncode, not code symbols
  ".vue":  { runtime: "wasm", wasmFile: "tree-sitter-vue.wasm", queryPaths: [], vendoredExtra: "vue.scm" },
};

// Locate vendored query files at runtime. We try a few candidate paths
// because the source layout (lib/queries/) doesn't match the bundled
// layout (dist/daemon/queries/) and we want both dev mode (running .ts
// directly via tsx) and via rsync-deployed source.
//
// The dev script rsyncs these to the target.
// dist/daemon/queries/, so the first candidate hits in production. The
// second candidate covers running .ts source directly. The third is a
// safety net in case the daemon was bundled but onSuccess didn't run.
import { existsSync } from "fs";
const HERE = dirname(fileURLToPath(import.meta.url));
function findVendoredQueryDir(): string {
  const candidates = [
    join(HERE, "queries"),               // lib/queries (dev)
    join(HERE, "..", "lib", "queries"),  // dist/daemon → ../lib/queries (fallback)
    join(HERE, "..", "..", "lib", "queries"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Last resort: return the first candidate so reads fail loudly with a
  // useful path in the error, instead of silently swallowing the lookup.
  return candidates[0];
}
const VENDORED_QUERY_DIR = findVendoredQueryDir();

function findVendoredWasmDir(): string {
  const candidates = [
    join(HERE, "wasm"),                  // lib/wasm (dev)
    join(HERE, "..", "lib", "wasm"),     // dist/daemon → ../lib/wasm (fallback)
    join(HERE, "..", "..", "lib", "wasm"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}
const VENDORED_WASM_DIR = findVendoredWasmDir();

// ─── WASM runtime (web-tree-sitter) ───────────────────────────────────────
// Secondary parser runtime for grammars that have no native npm package
// (vue, eventually sql). Loaded lazily — the require("web-tree-sitter")
// only fires the first time a .vue file is encountered. Native grammars
// never touch this code path.
let WasmParser: any = null;
let wasmInitialized = false;

async function getWasmParser(): Promise<any> {
  if (!WasmParser) {
    const mod = await import("web-tree-sitter");
    WasmParser = mod.default?.Parser ?? mod.Parser ?? mod.default ?? mod;
  }
  if (!wasmInitialized && typeof WasmParser.init === "function") {
    await WasmParser.init();
    wasmInitialized = true;
  }
  return WasmParser;
}

async function getWasmLanguage(ext: string): Promise<any | null> {
  if (languages.has(ext)) return languages.get(ext)!;
  const entry = EXT_TO_LANG[ext];
  if (!entry?.wasmFile) return null;
  try {
    const WP = await getWasmParser();
    const WLanguage = WP.Language;
    const wasmPath = join(VENDORED_WASM_DIR, entry.wasmFile);
    const lang = await WLanguage.load(wasmPath);
    languages.set(ext, lang);
    return lang;
  } catch (e) {
    process.stderr.write?.(`[clwnd] failed to load WASM grammar for ${ext}: ${(e as Error).message}\n`);
    return null;
  }
}

// ─── Native runtime (node-tree-sitter) ────────────────────────────────────

function getParser(): any {
  return Parser;
}

function getLanguage(ext: string): any | null {
  if (languages.has(ext)) return languages.get(ext)!;
  const entry = EXT_TO_LANG[ext];
  if (!entry || entry.runtime === "wasm") return null;
  if (!entry.language) return null;
  languages.set(ext, entry.language);
  return entry.language;
}

// Strip directive predicates (`#xxx!`) from a .scm source. node-tree-sitter
// at our pinned host (0.21.1) only knows filter predicates ending in `?`
// (#eq?, #not-eq?, #match?, #not-match?, #any-of?). Directives like
// #strip!, #set-adjacent!, #select-adjacent! are post-processing hints
// used by the `tree-sitter tags` CLI for cosmetic comment stripping; the
// query engine raises "Unknown query predicate" if they're present.
// We don't need them for symbol extraction — we associate doc comments
// ourselves via tree walks below.
function stripDirectives(scm: string): string {
  return scm.replace(/\(#[a-z-]+![^)]*\)/g, "");
}

function loadQueryScm(entry: LanguageEntry): string {
  const parts: string[] = [];
  for (const rel of entry.queryPaths) {
    const p = _require.resolve(rel);
    parts.push(stripDirectives(readFileSync(p, "utf-8")));
  }
  if (entry.vendoredExtra) {
    const p = join(VENDORED_QUERY_DIR, entry.vendoredExtra);
    parts.push(stripDirectives(readFileSync(p, "utf-8")));
  }
  return parts.join("\n");
}

function getQuery(ext: string): any | null {
  if (queries.has(ext)) return queries.get(ext)!;
  const entry = EXT_TO_LANG[ext];
  if (!entry || entry.runtime === "wasm") return null; // WASM queries compiled via async path
  const lang = getLanguage(ext);
  if (!lang) return null;
  try {
    const scm = loadQueryScm(entry);
    const P = getParser();
    const q = new P.Query(lang, scm);
    queries.set(ext, q);
    return q;
  } catch (e) {
    process.stderr.write?.(`[clwnd] failed to compile query for ${ext}: ${(e as Error).message}\n`);
    queries.set(ext, null);
    return null;
  }
}

async function getWasmQuery(ext: string): Promise<any | null> {
  if (queries.has(ext)) return queries.get(ext)!;
  const entry = EXT_TO_LANG[ext];
  if (!entry) return null;
  const lang = await getWasmLanguage(ext);
  if (!lang) return null;
  try {
    const scm = loadQueryScm(entry);
    // web-tree-sitter@0.25: new Query(language, source)
    const wmod = await import("web-tree-sitter");
    const WQuery = (wmod.default ?? wmod).Query;
    const q = new WQuery(lang, scm);
    queries.set(ext, q);
    return q;
  } catch (e) {
    process.stderr.write?.(`[clwnd] failed to compile WASM query for ${ext}: ${(e as Error).message}\n`);
    queries.set(ext, null);
    return null;
  }
}

// ─── Public types ───────────────────────────────────────────────────────────

export interface Symbol {
  name: string;
  /**
   * Definition kind from the @definition.X capture (function, method,
   * class, interface, type, namespace, module, macro, constant, …).
   * Whatever the language's tags.scm calls it.
   */
  kind: string;
  /** 1-based inclusive line range, kept for display + legacy callers. */
  startLine: number;
  endLine: number;
  /** 0-based byte offsets — primary range used for splicing edits. */
  startIndex: number;
  endIndex: number;
  children?: Symbol[];
}

// ─── Parsed-file cache ─────────────────────────────────────────────────────
//
// Avoid re-parsing the same file every time fileSymbols / readSymbol /
// astGrep is called. Keyed by absolute path, invalidated on mtime change.
// LRU eviction at AST_CACHE_MAX entries.

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB — was 500KB, lifted because
                                        // tree-sitter handles megabytes
                                        // fine and real codebases have
                                        // generated files past 500KB.

interface AstCacheEntry {
  mtime: number;
  symbols: Symbol[];
  source: string;
}

const AST_CACHE_MAX = 100;
const astCache = new Map<string, AstCacheEntry>();

function cacheStore(filePath: string, mtime: number, symbols: Symbol[], source: string): AstCacheEntry {
  const entry: AstCacheEntry = { mtime, symbols, source };
  if (astCache.size >= AST_CACHE_MAX) {
    const oldest = astCache.keys().next().value;
    if (oldest) astCache.delete(oldest);
  }
  astCache.set(filePath, entry);
  return entry;
}

function cacheHit(filePath: string): AstCacheEntry | null {
  let stat;
  try { stat = statSync(filePath); } catch { return null; }
  if (stat.size > MAX_FILE_SIZE) return null;
  const existing = astCache.get(filePath);
  if (existing && existing.mtime === stat.mtimeMs) {
    astCache.delete(filePath);
    astCache.set(filePath, existing);
    return existing;
  }
  return null;
}

function cachedParse(filePath: string): AstCacheEntry | null {
  const hit = cacheHit(filePath);
  if (hit) return hit;

  const ext = extname(filePath).toLowerCase();
  const entry = EXT_TO_LANG[ext];
  if (!entry) return null;
  if (entry.runtime === "wasm") return null; // WASM handled by async path

  const lang = getLanguage(ext);
  const query = getQuery(ext);
  if (!lang || !query) return null;

  let source: string;
  try { source = readFileSync(filePath, "utf-8"); } catch { return null; }

  try {
    const stat = statSync(filePath);
    const P = getParser();
    const parser = new P();
    parser.setLanguage(lang);
    const tree = parser.parse(source, null, { bufferSize: 4 * 1024 * 1024 });
    const symbols = extractSymbolsViaQuery(tree.rootNode, query, entry);
    return cacheStore(filePath, stat.mtimeMs, symbols, source);
  } catch {
    return null;
  }
}

/**
 * Async variant of cachedParse for WASM grammars. Falls through to the
 * sync native path for non-WASM extensions so callers can always use this.
 */
async function cachedParseAsync(filePath: string): Promise<AstCacheEntry | null> {
  const hit = cacheHit(filePath);
  if (hit) return hit;

  const ext = extname(filePath).toLowerCase();
  const langEntry = EXT_TO_LANG[ext];
  if (!langEntry) return null;

  // Non-WASM: delegate to sync path
  if (langEntry.runtime !== "wasm") return cachedParse(filePath);

  // WASM: async load
  const lang = await getWasmLanguage(ext);
  const query = await getWasmQuery(ext);
  if (!lang || !query) return null;

  let source: string;
  try { source = readFileSync(filePath, "utf-8"); } catch { return null; }

  try {
    const stat = statSync(filePath);
    const WP = await getWasmParser();
    const parser = new WP();
    parser.setLanguage(lang);
    const tree = parser.parse(source);
    const symbols = extractSymbolsViaQuery(tree.rootNode, query, langEntry);
    return cacheStore(filePath, stat.mtimeMs, symbols, source);
  } catch (e) {
    process.stderr.write?.(`[clwnd] WASM parse failed for ${filePath}: ${(e as Error).message}\n`);
    return null;
  }
}

// ─── Query-driven symbol extraction ─────────────────────────────────────────
//
// 1. Run the language's compiled tags.scm Query against the parsed tree.
// 2. For each match, find the @definition.X capture (the symbol's node)
//    and the @name capture (the identifier).
// 3. Walk parent wrappers if the language registers any (Python's
//    decorated_definition, TS's export_statement) so the byte range
//    covers the decorators / `export` keyword.
// 4. Walk preceding adjacent comment siblings to extend the start of the
//    range backward — leading JSDoc / Go-style doc comments / Python
//    block comments above a function become part of its symbol range,
//    so do_code's replace operation doesn't strand them.
// 5. Sort matches by (startIndex asc, endIndex desc) and reconstruct
//    parent/child nesting from byte-range containment. Two matches with
//    the same start come out parent-first because the parent has the
//    larger endIndex.
// 6. Dedupe identical (startIndex, endIndex, name) symbols — some
//    grammars match the same node from multiple patterns (e.g., a Rust
//    method captured as both definition.function and definition.method
//    via the impl-block pattern).

function expandWithWrappers(node: any, wrappers?: string[]): any {
  if (!wrappers || wrappers.length === 0) return node;
  let cur = node;
  // Walk up while the parent is a registered wrapper. We move OUTWARD,
  // not inward — the symbol's effective root is the outermost wrapper.
  while (cur.parent && wrappers.includes(cur.parent.type)) {
    cur = cur.parent;
  }
  return cur;
}

function expandForLeadingComments(node: any): { startIndex: number; startLine: number } {
  // Walk previousNamedSibling chain back through `comment` nodes that are
  // immediately adjacent (no blank line between them and the current
  // start). Returns the new start index/line. Handles JSDoc, Go-style
  // // comments, Python block comments above a def, etc. The comment
  // node's text isn't transformed — we just include its bytes in the
  // symbol range so an edit/delete preserves or removes the doc together
  // with the symbol.
  let cur = node;
  let startIndex = node.startIndex as number;
  let startLine = (node.startPosition.row as number) + 1;
  while (true) {
    const prev = cur.previousNamedSibling;
    if (!prev) break;
    if (prev.type !== "comment") break;
    // Adjacent if the comment ends on the line immediately above (or
    // same line as) the current start. One blank line between is allowed
    // for JSDoc-style separation; two blank lines means it's a different
    // section.
    const commentEndLine = (prev.endPosition.row as number) + 1;
    const gap = startLine - commentEndLine;
    if (gap > 2) break;
    startIndex = prev.startIndex as number;
    startLine = (prev.startPosition.row as number) + 1;
    cur = prev;
  }
  return { startIndex, startLine };
}

function extractSymbolsViaQuery(rootNode: any, query: any, langEntry: LanguageEntry): Symbol[] {
  const matches = query.matches(rootNode);
  // Flat list of {node, kind, name, startIndex, endIndex, startLine, endLine}.
  // We post-process into a tree by byte-range containment.
  type Hit = {
    node: any;
    kind: string;
    name: string;
    startIndex: number;
    endIndex: number;
    startLine: number;
    endLine: number;
  };
  const hits: Hit[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    let defCapture: any = null;
    let nameCapture: any = null;
    let kind = "";
    for (const cap of match.captures) {
      if (cap.name.startsWith("definition.")) {
        defCapture = cap;
        kind = cap.name.slice("definition.".length);
      } else if (cap.name === "name") {
        nameCapture = cap;
      }
    }
    if (!defCapture || !nameCapture) continue;
    const expandedRoot = expandWithWrappers(defCapture.node, langEntry.expandWrappers);
    const { startIndex, startLine } = expandForLeadingComments(expandedRoot);
    const endIndex = expandedRoot.endIndex as number;
    const endLine = (expandedRoot.endPosition.row as number) + 1;
    const name = nameCapture.node.text as string;
    const dedupKey = `${startIndex}:${endIndex}:${name}:${kind}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    hits.push({ node: expandedRoot, kind, name, startIndex, endIndex, startLine, endLine });
  }

  // Sort: outer first (smaller startIndex, then larger endIndex breaks ties).
  hits.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);

  // Build tree by containment. A hit is a child of the topmost ancestor
  // whose range strictly contains it.
  const top: Symbol[] = [];
  type StackEntry = { hit: Hit; sym: Symbol };
  const stack: StackEntry[] = [];
  for (const hit of hits) {
    const sym: Symbol = {
      name: hit.name,
      kind: hit.kind,
      startLine: hit.startLine,
      endLine: hit.endLine,
      startIndex: hit.startIndex,
      endIndex: hit.endIndex,
    };
    // Pop ancestors that don't contain this hit.
    while (stack.length > 0 && stack[stack.length - 1].hit.endIndex <= hit.startIndex) {
      stack.pop();
    }
    if (stack.length === 0) {
      top.push(sym);
    } else {
      const parent = stack[stack.length - 1].sym;
      if (!parent.children) parent.children = [];
      parent.children.push(sym);
    }
    stack.push({ hit, sym });
  }
  return top;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function fileSymbols(filePath: string): Symbol[] | null {
  return cachedParse(filePath)?.symbols ?? null;
}

/** Async variant — handles both native and WASM grammars. */
export async function fileSymbolsAsync(filePath: string): Promise<Symbol[] | null> {
  const entry = await cachedParseAsync(filePath);
  return entry?.symbols ?? null;
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
  if (!lang) return { ok: true };
  try {
    const P = getParser();
    const parser = new P();
    parser.setLanguage(lang);
    const tree = parser.parse(source, null, { bufferSize: 4 * 1024 * 1024 });
    if (tree.rootNode.hasError) {
      // Walk the tree for the first ERROR or MISSING node and surface its
      // location. tree-sitter is error-recovering — `parse()` almost
      // never throws — so the only meaningful syntax check is hasError +
      // a walk for the offending node.
      const cursor = tree.walk();
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
 * Kept for legacy callers that work in line space. Prefer symbolByteRange
 * for new code — line-based splicing is unsafe on single-line constructs.
 */
export function symbolLineRange(filePath: string, symbolPath: string): { startLine: number; endLine: number } | null {
  const found = findSymbol(filePath, symbolPath);
  if (!found) return null;
  return { startLine: found.startLine, endLine: found.endLine };
}

/**
 * Locate a symbol and return its byte range. This is the primary lookup
 * for do_code splicing — operating in byte space instead of line space
 * means single-line constructs (`def f(): pass; def g(): pass`), trailing
 * inline comments, and unusual whitespace all work correctly.
 */
export function symbolByteRange(filePath: string, symbolPath: string): { startIndex: number; endIndex: number; startLine: number; endLine: number } | null {
  const found = findSymbol(filePath, symbolPath);
  if (!found) return null;
  return { startIndex: found.startIndex, endIndex: found.endIndex, startLine: found.startLine, endLine: found.endLine };
}

/**
 * Parse a symbol path segment like "foo" or "foo#2" into a name and a
 * 1-based occurrence index. Bare "foo" defaults to occurrence 1.
 *
 * The #N disambiguation syntax lets agents address the Nth same-named
 * symbol at a given scope level — C++ overloads, Python re-definitions,
 * Ruby reopened classes, etc. formatSymbols annotates the outline with
 * the suffix when duplicates exist, so the agent sees exactly what to
 * pass to do_code.
 */
function parseSegment(seg: string): { name: string; occurrence: number } {
  const m = seg.match(/^(.+)#(\d+)$/);
  if (m) return { name: m[1], occurrence: parseInt(m[2], 10) };
  return { name: seg, occurrence: 1 };
}

function findSymbol(filePath: string, symbolPath: string): Symbol | null {
  const entry = cachedParse(filePath);
  if (!entry) return null;
  const parts = symbolPath.split(".");
  let current: Symbol[] = entry.symbols;
  let found: Symbol | null = null;
  for (const rawPart of parts) {
    const { name, occurrence } = parseSegment(rawPart);
    // Find the Nth symbol with this name at the current scope level.
    let count = 0;
    found = null;
    for (const s of current) {
      if (s.name === name) {
        count++;
        if (count === occurrence) { found = s; break; }
      }
    }
    if (!found) return null;
    current = found.children ?? [];
  }
  return found;
}

/**
 * Find a specific symbol by name (dot-separated for nested: "Server.start").
 * Returns the source lines for that symbol with line-number prefixes.
 */
export function readSymbol(filePath: string, symbolPath: string): { source: string; startLine: number; endLine: number } | null {
  const entry = cachedParse(filePath);
  if (!entry) return null;
  const found = findSymbol(filePath, symbolPath);
  if (!found) return null;

  const lines = entry.source.split("\n");
  const source = lines.slice(found.startLine - 1, found.endLine).map((l, i) => `${found.startLine + i}\t${l}`).join("\n");
  return { source, startLine: found.startLine, endLine: found.endLine };
}

/**
 * Format symbols as a compact outline string. When the same name appears
 * more than once at the same scope level (C++ overloads, Python re-defs,
 * etc.), the second and subsequent occurrences get a `#N` suffix so the
 * agent knows to pass e.g. `do_code(symbol: "foo#2")` to address them.
 */
export function formatSymbols(symbols: Symbol[], indent = 0): string {
  // Count occurrences per name at this level to decide whether to annotate.
  const nameCount = new Map<string, number>();
  for (const s of symbols) nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1);

  const lines: string[] = [];
  const nameOccurrence = new Map<string, number>();
  for (const s of symbols) {
    const occ = (nameOccurrence.get(s.name) ?? 0) + 1;
    nameOccurrence.set(s.name, occ);
    const pad = "  ".repeat(indent);
    const range = s.startLine === s.endLine ? `L${s.startLine}` : `L${s.startLine}-${s.endLine}`;
    // Only add #N suffix when there are duplicates at this scope level.
    // First occurrence gets #1 only if there IS a second, to avoid noise
    // on the normal case.
    const hasDupes = (nameCount.get(s.name) ?? 0) > 1;
    const suffix = hasDupes ? `#${occ}` : "";
    lines.push(`${pad}${s.kind} ${s.name}${suffix} ${range}`);
    if (s.children && s.children.length > 0) {
      lines.push(formatSymbols(s.children, indent + 1));
    }
  }
  return lines.join("\n");
}

export function isSupported(filePath: string): boolean {
  return extname(filePath).toLowerCase() in EXT_TO_LANG;
}

export function isWasmLanguage(filePath: string): boolean {
  const entry = EXT_TO_LANG[extname(filePath).toLowerCase()];
  return entry?.runtime === "wasm";
}

/** Async validateSyntax for WASM grammars. Native grammars fall through to sync. */
export async function validateSyntaxAsync(filePath: string, source: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const ext = extname(filePath).toLowerCase();
  const entry = EXT_TO_LANG[ext];
  if (!entry || entry.runtime !== "wasm") return validateSyntax(filePath, source);
  const lang = await getWasmLanguage(ext);
  if (!lang) return { ok: true }; // unsupported, skip
  try {
    const WP = await getWasmParser();
    const parser = new WP();
    parser.setLanguage(lang);
    const tree = parser.parse(source);
    if (tree.rootNode.hasError) {
      // Walk for first error — same logic as sync validateSyntax
      function findError(node: any): string | null {
        if (node.type === "ERROR" || node.isMissing) {
          return `parse error at line ${node.startPosition.row + 1} col ${node.startPosition.column + 1}: ${node.type === "ERROR" ? "unexpected tokens" : `missing ${node.type}`}`;
        }
        for (let i = 0; i < node.childCount; i++) {
          const r = findError(node.child(i));
          if (r) return r;
        }
        return null;
      }
      const detail = findError(tree.rootNode) ?? "tree contains error nodes";
      return { ok: false, error: detail };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `WASM parser threw: ${(e as Error).message}` };
  }
}

/** Async symbol byte range for WASM grammars. */
export async function symbolByteRangeAsync(filePath: string, symbolPath: string): Promise<{ startIndex: number; endIndex: number; startLine: number; endLine: number } | null> {
  const entry = await cachedParseAsync(filePath);
  if (!entry) return null;
  const parts = symbolPath.split(".");
  let current: Symbol[] = entry.symbols;
  let found: Symbol | null = null;
  for (const rawPart of parts) {
    const { name, occurrence } = parseSegment(rawPart);
    let count = 0;
    found = null;
    for (const s of current) {
      if (s.name === name) {
        count++;
        if (count === occurrence) { found = s; break; }
      }
    }
    if (!found) return null;
    current = found.children ?? [];
  }
  if (!found) return null;
  return { startIndex: found.startIndex, endIndex: found.endIndex, startLine: found.startLine, endLine: found.endLine };
}

/**
 * Fuzzy search symbols by name across a file.
 * Matches substrings case-insensitively. Returns matching symbols with
 * their parent path joined by dots ("Class.method").
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

/** Format AST grep matches — grouped by symbol for readability. */
export function formatGrepMatches(matches: GrepMatch[], relativeTo?: string): string {
  if (matches.length === 0) return "No matches found";

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
    for (const [sym, ms] of bySymbol) {
      lines.push(`  ${sym}:`);
      for (const m of ms) {
        lines.push(`    ${m.line}: ${m.text.trim()}`);
      }
    }
  }
  return lines.join("\n");
}
