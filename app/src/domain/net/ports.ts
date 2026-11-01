export type PortHolder = {
  port: number;
  pid: number;
  command: string;
  // The devctl stack that left this process behind, when its supervisor is gone.
  stack?: string;
};
