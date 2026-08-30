if (process.env.METADATA_SERVER_DETECTION === undefined) {
  process.env.METADATA_SERVER_DETECTION = "bios-only";
}
if (process.env.GCE_METADATA_TIMEOUT === undefined) {
  process.env.GCE_METADATA_TIMEOUT = "0";
}
