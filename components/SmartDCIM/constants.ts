
// Visual dimensions in pixels
export const PX_PER_U = 30; // 1U height in pixels
export const RACK_WIDTH_PX = 400;
export const RACK_PADDING_PX = 20; // Internal padding of the rack frame (width of the rails)
export const SERVER_WIDTH_PX = RACK_WIDTH_PX - (RACK_PADDING_PX * 2);
export const RACK_TWO_COLUMN_GAP_PX = 8;
export const TOWER_SERVER_WIDTH_PX = Math.floor((SERVER_WIDTH_PX - RACK_TWO_COLUMN_GAP_PX) / 2);
export const RACK_HEADER_HEIGHT_PX = 50; // Header height including padding and border

// Data defaults
export const DEFAULT_RACK_U = 42;
export const DEFAULT_SERVER_U = 2;
export const DEFAULT_TOWER_SERVER_U = 14;

// UDF (光纤架/网口架) dimensions
export const UDF_WIDTH_PX = RACK_WIDTH_PX;
export const UDF_HEIGHT_PX = 60;
export const DEFAULT_FIBER_PORTS = 24;
export const DEFAULT_NETWORK_PORTS = 24;
