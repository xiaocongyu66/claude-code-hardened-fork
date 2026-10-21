export const DESCRIPTION =
  'Replace the contents of a specific cell in a Jupyter notebook.'
export const PROMPT = `Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source. Jupyter notebooks are interactive documents that combine code, text, and visualizations, commonly used for data analysis and scientific computing.

Parameters:
- notebook_path: absolute path to the .ipynb file (not relative; \`~\` is expanded).
- cell_id: the ID of the target cell — the cell's \`id\` field from the notebook JSON. A \`cell-N\` form (N = 0-based position) is also accepted as a fallback, but a bare number is not. For edit_mode=insert, the new cell is inserted after this cell, or at the beginning when cell_id is omitted. For edit_mode=replace/delete, cell_id is required.
- new_source: the complete new source for the cell (required).
- cell_type: "code" or "markdown". Defaults to the cell's current type; required for edit_mode=insert.
- edit_mode: "replace" (default), "insert", or "delete".`
