interface Layoutable {
  id: string;
  name: string;
  defaultSize: [number, number];
  x: number;
  y: number;
  pinnedPos?: boolean;
}

interface LayoutLine {
  sourceId: string;
  destId: string;
}

export function autoLayout(
  boxes: Layoutable[],
  lines: LayoutLine[]
): void {
  if (boxes.length === 0) return;

  const startY = 50;
  const yStep = 60;
  const startX = 50;
  const xStep = 150;

  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const boxesById = new Map<string, Layoutable>();

  for (const box of boxes) {
    adj.set(box.name, []);
    inDegree.set(box.name, 0);
    boxesById.set(box.id, box);
  }

  for (const line of lines) {
    const src = boxesById.get(line.sourceId);
    const dst = boxesById.get(line.destId);
    if (src && dst) {
      adj.get(src.name)!.push(dst.name);
      inDegree.set(dst.name, (inDegree.get(dst.name) ?? 0) + 1);
    }
  }

  const visited = new Set<string>();
  const levels = new Map<string, number>();
  const queue: string[] = [];

  for (const box of boxes) {
    if ((inDegree.get(box.name) ?? 0) === 0) queue.push(box.name);
  }

  let level = 0;
  while (queue.length > 0) {
    const next: string[] = [];
    for (const name of queue) {
      if (visited.has(name)) continue;
      visited.add(name);
      levels.set(name, level);
      for (const dep of adj.get(name) ?? []) {
        const d = (inDegree.get(dep) ?? 1) - 1;
        inDegree.set(dep, d);
        if (d <= 0 && !visited.has(dep)) next.push(dep);
      }
    }
    level++;
    queue.length = 0;
    queue.push(...next);
  }

  for (const box of boxes) {
    if (!visited.has(box.name)) {
      levels.set(box.name, level);
      level++;
    }
  }

  const colOffset = new Map<number, number>();
  for (const box of boxes) {
    if (box.pinnedPos) continue;
    const lv = levels.get(box.name) ?? 0;
    const col = colOffset.get(lv) ?? 0;
    box.x = startX + col * xStep;
    box.y = startY + lv * yStep;
    colOffset.set(lv, col + 1);
  }
}
