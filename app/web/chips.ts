export function mergeChipNames(...groups: Array<Iterable<string | undefined>>): string[] {
  const names = new Set<string>();
  for (const group of groups) {
    for (const name of group) {
      if (name) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}
