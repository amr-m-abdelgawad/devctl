// OpenTUI 0.5 installed these on the global object. 0.7 keeps them on the
// renderer only. Scroll-into-view effects call the globals, and a missing
// one throws inside the effect and replaces the screen with the error console.

type AnimationHost = {
  requestAnimationFrame: (callback: (time: number) => void) => number;
  cancelAnimationFrame: (handle: number) => void;
};

type AnimationGlobals = typeof globalThis & {
  requestAnimationFrame?: (callback: (time: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
};

export function installAnimationFrames(renderer: AnimationHost): void {
  const host = globalThis as AnimationGlobals;
  host.requestAnimationFrame = (callback) => renderer.requestAnimationFrame(callback);
  host.cancelAnimationFrame = (handle) => renderer.cancelAnimationFrame(handle);
}
