import { TranscriptSegment } from "@/interfaces";
import { parseTimestampToSeconds } from "./utils";

export const clickTranscriptButton = () => {
  const button = document.querySelector(
    'button[aria-label="Show transcript"]'
  ) as HTMLButtonElement | null;
  if (!button) {
    console.error("button not found");
    return false;
  }
  console.log("Clicking 'Show transcript' button.");
  button.click();
  return true;
};

export const scrapeTranscript = (): TranscriptSegment[] | null => {
  console.log("YouTube Transcript Scraper started.");
  const transcriptSegments: TranscriptSegment[] = [];

  // --- Selector Strategy ---
  // This is the most fragile part. YouTube might change these class names or structure.
  // Inspect the element in your browser's DevTools to confirm current selectors.
  // Target the container holding all the individual transcript lines.
  const segmentsContainer = document.querySelector(
    "ytd-transcript-segment-list-renderer div#segments-container"
  );
  const videoElement = document.querySelector("video");
  if (!segmentsContainer) {
    // console.log("Transcript container (segments-container) not found yet.");
    return null; // Transcript panel might not be open or loaded
  }

  // Select all individual segment renderer elements within the container
  const segmentElements = segmentsContainer.querySelectorAll(
    "ytd-transcript-segment-renderer"
  );

  if (segmentElements.length === 0) {
    // console.log("No transcript segments found within the container yet.");
    return null; // Segments might still be loading inside the container
  }

  segmentElements.forEach((segmentEl) => {
    const timestampEl = segmentEl.querySelector(".segment-timestamp");
    const textEl = segmentEl.querySelector("yt-formatted-string.segment-text"); // Target the specific element holding the text

    // Use textContent and trim whitespace. Provide defaults if elements aren't found.
    const timestamp = timestampEl?.textContent?.trim() ?? "N/A";
    const text = textEl?.textContent?.trim() ?? "";

    if (text) {
      // Only add if there's actual text content
      transcriptSegments.push({ timestamp, text, startTime: parseTimestampToSeconds(timestamp), duration: 0 });
    }
  });

  for (let i = 0; i < transcriptSegments.length - 1; i++) {
    transcriptSegments[i].duration = transcriptSegments[i + 1].startTime - transcriptSegments[i].startTime;
  }
  if (videoElement) {
    transcriptSegments[transcriptSegments.length - 1].duration = videoElement.duration - transcriptSegments[transcriptSegments.length - 1].startTime;
  }
  // Return the data only if we actually found segments
  return transcriptSegments.length > 0 ? transcriptSegments : null;
};

/**
 * Formats the transcript segments into a single string.
 * @param {TranscriptSegment[]} transcriptData Array of transcript segments.
 * @returns {string} Formatted transcript string.
 */
export const formatTranscript = (
  transcriptData: TranscriptSegment[]
): string => {
  return transcriptData
    .map((segment) => `${segment.timestamp} - ${segment.text}`)
    .join("\n");
};

export const parseTranscript = (
  formattedString: string
): TranscriptSegment[] => {
  if (!formattedString) {
    return [];
  }

  const lines = formattedString.split("\n");
  const segments: TranscriptSegment[] = [];

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("-");

    // Check if the separator exists and is not at the very beginning
    if (separatorIndex > 0) {
      const timestamp = trimmedLine.substring(0, separatorIndex).trim();
      const text = trimmedLine.substring(separatorIndex + 1).trim();
      segments.push({ timestamp, text, startTime: 0, duration: 1 }); // Placeholder values for startTime and duration
    } else {
      // Handle lines that don't contain the " - " separator correctly
      console.warn(
        `Skipping line due to missing or misplaced separator: "${trimmedLine}"`
      );
    }
  }
  return segments;
};
