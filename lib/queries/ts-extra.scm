; clwnd extras (TS-only) — type aliases, enums, class fields. Layered on
; top of js-ts-extra.scm for .ts/.tsx. Kept separate because tree-sitter-
; javascript can't parse TS-only node types.

; type X = <...>
(type_alias_declaration
  name: (type_identifier) @name) @definition.type

; enum X { ... }
(enum_declaration
  name: (identifier) @name) @definition.enum

; class field — TS uses public_field_definition for `foo = 1` / `foo: string`
(public_field_definition
  name: (property_identifier) @name) @definition.property
