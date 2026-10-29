/** Parse exact argv, with quoting and escapes but no shell expansion. */
export function commandArguments(input: string): string[] {
  const args: string[] = [];
  let token = "",
    quote = "",
    escaped = false,
    started = false;
  for (const char of input) {
    if (escaped) {
      token += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else token += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        args.push(token);
        token = "";
        started = false;
      }
    } else {
      token += char;
      started = true;
    }
  }
  if (quote || escaped) throw new Error("Close the quoted argument or finish the escape before running this command.");
  if (started) args.push(token);
  if (!args.length || !args[0]) throw new Error("Enter a command to run.");
  return args;
}
