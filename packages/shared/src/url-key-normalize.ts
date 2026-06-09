export function collapseToDashKey(
  value: string,
  options: {
    lowercase?: boolean;
    allowed?: (char: string) => boolean;
  } = {},
): string {
  const source = options.lowercase === false ? value : value.toLowerCase();
  const allowed = options.allowed ?? ((char) => (char >= "a" && char <= "z") || (char >= "0" && char <= "9"));
  let output = "";
  let previousWasDash = true;
  for (const char of source) {
    if (allowed(char)) {
      output += char;
      previousWasDash = false;
      continue;
    }
    if (!previousWasDash) {
      output += "-";
      previousWasDash = true;
    }
  }
  return output.endsWith("-") ? output.slice(0, -1) : output;
}

export function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "/") start += 1;
  while (end > start && value[end - 1] === "/") end -= 1;
  return value.slice(start, end);
}

export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

export function stripTrailingPathSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === "/" || value[end - 1] === "\\")) end -= 1;
  return value.slice(0, end);
}

export function splitPathSegments(value: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (const char of value) {
    if (char === "/" || char === "\\") {
      if (current) segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) segments.push(current);
  return segments;
}
