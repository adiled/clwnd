; Additive C++ extensions to upstream tree-sitter-cpp/queries/tags.scm.
; The shipped file covers struct, union, function, type, enum, class, but
; not namespace. Without this, do_code can't find or edit anything addressed
; via a namespace path (`ns::Foo`), and the read tool's symbol outline
; for headers heavy in namespaces shows their contents flat at top level.

(namespace_definition
  name: (namespace_identifier) @name) @definition.namespace
