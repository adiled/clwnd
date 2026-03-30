/**
 * AST-powered symbol extraction using tree-sitter.
 * Language-agnostic — grammars loaded per file extension.
 * Used by MCP tools for smart read (by symbol) and structured grep.
 */

import { readFileSync } from "fs";
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
export function fileSymbols(filePath: string): Symbol[] | null {
  const ext = extname(filePath).toLowerCase();
  const lang = getLanguage(ext);
  if (!lang) return null;

  const P = getParser();
  const parser = new P();
  parser.setLanguage(lang);

  const source = readFileSync(filePath, "utf-8");
  const tree = parser.parse(source);
  return extractSymbols(tree.rootNode);
}

/**
 * Find a specific symbol by name (dot-separated for nested: "Server.start").
 * Returns the source lines for that symbol, or null if not found.
 */
export function readSymbol(filePath: string, symbolPath: string): { source: string; startLine: number; endLine: number } | null {
  const symbols = fileSymbols(filePath);
  if (!symbols) return null;

  const parts = symbolPath.split(".");
  let current: Symbol[] = symbols;
  let found: Symbol | null = null;

  for (const part of parts) {
    found = current.find(s => s.name === part) ?? null;
    if (!found) return null;
    current = found.children ?? [];
  }

  if (!found) return null;

  const lines = readFileSync(filePath, "utf-8").split("\n");
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
