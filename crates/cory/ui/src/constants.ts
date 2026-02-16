// ==============================================================================
// Layout & Node Sizing Constants
// ==============================================================================

// Base width for transaction nodes in the graph.
export const NODE_MIN_WIDTH = 360;

// Minimum height a node can shrink to, even with few inputs/outputs.
export const NODE_MIN_HEIGHT = 140;

// Height of the node header (txid, meta line, labels) before I/O rows.
export const NODE_BASE_HEIGHT = 110;

// Height of a single input or output row (the clickable reference line).
export const PRIMARY_ROW_HEIGHT = 18;

// Additional height per label line rendered below an I/O row.
export const LABEL_LINE_HEIGHT = 10;

// Vertical pixel offset where I/O rows begin inside the node DOM element.
// Used for handle position estimation before DOM measurement is available.
export const IO_START_TOP = 78;

// Vertical gap between consecutive I/O rows in the CSS grid.
export const IO_ROW_GAP = 2;

// Minimum horizontal separation between input and output columns.
export const IO_COLUMNS_MIN_GUTTER = 16;

// ==============================================================================
// Sidebar Resize Constraints
// ==============================================================================

// Minimum sidebar width to keep label editors usable.
export const SIDEBAR_MIN_WIDTH = 320;

// Maximum sidebar width so the graph panel remains visible.
export const SIDEBAR_MAX_WIDTH = 960;

// Default sidebar width when no persisted preference exists.
export const SIDEBAR_DEFAULT_WIDTH = 390;

// ==============================================================================
// Autosave Timing
// ==============================================================================

// Milliseconds of silence after the last keystroke before autosaving a label.
export const AUTOSAVE_DEBOUNCE_MS = 2000;
