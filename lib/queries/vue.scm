; Vue SFC tags — captures the three top-level sections with their tag
; names. tree-sitter-vue parses template/script/style as separate elements;
; the content inside <script> is opaque raw_text to this grammar.

(template_element
  (start_tag (tag_name) @name)) @definition.template

(script_element
  (start_tag (tag_name) @name)) @definition.script

(style_element
  (start_tag (tag_name) @name)) @definition.style
