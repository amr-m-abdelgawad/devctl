export const GRPC_FRAME_PREFIX_BYTES = 5;

export type GrpcCapturedFrame = {
  compressed: boolean;
  message: Uint8Array;
};

export type SplitGrpcFramesResult = {
  frames: GrpcCapturedFrame[];
  truncated: boolean;
};

// Walk concatenated gRPC DATA: `compressed:u8 + length:u32be + message`.
// A trailing prefix or payload that does not fill `length` is dropped and
// reported as truncated. Callers OR this flag onto an already-truncated capture.
export function splitGrpcFrames(bytes: Uint8Array): SplitGrpcFramesResult {
  const frames: GrpcCapturedFrame[] = [];
  let offset = 0;
  let truncated = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < GRPC_FRAME_PREFIX_BYTES) {
      truncated = true;
      break;
    }
    const flag = bytes[offset] ?? 0;
    const length = readU32BE(bytes, offset + 1);
    const start = offset + GRPC_FRAME_PREFIX_BYTES;
    if (start + length > bytes.length) {
      truncated = true;
      break;
    }
    frames.push({
      compressed: flag === 1,
      message: bytes.subarray(start, start + length),
    });
    offset = start + length;
  }
  return { frames, truncated };
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}
