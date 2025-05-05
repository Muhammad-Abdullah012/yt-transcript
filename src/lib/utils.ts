import { SegmentWithStartTime } from "@/interfaces";

export function parseTimestampToSeconds(timestamp: string): number {
  if (!timestamp) return 0;
  const parts = timestamp.split(":").map(Number);
  let seconds = 0;
  if (parts.length === 3) {
    // HH:MM:SS.ms
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    // MM:SS.ms
    seconds = parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    // SS.ms
    seconds = parts[0];
  }
  return seconds;
}

export function findSegmentIndexForTime(
  timeInSeconds: number,
  segments: SegmentWithStartTime[]
): number {
  if (!segments || segments.length === 0) {
    return -1;
  }

  segments.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));

  // Find the last segment whose start time is less than or equal to the current time
  let foundIndex = -1;
  for (let i = 0; i < segments.length; i++) {
    if ((segments[i].startTime ?? 0) <= timeInSeconds) {
      foundIndex = i;
    } else {
      // Since segments are sorted, we can stop early
      break;
    }
  }
  return foundIndex;
}
