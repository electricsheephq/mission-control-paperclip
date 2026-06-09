import path from "node:path";

export function isPathWithinRoot(root: string, target: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolvePathWithinRoot(root: string, relativePath: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, relativePath);
  return isPathWithinRoot(resolvedRoot, resolvedTarget) ? resolvedTarget : null;
}

export function assertPathWithinRoot(root: string, target: string) {
  const resolvedTarget = path.resolve(target);
  return isPathWithinRoot(root, resolvedTarget) ? resolvedTarget : null;
}
