export type Clock = {
  now(): Date;
  isoNow(): string;
  unixMs(): number;
};
