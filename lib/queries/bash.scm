; tree-sitter-bash ships highlights.scm but no tags.scm — write our own.
; Bash has only one definition shape: function_definition. The grammar
; recognizes both `foo() { ... }` and `function foo { ... }` as
; function_definition with field `name: (word)`.

(function_definition
  name: (word) @name) @definition.function
