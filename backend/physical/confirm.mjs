export function overlap(a, b) {
  const intersection = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const area = box => (box[2] - box[0]) * (box[3] - box[1]);
  return intersection / (area(a) + area(b) - intersection);
}

export function confirmedDetections(previous, current) {
  const gap = Date.parse(current.timestamp) - Date.parse(previous?.timestamp);
  if (!previous || previous.frameId === current.frameId || !(gap > 0 && gap <= 30_000)) return [];
  return current.detections.filter(item => {
    const before = previous.detections.filter(other => other.object === item.object);
    const now = current.detections.filter(other => other.object === item.object);
    // Missing visibility on an older stored candidate must also fail closed.
    return before.length === 1 && now.length === 1 && item.visibility === 'clear' &&
      before[0].visibility === 'clear' && item.resting && !item.uncertain &&
      before[0].resting && !before[0].uncertain && overlap(item.bbox, before[0].bbox) >= 0.5;
  });
}
