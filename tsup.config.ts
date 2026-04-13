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
  "tree-sitter-json",  // config-ast.ts — JSON scope resolution
  "tree-sitter-yaml",  // config-ast.ts — YAML scope resolution
  "tree-sitter-toml",  // config-ast.ts — TOML scope resolution
  "web-tree-sitter", // WASM runtime for vue/sql (no native npm package)
];

export default defineConfig({
  entry: { index: "daemon/daemon.ts" },
  outDir: "dist/daemon",
  format: "esm",
  platform: "node",
  target: "node18",
  external: ["bun", "bun:sqlite", ...TREE_SITTER_GRAMMARS],
  // tsup doesn't copy non-source files. lib/queries/*.scm is loaded by
  // lib/ast.ts at runtime via require/readFileSync — without this hook
  // the daemon would crash on first .cpp/.bash/.java edit because the
  // vendored query file wouldn't be next to dist/daemon/index.js.
  async onSuccess() {
    const fs = await import("fs/promises");
    const path = await import("path");
    const src = path.resolve("lib/queries");
    const dst = path.resolve("dist/daemon/queries");
    try {
      await fs.mkdir(dst, { recursive: true });
      const files = await fs.readdir(src);
      for (const f of files) {
        if (f.endsWith(".scm")) {
          await fs.copyFile(path.join(src, f), path.join(dst, f));
        }
      }
      console.log(`[onSuccess] copied ${files.filter(f => f.endsWith(".scm")).length} query files → dist/daemon/queries/`);
    } catch (e) {
      console.error("[onSuccess] failed to copy queries:", e);
    }
    // Copy vendored WASM grammars (vue, eventually sql)
    const wasmSrc = path.resolve("lib/wasm");
    const wasmDst = path.resolve("dist/daemon/wasm");
    try {
      await fs.mkdir(wasmDst, { recursive: true });
      const wfiles = await fs.readdir(wasmSrc);
      for (const f of wfiles) {
        if (f.endsWith(".wasm")) {
          await fs.copyFile(path.join(wasmSrc, f), path.join(wasmDst, f));
        }
      }
      console.log(`[onSuccess] copied ${wfiles.filter(f => f.endsWith(".wasm")).length} wasm files → dist/daemon/wasm/`);
    } catch (e) {
      console.error("[onSuccess] failed to copy wasm:", e);
    }
  },
});
