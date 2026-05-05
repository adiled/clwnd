; clwnd extras (JS-only). TS uses public_field_definition; JS uses
; field_definition. Each grammar rejects the other's node type, so
; field captures are split into language-specific files.

(field_definition
  property: (property_identifier) @name) @definition.property
