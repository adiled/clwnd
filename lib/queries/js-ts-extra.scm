; clwnd extras (JS + TS) — capture top-level non-callable declarations
; that upstream tags.scm skips. Without these, `const X = ref(...)`,
; `const url = "https://..."`, etc don't appear in the outline so
; do_code has nothing to anchor on.
;
; Dedup in extractSymbolsViaQuery uses startIndex:endIndex:name (no
; kind), so when upstream already captures a node as @definition.function
; (arrow/function-expression consts) the function capture wins and
; these constant captures are dropped. Nodes upstream skips fall
; through and become addressable as `constant` / `variable`.

; const X = <anything>
(program
  (lexical_declaration "const"
    (variable_declarator
      name: (identifier) @name)) @definition.constant)

; export const X = <anything>
(program
  (export_statement
    (lexical_declaration "const"
      (variable_declarator
        name: (identifier) @name)) @definition.constant))

; let X = <anything>
(program
  (lexical_declaration "let"
    (variable_declarator
      name: (identifier) @name)) @definition.variable)

; export let X = <anything>
(program
  (export_statement
    (lexical_declaration "let"
      (variable_declarator
        name: (identifier) @name)) @definition.variable))

; var X = <anything>
(program
  (variable_declaration
    (variable_declarator
      name: (identifier) @name)) @definition.variable)

; export var X = <anything>
(program
  (export_statement
    (variable_declaration
      (variable_declarator
        name: (identifier) @name)) @definition.variable))
