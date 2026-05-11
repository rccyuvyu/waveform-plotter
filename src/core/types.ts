export type DataSource = 'Telnet' | 'RTT';
export type DisplayMode = 'TIME' | 'FFT';
export type TimeUnit = 'ms' | 'us';

export type DataType =
  | 'INT8'
  | 'UINT8'
  | 'INT16'
  | 'UINT16'
  | 'INT32'
  | 'UINT32'
  | 'FLOAT'
  | 'DOUBLE';

export interface WatchEntry {
  name: string;
  address: number;
  dataType: DataType;
  byteSize: number;
}

export interface TreeViewRow {
  name: string;
  displayName: string;
  depth: number;
  valueText: string;
  dataType: string;
  address: string;
  hasChildren: boolean;
  expanded: boolean;
}

export interface PersistedState {
  variableNames: string[];
  trackedVariables: string[];
  expandedNodes: string[];
  liveWatchFrequency: number;
  telnetPort: number;
  resolvedAddresses: Record<string, string>;
  dataSource: DataSource;
  rttPort: number;
  rttRamStart: string;
  rttRamSize: string;
  rttAutoInit: boolean;
  fontSize: number;
  lineWidth: number;
  refreshFps: number;
  displayMode: DisplayMode;
  timeUnit: TimeUnit;
}

export const DEFAULT_STATE: PersistedState = {
  variableNames: [],
  trackedVariables: [],
  expandedNodes: [],
  liveWatchFrequency: 50,
  telnetPort: 4444,
  resolvedAddresses: {},
  dataSource: 'Telnet',
  rttPort: 9090,
  rttRamStart: '',
  rttRamSize: '',
  rttAutoInit: true,
  fontSize: 12,
  lineWidth: 2,
  refreshFps: 60,
  displayMode: 'TIME',
  timeUnit: 'ms'
};
