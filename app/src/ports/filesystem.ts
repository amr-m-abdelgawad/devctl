export type DirEntry = {
  name: string;
  kind: "file" | "dir";
};

export type FileSystem = {
  exists(path: string): boolean;
  readText(path: string): string;
  writeText(path: string, content: string): void;
  listDir(path: string): DirEntry[];
};
