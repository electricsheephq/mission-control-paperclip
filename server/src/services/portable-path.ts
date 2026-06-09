export function normalizePortablePath(input: string) {
  const parts: string[] = [];
  for (const segment of splitPortablePath(input)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

export function toSafePortablePath(input: string) {
  if (!isPortableRelativePath(input)) return null;
  const normalized = normalizePortablePath(input);
  return normalized || null;
}

function splitPortablePath(input: string) {
  const segments: string[] = [];
  let current = "";
  for (const char of input) {
    if (char === "/" || char === "\\") {
      segments.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  segments.push(current);
  return segments;
}

function isAsciiLetter(value: string | undefined) {
  if (!value) return false;
  const code = value.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function hasPathRoot(input: string) {
  const first = input[0];
  if (first === "/" || first === "\\") return true;
  return input.length >= 3 &&
    isAsciiLetter(input[0]) &&
    input[1] === ":" &&
    (input[2] === "/" || input[2] === "\\");
}

function isPortableRelativePath(input: string) {
  if (hasPathRoot(input)) return false;
  for (const segment of splitPortablePath(input)) {
    if (segment === "..") return false;
  }
  return true;
}
