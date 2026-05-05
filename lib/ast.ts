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
  /** Optional vendored extra .scm in lib/queries/ that we add to the query. Single name or array (concatenated in order). */
  vendoredExtra?: string | string[];
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
  ".ts":   { language: TSTypescript, queryPaths: ["tree-sitter-javascript/queries/tags.scm", "tree-sitter-typescript/queries/tags.scm"], vendoredExtra: ["js-ts-extra.scm", "ts-extra.scm"], expandWrappers: ["export_statement", "lexical_declaration", "variable_declaration"] },
  ".tsx":  { language: TSTsx,        queryPaths: ["tree-sitter-javascript/queries/tags.scm", "tree-sitter-typescript/queries/tags.scm"], vendoredExtra: ["js-ts-extra.scm", "ts-extra.scm"], expandWrappers: ["export_statement", "lexical_declaration", "variable_declaration"] },
  ".js":   { language: TSJavaScript, queryPaths: ["tree-sitter-javascript/queries/tags.scm"], vendoredExtra: "js-ts-extra.scm", expandWrappers: ["export_statement", "lexical_declaration", "variable_declaration"] },
  ".jsx":  { language: TSJavaScript, queryPaths: ["tree-sitter-javascript/queries/tags.scm"], vendoredExtra: "js-ts-extra.scm", expandWrappers: ["export_statement", "lexical_declaration", "variable_declaration"] },
  ".mjs":  { language: TSJavaScript, queryPaths: ["tree-sitter-javascript/queries/tags.scm"], vendoredExtra: "js-ts-extra.scm", expandWrappers: ["export_statement", "lexical_declaration", "variable_declaration"] },
  ".cjs":  { language: TSJavaScript, queryPaths: ["tree-sitter-javascript/queries/tags.scm"], vendoredExtra: "js-ts-extra.scm", expandWrappers: ["export_statement", "lexical_declaration", "variable_declaration"] },
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
  // vue: routed through parseVueSfc — splits SFC, parses <script> as ts/js
  // using the JS/TS grammars above. No tree-sitter-vue grammar needed.
  ".vue":  { queryPaths: [] },
};

// Import-ish top-level node types per extension. Used by the synthetic
// `imports` symbol that do_code exposes so agents can address the
// top-of-file import block as one unit without knowing the language's
// exact grammar. The user surface is uniform (symbol: 'imports'); this
// mapping is the internal cost of AST-grounded detection — there is no
// universal "import" node in tree-sitter.
//
// Omissions: Ruby (`require` is a method call, not a grammar node),
// shell (`source`/`.` same story), Vue (imports live inside <script>
// and WASM symbol detection isn't wired for imports yet). On those,
// `symbol: 'imports'` returns not-found and the agent falls back to a
// whole-file replace.
const IMPORT_NODE_TYPES: Record<string, Set<string>> = {
  ".ts":   new Set(["import_statement"]),
  ".tsx":  new Set(["import_statement"]),
  ".js":   new Set(["import_statement"]),
  ".jsx":  new Set(["import_statement"]),
  ".mjs":  new Set(["import_statement"]),
  ".cjs":  new Set(["import_statement"]),
  ".py":   new Set(["import_statement", "import_from_statement", "future_import_statement"]),
  ".pyi":  new Set(["import_statement", "import_from_statement", "future_import_statement"]),
  ".go":   new Set(["import_declaration"]),
  ".rs":   new Set(["use_declaration", "extern_crate_declaration"]),
  ".java": new Set(["import_declaration"]),
  ".c":    new Set(["preproc_include"]),
  ".h":    new Set(["preproc_include"]),
  ".cc":   new Set(["preproc_include"]),
  ".cpp":  new Set(["preproc_include"]),
  ".cxx":  new Set(["preproc_include"]),
  ".hpp":  new Set(["preproc_include"]),
  ".hxx":  new Set(["preproc_include"]),
  ".cs":   new Set(["using_directive"]),
  ".php":  new Set(["namespace_use_declaration"]),
};

// Node types that may appear BETWEEN imports without breaking the
// contiguous-block invariant. Comments and preprocessor glue are
// conventional filler; any other top-level statement ends the run.
// Intentionally excludes `try_statement` — a try-wrapped compat import
// (common in Python 2/3 shims) is treated as a gap, so the synthetic
// block spans only real consecutive imports before the try.
const IMPORT_INTERSTITIAL_TYPES = new Set([
  "comment",
  "line_comment",
  "block_comment",
  "hash_bang_line",
  "shebang_line",
  "preproc_def",
  "preproc_call",
  "preproc_function_def",
  "preproc_undef",
]);

// Walk top-level children to find the first contiguous run of imports.
// Leading prelude (package decl, pragma, shebang, comments, guards) is
// silently skipped. Once inside the run, only interstitials are allowed
// between imports — any real statement ends the block.
function detectImportsSymbol(rootNode: any, ext: string): Symbol | null {
  const types = IMPORT_NODE_TYPES[ext];
  if (!types) return null;
  let first: any = null;
  let last: any = null;
  for (let i = 0; i < rootNode.childCount; i++) {
    const c = rootNode.child(i);
    if (!c) continue;
    if (types.has(c.type)) {
      if (!first) first = c;
      last = c;
      continue;
    }
    if (first && IMPORT_INTERSTITIAL_TYPES.has(c.type)) continue;
    if (first) break;
    // before first import: skip any prelude silently
  }
  if (!first || !last) return null;
  return {
    name: "imports",
    kind: "imports",
    startLine: first.startPosition.row + 1,
    endLine: last.endPosition.row + 1,
    startIndex: first.startIndex,
    endIndex: last.endIndex,
    children: [],
  };
}

// ─── Sub-symbol linguistic addressing (experimental) ───────────────────────
//
// Gated by config `experimental.subpath` (clwnd.json). When enabled, path
// segments that don't match a named child are treated as linguistic
// aliases that walk the AST inside the current symbol:
//
//   foo.when.body         → body of the first if inside foo
//   foo.when.otherwise    → else branch of the first if
//   foo.try.otherwise     → catch block of the first try
//   foo.loop#2.body       → body of the second loop
//   foo.return            → first return statement in foo
//   foo.call#3            → third call expression in foo
//
// Vocabulary (7 words, total): body, otherwise, when, loop, try, return,
// call. Each alias maps to a set of tree-sitter node types per language
// (below). `body` and `otherwise` are context-dependent (they resolve
// against the parent node); the rest do a document-order descendant
// walk for the given node types with `#N` picking the Nth match.

import { loadConfig } from "./config.ts";

function subPathEnabled(): boolean {
  return loadConfig().experimental.subpath;
}

// Node types considered "a block of statements" per language. The
// `body` alias uses these to locate the primary block child.
const BLOCK_TYPES: Record<string, string[]> = {
  ".ts":  ["statement_block", "class_body"],
  ".tsx": ["statement_block", "class_body"],
  ".js":  ["statement_block", "class_body"],
  ".jsx": ["statement_block", "class_body"],
  ".mjs": ["statement_block", "class_body"],
  ".cjs": ["statement_block", "class_body"],
  ".py":  ["block"],
  ".go":  ["block"],
  ".rs":  ["block"],
  ".java":["block", "class_body"],
  ".c":   ["compound_statement"],
  ".h":   ["compound_statement"],
  ".cc":  ["compound_statement", "field_declaration_list"],
  ".cpp": ["compound_statement", "field_declaration_list"],
  ".cxx": ["compound_statement", "field_declaration_list"],
  ".hpp": ["compound_statement", "field_declaration_list"],
  ".hxx": ["compound_statement", "field_declaration_list"],
  ".rb":  ["body_statement", "do_block"],
  ".php": ["compound_statement"],
  ".cs":  ["block"],
};

// Per-alias type maps. Empty array = alias unsupported for that ext.
const ALIAS_TYPES: Record<string, Record<string, string[]>> = {
  when: {
    ".ts":["if_statement"],".tsx":["if_statement"],".js":["if_statement"],".jsx":["if_statement"],".mjs":["if_statement"],".cjs":["if_statement"],
    ".py":["if_statement"],
    ".go":["if_statement"],
    ".rs":["if_expression"],
    ".java":["if_statement"],
    ".c":["if_statement"],".h":["if_statement"],
    ".cc":["if_statement"],".cpp":["if_statement"],".cxx":["if_statement"],".hpp":["if_statement"],".hxx":["if_statement"],
    ".rb":["if","if_modifier","unless","unless_modifier"],
    ".php":["if_statement"],
    ".cs":["if_statement"],
  },
  loop: {
    ".ts":["for_statement","for_in_statement","for_of_statement","while_statement","do_statement"],
    ".tsx":["for_statement","for_in_statement","for_of_statement","while_statement","do_statement"],
    ".js":["for_statement","for_in_statement","for_of_statement","while_statement","do_statement"],
    ".jsx":["for_statement","for_in_statement","for_of_statement","while_statement","do_statement"],
    ".mjs":["for_statement","for_in_statement","for_of_statement","while_statement","do_statement"],
    ".cjs":["for_statement","for_in_statement","for_of_statement","while_statement","do_statement"],
    ".py":["for_statement","while_statement"],
    ".go":["for_statement"],
    ".rs":["for_expression","while_expression","loop_expression"],
    ".java":["for_statement","enhanced_for_statement","while_statement","do_statement"],
    ".c":["for_statement","while_statement","do_statement"],
    ".h":["for_statement","while_statement","do_statement"],
    ".cc":["for_statement","for_range_loop","while_statement","do_statement"],
    ".cpp":["for_statement","for_range_loop","while_statement","do_statement"],
    ".cxx":["for_statement","for_range_loop","while_statement","do_statement"],
    ".hpp":["for_statement","for_range_loop","while_statement","do_statement"],
    ".hxx":["for_statement","for_range_loop","while_statement","do_statement"],
    ".rb":["while","until","for","while_modifier","until_modifier"],
    ".php":["for_statement","foreach_statement","while_statement","do_statement"],
    ".cs":["for_statement","foreach_statement","while_statement","do_statement"],
  },
  try: {
    ".ts":["try_statement"],".tsx":["try_statement"],".js":["try_statement"],".jsx":["try_statement"],".mjs":["try_statement"],".cjs":["try_statement"],
    ".py":["try_statement"],
    ".java":["try_statement","try_with_resources_statement"],
    ".cc":["try_statement"],".cpp":["try_statement"],".cxx":["try_statement"],".hpp":["try_statement"],".hxx":["try_statement"],
    ".rb":["begin"],
    ".php":["try_statement"],
    ".cs":["try_statement"],
    // Unsupported in language-level grammar — alias returns nothing.
    ".go":[],".c":[],".h":[],".rs":[],
  },
  return: {
    ".ts":["return_statement"],".tsx":["return_statement"],".js":["return_statement"],".jsx":["return_statement"],".mjs":["return_statement"],".cjs":["return_statement"],
    ".py":["return_statement"],
    ".go":["return_statement"],
    ".rs":["return_expression"],
    ".java":["return_statement"],
    ".c":["return_statement"],".h":["return_statement"],
    ".cc":["return_statement"],".cpp":["return_statement"],".cxx":["return_statement"],".hpp":["return_statement"],".hxx":["return_statement"],
    ".rb":["return"],
    ".php":["return_statement"],
    ".cs":["return_statement"],
  },
  call: {
    ".ts":["call_expression"],".tsx":["call_expression"],".js":["call_expression"],".jsx":["call_expression"],".mjs":["call_expression"],".cjs":["call_expression"],
    ".py":["call"],
    ".go":["call_expression"],
    ".rs":["call_expression","macro_invocation"],
    ".java":["method_invocation"],
    ".c":["call_expression"],".h":["call_expression"],
    ".cc":["call_expression"],".cpp":["call_expression"],".cxx":["call_expression"],".hpp":["call_expression"],".hxx":["call_expression"],
    ".rb":["call","method_call"],
    ".php":["function_call_expression","member_call_expression","method_call_expression"],
    ".cs":["invocation_expression"],
  },
};

// Catch-clause types per language — used by `otherwise` on a try.
const CATCH_TYPES = new Set([
  "catch_clause", "except_clause", "else_clause", "rescue",
  "catch_block", "catch", "handler",
]);

// `body`: field "body" or "consequence" wins; else first direct child
// whose type is in BLOCK_TYPES for this ext.
function resolveBody(node: any, ext: string): any {
  for (const field of ["body", "consequence"]) {
    const f = node.childForFieldName?.(field);
    if (f) return f;
  }
  const types = new Set(BLOCK_TYPES[ext] ?? []);
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && types.has(c.type)) return c;
  }
  return null;
}

// `otherwise`: if the parent is an if, return its "alternative" branch;
// if it's a try, return the first catch-like clause.
function resolveOtherwise(node: any): any {
  const alt = node.childForFieldName?.("alternative");
  if (alt) return alt;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && CATCH_TYPES.has(c.type)) return c;
  }
  return null;
}

// Walk descendants in document order, return the Nth node whose type
// is in `types`. Once a match is counted, we still keep walking siblings
// but don't redescend into the matched node (spec: ordinals count
// distinct siblings, not nested matches inside earlier matches).
function findNthDescendant(root: any, types: Set<string>, occurrence: number): any {
  let count = 0;
  let found: any = null;
  function walk(n: any): boolean {
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (!c) continue;
      if (types.has(c.type)) {
        count++;
        if (count === occurrence) { found = c; return true; }
        // Don't descend into matched nodes — a call inside a call
        // isn't `call#2` of the enclosing scope; it's `call#1.call`.
        continue;
      }
      if (walk(c)) return true;
    }
    return false;
  }
  walk(root);
  return found;
}

// Resolve a single alias segment inside the given node's scope.
function resolveAliasSegment(node: any, alias: string, occurrence: number, ext: string): any {
  if (alias === "body") return occurrence === 1 ? resolveBody(node, ext) : null;
  if (alias === "otherwise") return occurrence === 1 ? resolveOtherwise(node) : null;
  const typeMap = ALIAS_TYPES[alias];
  if (!typeMap) return null;
  const types = new Set(typeMap[ext] ?? []);
  if (types.size === 0) return null;
  return findNthDescendant(node, types, occurrence);
}

// Find the definition-like AST node corresponding to a Symbol. The
// Symbol's byte range may include leading comments (expandForLeadingComments),
// so we descend to the midpoint and walk up to the first definition
// ancestor — more robust than exact-range matching.
function nodeForSymbol(root: any, sym: Symbol): any {
  const mid = Math.floor((sym.startIndex + sym.endIndex) / 2);
  const inside = root.descendantForIndex?.(mid, mid) ?? root;
  let cur = inside;
  while (cur) {
    const t = cur.type as string;
    if (/function|method|class|struct|interface|enum|trait|impl|namespace|module|macro|declaration|definition/i.test(t)) {
      return cur;
    }
    if (!cur.parent) break;
    cur = cur.parent;
  }
  return inside;
}

function resolveAliasPath(filePath: string, rootSym: Symbol, aliasPath: string[]): Symbol | null {
  const ext = extname(filePath).toLowerCase();
  const lang = getLanguage(ext);
  if (!lang) return null;
  let source: string;
  try { source = readFileSync(filePath, "utf-8"); } catch { return null; }
  try {
    const P = getParser();
    const parser = new P();
    parser.setLanguage(lang);
    const tree = parser.parse(source, null, { bufferSize: 4 * 1024 * 1024 });
    let node = nodeForSymbol(tree.rootNode, rootSym);
    if (!node) return null;
    let lastName = aliasPath[0];
    for (const seg of aliasPath) {
      const { name, occurrence } = parseSegment(seg);
      lastName = name;
      const next = resolveAliasSegment(node, name, occurrence, ext);
      if (!next) return null;
      node = next;
    }
    return {
      name: lastName,
      kind: node.type,
      startLine: (node.startPosition.row as number) + 1,
      endLine: (node.endPosition.row as number) + 1,
      startIndex: node.startIndex,
      endIndex: node.endIndex,
    };
  } catch {
    return null;
  }
}

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
    // @ts-expect-error — web-tree-sitter@0.25 ships types but its package.json exports field hides them from moduleResolution: bundler
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
    const files = Array.isArray(entry.vendoredExtra) ? entry.vendoredExtra : [entry.vendoredExtra];
    for (const f of files) {
      const p = join(VENDORED_QUERY_DIR, f);
      parts.push(stripDirectives(readFileSync(p, "utf-8")));
    }
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
    // @ts-expect-error — see getWasmParser: types hidden by package exports field
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
  /**
   * Function/method signature — "(params) -> return" with whitespace
   * collapsed. Populated when the def node exposes a parameters child;
   * absent for non-callables and for grammars where the parameter node
   * isn't addressable by field name or type. Rendered in formatSymbols
   * so the outline answers "what does this take?" without a drill-in.
   */
  signature?: string;
  /**
   * Decorators / annotations applied to the definition, in source order
   * (`@staticmethod`, `@cache`, `@Override`). Arguments to the
   * decorator are stripped — agents only need the name for triage.
   */
  decorators?: string[];
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

// Vue SFC splitter. Uses @vue/compiler-sfc (sync) to find template /
// script / style block ranges, then re-parses the script block using
// the standard TS/JS grammar. Agents address blocks as synthetic
// symbols: `template`, `script`, `style` (or `style#2` etc). Children
// of `script` are real function/class symbols from the script content
// with offsets shifted to the enclosing vue file's coordinates.
// `template` children are HTML elements (via @vue/compiler-sfc's bundled
// compiler-dom AST). `style` children are CSS rules (via postcss/postcss-scss).
// Both carry absolute byte offsets in the SFC file so do_code can splice
// by symbol like `template.div#banner` or `style.linkIcon`.

// Walk a compiler-dom template AST and collect every ELEMENT node as a
// Symbol. Naming: `tag#id` if the element has a static id attr, else
// just `tag` (de-duped via #N at format time). Range = element.loc with
// absolute SFC offsets — compiler-sfc returns offsets in SFC coordinates.
function vueTemplateChildren(ast: any, source: string): Symbol[] {
  const NODE_TYPE_ELEMENT = 1;
  const PROP_TYPE_ATTR = 6;
  const out: Symbol[] = [];
  const visit = (node: any): Symbol | null => {
    if (!node || node.type !== NODE_TYPE_ELEMENT) return null;
    const start = node.loc?.start?.offset ?? -1;
    const end = node.loc?.end?.offset ?? -1;
    if (start < 0 || end < 0) return null;
    let id: string | null = null;
    for (const p of node.props ?? []) {
      if (p.type === PROP_TYPE_ATTR && p.name === "id" && p.value?.content) {
        id = p.value.content;
        break;
      }
    }
    const tag = node.tag ?? "elem";
    const name = id ? `${tag}#${id}` : tag;
    const startLine = source.slice(0, start).split("\n").length;
    const endLine = source.slice(0, end).split("\n").length;
    const children: Symbol[] = [];
    for (const c of node.children ?? []) {
      const s = visit(c);
      if (s) children.push(s);
    }
    return {
      name,
      kind: "element",
      startLine,
      endLine,
      startIndex: start,
      endIndex: end,
      children: children.length ? children : undefined,
    };
  };
  for (const c of ast?.children ?? []) {
    const s = visit(c);
    if (s) out.push(s);
  }
  return out;
}

// Parse a <style> block's content with postcss (or postcss-scss for
// lang="scss"/"sass"). Walks the tree hierarchically — nested SCSS rules
// become children, at-rules (@media, @supports, @keyframes) become parent
// scopes whose nested rules nest under them. Selector heuristic for Rule:
// `.foo` → name `foo` (kind `class`), `#foo` → name `#foo` (kind `id`),
// otherwise selector verbatim (kind `rule`). At-rules: name `@media (...)`,
// kind `atrule`. Offsets shifted by `baseOffset` for absolute SFC coords.
function vueStyleChildren(content: string, baseOffset: number, lang: string, sfcSource: string): Symbol[] {
  let postcss: any, postcssScss: any;
  try {
    postcss = _require("postcss");
    if (lang === "scss" || lang === "sass") postcssScss = _require("postcss-scss");
  } catch {
    return [];
  }
  let root: any;
  try {
    root = postcssScss ? postcssScss.parse(content) : postcss.parse(content);
  } catch {
    return [];
  }
  const lineOf = (off: number) => sfcSource.slice(0, off).split("\n").length;
  const buildRule = (node: any): Symbol | null => {
    const localStart = node.source?.start?.offset;
    const localEnd = node.source?.end?.offset;
    if (typeof localStart !== "number" || typeof localEnd !== "number") return null;
    const start = baseOffset + localStart;
    const end = baseOffset + localEnd;
    let name: string;
    let kind: string;
    if (node.type === "rule") {
      const sel = String(node.selector ?? "").trim();
      // Compound classes (.foo.bar) and chained ids count as class/id —
      // strip the leading sigil and keep internal dots in the name. The
      // path resolver greedy-joins segments to handle internal dots.
      if (/^\.[A-Za-z_][\w.-]*$/.test(sel)) { name = sel.slice(1); kind = "class"; }
      else if (/^#[A-Za-z_][\w-]*$/.test(sel)) { name = sel; kind = "id"; }
      else { name = sel; kind = "rule"; }
    } else if (node.type === "atrule") {
      const params = String(node.params ?? "").trim();
      name = params ? `@${node.name} ${params}` : `@${node.name}`;
      kind = "atrule";
    } else {
      return null;
    }
    const children: Symbol[] = [];
    for (const child of node.nodes ?? []) {
      const s = buildRule(child);
      if (s) children.push(s);
    }
    return {
      name,
      kind,
      startLine: lineOf(start),
      endLine: lineOf(end),
      startIndex: start,
      endIndex: end,
      children: children.length ? children : undefined,
    };
  };
  const out: Symbol[] = [];
  for (const child of root.nodes ?? []) {
    const s = buildRule(child);
    if (s) out.push(s);
  }
  return out;
}

function validateVueSfc(source: string): { ok: true } | { ok: false; error: string } {
  try {
    const sfcMod = _require("@vue/compiler-sfc");
    const result = sfcMod.parse(source);
    const errs = result.errors ?? [];
    if (errs.length > 0) {
      const first = errs[0];
      const msg = first?.message ?? String(first);
      const loc = first?.loc?.start ? ` at line ${first.loc.start.line} col ${first.loc.start.column}` : "";
      return { ok: false, error: `vue SFC parse error${loc}: ${msg}` };
    }
    // Validate the <script> block's JS/TS syntax too — otherwise an agent
    // could insert broken script content and the SFC parser would happily
    // pass it through.
    const script = result.descriptor.scriptSetup ?? result.descriptor.script;
    if (script?.content) {
      const lang = (script.lang || "js").toLowerCase();
      const scriptExt = lang === "ts" ? ".ts" : lang === "tsx" ? ".tsx" : lang === "jsx" ? ".jsx" : ".js";
      const gLang = getLanguage(scriptExt);
      if (gLang) {
        const P = getParser();
        const parser = new P();
        parser.setLanguage(gLang);
        const tree = parser.parse(script.content, null, { bufferSize: 4 * 1024 * 1024 });
        if (tree.rootNode.hasError) {
          const cursor = tree.walk();
          const visit = (): string | null => {
            const node = cursor.currentNode;
            if (node.type === "ERROR" || node.isMissing) {
              return `script block parse error at line ${node.startPosition.row + 1}: ${node.type === "ERROR" ? "unexpected tokens" : `missing ${node.type}`}`;
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
          const detail = visit() ?? "script tree contains error nodes";
          return { ok: false, error: detail };
        }
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `vue SFC validator threw: ${(e as Error).message}` };
  }
}

// Given a content range inside a vue file, walk back to the opening
// <tag...> and forward to the closing </tag>, so the synthetic symbol
// covers the whole block (tags included). Replacing the symbol then
// replaces the tags too — matches how agents read it via readSymbol.
function expandVueBlockRange(source: string, contentStart: number, contentEnd: number, tagName: string): { start: number; end: number; startLine: number; endLine: number } {
  const openMarker = `<${tagName}`;
  const closeMarker = `</${tagName}>`;
  let start = source.lastIndexOf(openMarker, contentStart);
  if (start < 0) start = contentStart;
  const closeIdx = source.indexOf(closeMarker, contentEnd);
  const end = closeIdx < 0 ? contentEnd : closeIdx + closeMarker.length;
  // Recompute lines from byte positions.
  const startLine = source.slice(0, start).split("\n").length;
  const endLine = source.slice(0, end).split("\n").length;
  return { start, end, startLine, endLine };
}

function parseVueSfc(filePath: string): AstCacheEntry | null {
  let source: string;
  try { source = readFileSync(filePath, "utf-8"); } catch { return null; }
  let stat;
  try { stat = statSync(filePath); } catch { return null; }
  if (stat.size > MAX_FILE_SIZE) return null;

  let descriptor: any;
  try {
    const sfcMod = _require("@vue/compiler-sfc");
    const result = sfcMod.parse(source);
    descriptor = result.descriptor;
  } catch {
    return cacheStore(filePath, stat.mtimeMs, [], source);
  }

  const symbols: Symbol[] = [];

  if (descriptor.template) {
    const t = descriptor.template.loc;
    const r = expandVueBlockRange(source, t.start.offset, t.end.offset, "template");
    let children: Symbol[] | undefined;
    try {
      const ast = descriptor.template.ast;
      if (ast) {
        const c = vueTemplateChildren(ast, source);
        if (c.length) children = c;
      }
    } catch {}
    symbols.push({
      name: "template",
      kind: "template",
      startLine: r.startLine,
      endLine: r.endLine,
      startIndex: r.start,
      endIndex: r.end,
      children,
    });
  }

  const scriptBlock = descriptor.scriptSetup ?? descriptor.script;
  if (scriptBlock) {
    const s = scriptBlock.loc;
    const scriptStart = s.start.offset;
    const scriptLineBase = s.start.line;
    const scriptLang = (scriptBlock.lang || "js").toLowerCase();
    const scriptExt = scriptLang === "ts" ? ".ts" : scriptLang === "tsx" ? ".tsx" : scriptLang === "jsx" ? ".jsx" : ".js";

    const blockRange = expandVueBlockRange(source, s.start.offset, s.end.offset, "script");
    const scriptSym: Symbol = {
      name: "script",
      kind: "script",
      startLine: blockRange.startLine,
      endLine: blockRange.endLine,
      startIndex: blockRange.start,
      endIndex: blockRange.end,
      children: [],
    };

    try {
      const lang = getLanguage(scriptExt);
      const query = getQuery(scriptExt);
      const langEntry = EXT_TO_LANG[scriptExt];
      if (lang && query && langEntry) {
        const content = source.slice(s.start.offset, s.end.offset);
        const P = getParser();
        const parser = new P();
        parser.setLanguage(lang);
        const tree = parser.parse(content, null, { bufferSize: 4 * 1024 * 1024 });
        const inner = extractSymbolsViaQuery(tree.rootNode, query, langEntry, content);
        const imp = detectImportsSymbol(tree.rootNode, scriptExt);
        const shift = (sym: Symbol): Symbol => ({
          ...sym,
          startIndex: sym.startIndex + scriptStart,
          endIndex: sym.endIndex + scriptStart,
          startLine: sym.startLine + (scriptLineBase - 1),
          endLine: sym.endLine + (scriptLineBase - 1),
          children: sym.children ? sym.children.map(shift) : undefined,
        });
        scriptSym.children = inner.map(shift);
        if (imp) scriptSym.children.unshift(shift(imp));
      }
    } catch {}

    symbols.push(scriptSym);
  }

  if (descriptor.styles?.length) {
    descriptor.styles.forEach((st: any, i: number) => {
      const stLoc = st.loc;
      const r = expandVueBlockRange(source, stLoc.start.offset, stLoc.end.offset, "style");
      const lang = String(st.lang || "css").toLowerCase();
      let children: Symbol[] | undefined;
      try {
        const c = vueStyleChildren(st.content ?? "", stLoc.start.offset, lang, source);
        if (c.length) children = c;
      } catch {}
      symbols.push({
        name: i === 0 ? "style" : `style#${i + 1}`,
        kind: "style",
        startLine: r.startLine,
        endLine: r.endLine,
        startIndex: r.start,
        endIndex: r.end,
        children,
      });
    });
  }

  return cacheStore(filePath, stat.mtimeMs, symbols, source);
}

function cachedParse(filePath: string): AstCacheEntry | null {
  const hit = cacheHit(filePath);
  if (hit) return hit;

  const ext = extname(filePath).toLowerCase();
  if (ext === ".vue") return parseVueSfc(filePath);
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
    const symbols = extractSymbolsViaQuery(tree.rootNode, query, entry, source);
    const imp = detectImportsSymbol(tree.rootNode, ext);
    if (imp) symbols.unshift(imp);
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
    const symbols = extractSymbolsViaQuery(tree.rootNode, query, langEntry, source);
    const imp = detectImportsSymbol(tree.rootNode, ext);
    if (imp) symbols.unshift(imp);
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

// Grammars disagree on field names for return types — Go uses "result",
// Java/C# use "type" (the method's return), Python/Rust/TS use
// "return_type". Probe each in order; the first hit wins.
const RETURN_TYPE_FIELDS = ["return_type", "result", "type"];

// Extract "(params) -> return" as a compact signature string. Uses
// tree-sitter's field-name API first (fastest, exact) and falls back to
// scanning children for `/parameter/`-typed nodes so C/C++'s
// declarator-wrapped functions still surface something useful. Multiline
// parameter lists get their whitespace collapsed — we're rendering a
// one-line outline, not reconstructing source.
function extractSignature(defNode: any, source: string): string | undefined {
  let params = defNode.childForFieldName?.("parameters");
  if (!params) {
    for (let i = 0; i < defNode.childCount; i++) {
      const c = defNode.child(i);
      if (c && /parameter/.test(c.type)) { params = c; break; }
    }
  }
  if (!params) return undefined;
  let sig = source.slice(params.startIndex, params.endIndex);
  let retEnd = params.endIndex;
  for (const field of RETURN_TYPE_FIELDS) {
    const ret = defNode.childForFieldName?.(field);
    if (ret && ret.startIndex >= params.endIndex) {
      sig += source.slice(params.endIndex, ret.endIndex);
      retEnd = ret.endIndex;
      break;
    }
  }
  // Collapse internal whitespace so multi-line parameter lists render
  // as one line. Keep the structure (commas, colons, arrows) intact.
  // Tighten paren-adjacent space so a multi-line `(\n  x,\n  y,\n)`
  // doesn't render as `( x, y, )`.
  sig = sig.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/,\s*\)/g, ")").trim();
  // Truncate implausibly long signatures — the outline can't absorb them.
  if (sig.length > 120) sig = sig.slice(0, 117) + "...";
  return sig;
}

// Collect decorators / annotations applied to a definition. Walks the
// expanded root (wrapper) AND the def node itself — wrappers like
// Python's decorated_definition put decorators as siblings of the def,
// whereas TS/Java attach them as children of the def. One function
// covers both layouts so the interface is uniform.
function extractDecorators(expanded: any, defNode: any, source: string): string[] {
  const decos: string[] = [];
  const seen = new Set<string>();
  // Bounded recursion. Python wraps the def in decorated_definition
  // (decorators are siblings of the def); TS/C# attach them as direct
  // children of the def; Java buries them one level deep inside a
  // `modifiers` wrapper. Depth 2 covers all three without wandering
  // into the function body.
  function scan(parent: any, depth: number): void {
    if (depth > 2) return;
    for (let i = 0; i < parent.childCount; i++) {
      const c = parent.child(i);
      if (!c) continue;
      if (c.type === "decorator" || c.type === "annotation" || c.type === "marker_annotation") {
        const raw = source.slice(c.startIndex, c.endIndex);
        const match = raw.match(/@[A-Za-z_][\w.]*/);
        if (match && !seen.has(match[0])) {
          seen.add(match[0]);
          decos.push(match[0]);
        }
        continue;
      }
      // Only recurse into modifier-like wrappers — body nodes (block,
      // class_body, statement_block) are below, and decorators never
      // live inside them. Also skip parameter/return-type subtrees.
      if (/modifier|modifiers|attribute_list/.test(c.type)) {
        scan(c, depth + 1);
      }
    }
  }
  scan(expanded, 0);
  if (defNode !== expanded) scan(defNode, 0);
  return decos;
}

function extractSymbolsViaQuery(rootNode: any, query: any, langEntry: LanguageEntry, source: string): Symbol[] {
  const matches = query.matches(rootNode);
  // Flat list of {node, kind, name, startIndex, endIndex, startLine, endLine}.
  // We post-process into a tree by byte-range containment.
  type Hit = {
    node: any;
    defNode: any;
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
    // Dedup by byte range + name only (no kind). When upstream tags.scm
    // captures an arrow-function const as @definition.function and our
    // vendored extras also capture it as @definition.constant, the first
    // hit wins — query order has upstream first, so the more specific
    // function kind beats the generic constant.
    const dedupKey = `${startIndex}:${endIndex}:${name}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    hits.push({ node: expandedRoot, defNode: defCapture.node, kind, name, startIndex, endIndex, startLine, endLine });
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
    const sig = extractSignature(hit.defNode, source);
    if (sig) sym.signature = sig;
    const decos = extractDecorators(hit.node, hit.defNode, source);
    if (decos.length > 0) sym.decorators = decos;
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
  if (ext === ".vue") return validateVueSfc(source);
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
  let aliasStart = -1;
  let i = 0;
  while (i < parts.length) {
    // Try matching the longest contiguous join first, falling back to
    // shorter joins, and finally to the bare segment. This handles
    // selectors with internal dots like `.foo.bar` (stored as `foo.bar`)
    // or `@media (min-width: 1.5em)` — `style.foo.bar` becomes
    // ["style","foo","bar"], greedy-join finds `foo.bar`. Single-segment
    // matches still win first, so nested `style.foo.bar` (parent .foo →
    // child .bar) resolves the nested form before the compound form.
    const tryMatch = (span: number): Symbol | null => {
      const joined = parts.slice(i, i + span).join(".");
      const { name, occurrence } = parseSegment(joined);
      let count = 0;
      for (const s of current) {
        if (s.name === name) {
          count++;
          if (count === occurrence) return s;
        }
      }
      return null;
    };
    let match: Symbol | null = tryMatch(1);
    let consumed = 1;
    if (!match) {
      // Single-segment miss — try longest join down to span 2. Lets
      // compound selectors (`.foo.bar` stored as `foo.bar`) and at-rule
      // params with internal dots (`@media (min-width: 1.5em)`) resolve.
      for (let span = parts.length - i; span >= 2; span--) {
        const cand = tryMatch(span);
        if (cand) { match = cand; consumed = span; break; }
      }
    }
    if (match) {
      found = match;
      current = found.children ?? [];
      i += consumed;
      continue;
    }
    // Named miss. If the experimental sub-path flag is on and we have
    // an anchor symbol, treat remaining segments as linguistic aliases
    // (when, otherwise, body, loop, try, return, call). Otherwise
    // preserve the old behavior — return null.
    if (!subPathEnabled() || !found) return null;
    aliasStart = i;
    break;
  }
  if (aliasStart === -1) return found;
  return resolveAliasPath(filePath, found!, parts.slice(aliasStart));
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
    const decoPrefix = s.decorators && s.decorators.length > 0 ? `${s.decorators.join(" ")} ` : "";
    const sig = s.signature ?? "";
    lines.push(`${pad}${decoPrefix}${s.kind} ${s.name}${suffix}${sig} ${range}`);
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
