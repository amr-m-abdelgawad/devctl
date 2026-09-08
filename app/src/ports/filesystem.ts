export type FileSystem = {
  exists(path: string): boolean;
  readText(path: string): string;
  writeText(path: string, content: string): void;
};
