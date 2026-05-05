; clwnd extras (JS + TS) — capture declarations upstream tags.scm skips:
;   - non-callable consts/lets/vars at any depth (top-level AND nested
;     inside class methods, functions, etc.)
;   - class fields (`foo = 1` / `foo: string`)
;
; Without these, agents see only functions/classes/methods in the outline
; and miss top-level constants, type aliases, enums, and class fields.
;
; Dedup uses startIndex:endIndex:name (no kind), so when upstream already
; captures a node as @definition.function (arrow/function-expression
; consts) the function capture wins and these constant captures are
; dropped at the same byte range.
;
; Containment-based tree building means nested consts/lets naturally
; nest under their enclosing function/method/class — so reading a class
; surfaces both class-level (methods, fields) and sub-class-level
; (locals inside method bodies) declarations.

; const X = <anything> (any depth)
(lexical_declaration "const"
  (variable_declarator
    name: (identifier) @name)) @definition.constant

; let X = <anything> (any depth)
(lexical_declaration "let"
  (variable_declarator
    name: (identifier) @name)) @definition.variable

; var X = <anything> (any depth)
(variable_declaration
  (variable_declarator
    name: (identifier) @name)) @definition.variable

