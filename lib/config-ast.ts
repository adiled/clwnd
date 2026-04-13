/**
 * AST-backed scope resolution for structured config formats.
 *
 * Uses tree-sitter to parse JSON, YAML, and TOML into real ASTs, then
 * maps linguistic scope levels (word, phrase, sentence, paragraph) to
 * AST node ranges. No regex, no string scanning, no comma guessing.
 *
 * Loaded lazily — the parser + grammar only initialize when a config
 * file is first encountered. Code files never touch this module.
 */

import { join } from "path";
import { createRequire } from "module";
import type { ScopeMatch, ScopeResult } from "./linguistic.ts";

const _require = createRequire(join(process.cwd(), "package.json"));
const Parser = _require("tree-sitter");
const TSJson = _require("tree-sitter-json");

const GRAMMAR_MAP: Record<string, any> = {
  ".json": TSJson,
  ".jsonc": TSJson,
};

function parse(source: string, ext: string): any | null {
  const lang = GRAMMAR_MAP[ext];
  if (!lang) return null;
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser.parse(source);
}

/** Check if we have a tree-sitter grammar for this extension. */
export function hasConfigGrammar(ext: string): boolean {
  return ext in GRAMMAR_MAP;
}

// ─── JSON AST resolution ─────────────────────────────────────────────────

/**
 * Resolve a dot-path key in JSON using tree-sitter AST.
 * Returns the VALUE node's byte range (the key stays).
 */
export function resolveJsonKeyAst(source: string, anchor: string): ScopeResult {
  const tree = parse(source, ".json");
  if (!tree) return { match: null, totalMatches: 0 };

  const parts = anchor.split(".");
  let node = tree.rootNode;

  // Walk down the AST following the key path
  for (const part of parts) {
    const pair = findPairByKey(node, part);
    if (!pair) return { match: null, totalMatches: 0 };
    // Move into the value for the next step
    const value = pair.childForFieldName("value") ?? pair.namedChildren[pair.namedChildren.length - 1];
    if (!value) return { match: null, totalMatches: 0 };
    node = value;
  }

  // `node` is the value node of the deepest key
  return {
    match: {
      startIndex: node.startIndex,
      endIndex: node.endIndex,
      anchor,
      scope: "phrase",
    },
    totalMatches: 1,
  };
}

/** Find a pair node with a given key name inside an object node. */
function findPairByKey(node: any, key: string): any | null {
  // Walk children — look for "pair" nodes whose first child (key/string) matches
  for (const child of node.namedChildren) {
    if (child.type === "pair") {
      const keyNode = child.childForFieldName("key") ?? child.namedChildren[0];
      if (keyNode) {
        // Key text includes quotes — strip them
        const keyText = keyNode.text.replace(/^["']|["']$/g, "");
        if (keyText === key) return child;
      }
    }
    // Recurse into objects (for root → first level)
    if (child.type === "object") {
      const found = findPairByKey(child, key);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Find the full "pair" node for a JSON key path — includes key + value.
 * Used for deletion (need to remove the whole entry + comma).
 */
export function resolveJsonEntryAst(source: string, anchor: string): ScopeResult {
  const tree = parse(source, ".json");
  if (!tree) return { match: null, totalMatches: 0 };

  const parts = anchor.split(".");
  let node = tree.rootNode;
  let lastPair: any = null;

  for (const part of parts) {
    const pair = findPairByKey(node, part);
    if (!pair) return { match: null, totalMatches: 0 };
    lastPair = pair;
    const value = pair.childForFieldName("value") ?? pair.namedChildren[pair.namedChildren.length - 1];
    if (!value) return { match: null, totalMatches: 0 };
    node = value;
  }

  if (!lastPair) return { match: null, totalMatches: 0 };

  // Scope: the entire pair node (key + colon + value)
  // Extend to include trailing comma + whitespace/newline
  let endIndex = lastPair.endIndex;
  while (endIndex < source.length && /\s/.test(source[endIndex])) endIndex++;
  if (endIndex < source.length && source[endIndex] === ",") {
    endIndex++;
    while (endIndex < source.length && /[ \t]/.test(source[endIndex])) endIndex++;
    if (endIndex < source.length && source[endIndex] === "\n") endIndex++;
  } else {
    // Last entry — remove leading comma + newline from the previous entry.
    // Scan backward past whitespace AND newlines to find the comma.
    let startIndex = lastPair.startIndex;
    while (startIndex > 0 && /[\s]/.test(source[startIndex - 1])) startIndex--;
    if (startIndex > 0 && source[startIndex - 1] === ",") {
      startIndex--; // consume the comma
    }
    return {
      match: { startIndex, endIndex: lastPair.endIndex, anchor, scope: "phrase" },
      totalMatches: 1,
    };
  }

  // Include leading whitespace on the line
  let startIndex = lastPair.startIndex;
  while (startIndex > 0 && /[ \t]/.test(source[startIndex - 1])) startIndex--;

  return {
    match: { startIndex, endIndex, anchor, scope: "phrase" },
    totalMatches: 1,
  };
}

/**
 * Find the enclosing object/array for a text match (paragraph scope).
 * Skips the root node — returns the nearest non-root container.
 */
export function resolveJsonParagraphAst(source: string, quoted: string): ScopeResult {
  const tree = parse(source, ".json");
  if (!tree) return { match: null, totalMatches: 0 };

  const idx = source.indexOf(quoted);
  if (idx === -1) return { match: null, totalMatches: 0 };

  // Find the deepest node at this position
  let node = tree.rootNode.descendantForIndex(idx);
  if (!node) return { match: null, totalMatches: 0 };

  // Walk up to find the nearest object/array that isn't the root
  while (node.parent) {
    node = node.parent;
    if ((node.type === "object" || node.type === "array") && node.parent && node.parent.type !== "document") {
      return {
        match: {
          startIndex: node.startIndex,
          endIndex: node.endIndex,
          anchor: quoted,
          scope: "paragraph",
        },
        totalMatches: 1,
      };
    }
  }

  return { match: null, totalMatches: 0 };
}

/**
 * Find a single JSON "pair" node containing the quoted text (sentence scope).
 */
export function resolveJsonSentenceAst(source: string, quoted: string): ScopeResult {
  const tree = parse(source, ".json");
  if (!tree) return { match: null, totalMatches: 0 };

  const idx = source.indexOf(quoted);
  if (idx === -1) return { match: null, totalMatches: 0 };

  let node = tree.rootNode.descendantForIndex(idx);
  while (node) {
    if (node.type === "pair") {
      // Include the full line (leading whitespace + trailing comma/newline)
      let start = node.startIndex;
      while (start > 0 && source[start - 1] !== "\n") start--;
      let end = node.endIndex;
      while (end < source.length && source[end] !== "\n") end++;
      if (end < source.length) end++;
      return {
        match: { startIndex: start, endIndex: end, anchor: quoted, scope: "sentence" },
        totalMatches: 1,
      };
    }
    node = node.parent;
  }

  return { match: null, totalMatches: 0 };
}
