import { defineConfig } from "tsup";

// All tree-sitter grammar packages are marked external so tsup leaves the
// `require(grammar)` calls in lib/ast.ts as runtime lookups instead of
// trying to inline them. They have native .node bindings that can't be
// bundled anyway, but more importantly: keeping them external preserves
// the LAZY load behavior — getLanguage(ext) is the only call site, so a
// daemon process that only ever sees TypeScript files will never resolve
// or load tree-sitter-python / -java / -cpp / etc. into memory.
//
// If you add a new grammar to lib/ast.ts EXT_TO_GRAMMAR, ALSO add it
// here. Otherwise tsup may try to statically inline a future static-form
// require and either fail the build or eagerly load the grammar at
// daemon startup.
const TREE_SITTER_GRAMMARS = [
  "tree-sitter",
  "tree-sitter-typescript",
  "tree-sitter-javascript",
  "tree-sitter-python",
  "tree-sitter-go",
  "tree-sitter-rust",
  "tree-sitter-java",
  "tree-sitter-c",
  "tree-sitter-cpp",
  "tree-sitter-ruby",
  "tree-sitter-php",
  "tree-sitter-c-sharp",
  "tree-sitter-bash",
];

export default defineConfig({
  entry: { index: "daemon/daemon.ts" },
  outDir: "dist/daemon",
  format: "esm",
  platform: "node",
  target: "node18",
  external: ["bun", "bun:sqlite", ...TREE_SITTER_GRAMMARS],
});
