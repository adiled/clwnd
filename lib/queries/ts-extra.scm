; clwnd extras (TS-only) — type aliases, enums. Layered on top of
; js-ts-extra.scm for .ts/.tsx. Kept separate because tree-sitter-javascript
; can't parse type_alias_declaration / enum_declaration node types.

; type X = <...>
(program
  (type_alias_declaration
    name: (type_identifier) @name) @definition.type)

; export type X = <...>
(program
  (export_statement
    (type_alias_declaration
      name: (type_identifier) @name) @definition.type))

; enum X { ... }
(program
  (enum_declaration
    name: (identifier) @name) @definition.enum)

; export enum X { ... }
(program
  (export_statement
    (enum_declaration
      name: (identifier) @name) @definition.enum))
