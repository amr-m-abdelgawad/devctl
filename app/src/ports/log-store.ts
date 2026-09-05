export type LogEntry = {
  timestamp: string;
  service: string;
  source: string;
  stream?: "stdout" | "stderr";
  level: string;
  message: string;
  pid: number;
};

export type LogStore = {
  append(event: LogEntry): void;
};
