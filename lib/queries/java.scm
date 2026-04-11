; Additive Java extensions to upstream tree-sitter-java/queries/tags.scm.
; The shipped file covers class, method, and interface but misses enums,
; records, constructors, and annotation types — all real Java entities
; that production code addresses by name.

(enum_declaration
  name: (identifier) @name) @definition.enum

(record_declaration
  name: (identifier) @name) @definition.class

(constructor_declaration
  name: (identifier) @name) @definition.constructor

(annotation_type_declaration
  name: (identifier) @name) @definition.interface
