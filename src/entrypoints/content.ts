// content.ts
import { ACTION } from "@/constants";
import type {
  TranscriptSegment,
  SegmentAudioData,
  SyncStatus,
} from "@/interfaces";
import { clickTranscriptButton, scrapeTranscript } from "@/lib/scrapTranscript";
import { findSegmentIndexForTime } from "@/lib/utils";

export default defineContentScript({
  matches: ["*://*.youtube.com/watch*"],
  runAt: "document_idle",
  main() {
    console.log("YT Sync Content Script Loaded");

    let videoElement: HTMLVideoElement | null = null;
    let audioElement: HTMLAudioElement | null = null;
    let transcriptData: TranscriptSegment[] | null = null; // Original transcript
    let syncAudioData: SegmentAudioData[] | null = null; // Translated audio data
    let audioBlobUrls: Map<number, string> = new Map(); // Cache Blob URLs for audio segments

    console.log("initial syncActive is false");
    let isSyncActive = false;
    let currentSegmentIndex = -1; // Index in syncAudioData
    let timeUpdateInterval: NodeJS.Timeout | null = null; // Use interval instead of noisy timeupdate event
    const SYNC_INTERVAL = 250; // Check video time every 250ms when playing

    // --- Initialization & Cleanup ---

    function initializeSyncComponents() {
      console.log("initializeSyncComponents function called!");
      if (!audioElement) {
        audioElement = document.createElement("audio");
        audioElement.style.display = "none";
        document.body.appendChild(audioElement);
        console.log("Audio element created for sync playback.");
        audioElement.addEventListener("ended", handleAudioEnded);
        audioElement.addEventListener("error", handleAudioError);
        // audioElement.addEventListener('loadeddata', () => console.log(`Audio data loaded for segment ${currentSegmentIndex}`));
        // audioElement.addEventListener('stalled', () => console.warn(`Audio stalled for segment ${currentSegmentIndex}`));
      }
      findVideoElement(); // Ensure we have the video element ref
    }

    function playAudio(a: HTMLAudioElement) {
      console.log("playAudio function called!");
      if (videoElement && !videoElement.muted) {
        const muteButton = document.querySelector(
          `button.ytp-button[aria-label*="Mute"]`
        ) as HTMLButtonElement;
        if (muteButton) {
          muteButton.click(); // Mute the video to avoid sound interference
          console.log("Video muted to avoid sound interference.");
        } else {
          console.log("muteButton not found");
        }
      }
      return a.play();
    }
    function findVideoElement() {
      console.log("findVideoElement function called!");
      if (!videoElement || !document.body.contains(videoElement)) {
        videoElement = document.querySelector("video");
        if (videoElement) {
          console.log("Video element found.");
          attachVideoListeners(); // Attach listeners once found
        } else {
          console.warn("Could not find video element on init.");
        }
      }
    }

    function cleanupResources() {
      console.log("Cleaning up content script resources...");
      stopSync(); // Ensure sync is stopped and interval cleared
      detachVideoListeners();
      cleanupBlobUrls();
      if (audioElement) {
        audioElement.removeEventListener("ended", handleAudioEnded);
        audioElement.removeEventListener("error", handleAudioError);
        audioElement.remove(); // Remove from DOM
        audioElement = null;
      }
      if (timeUpdateInterval) {
        clearInterval(timeUpdateInterval);
        timeUpdateInterval = null;
      }
      videoElement = null; // Clear reference
      transcriptData = null;
      syncAudioData = null;
    }

    function cleanupBlobUrls() {
      console.log("Cleaning up Blob URLs...");
      if (audioBlobUrls.size > 0) {
        console.log(`Revoking ${audioBlobUrls.size} Blob URLs...`);
        audioBlobUrls.forEach((url) => URL.revokeObjectURL(url));
        audioBlobUrls.clear();
      }
    }

    function startSync() {
      console.log("startSync() function called!");
      findVideoElement(); // Make sure we have the latest video element ref
      if (!videoElement || !syncAudioData || syncAudioData.length === 0) {
        console.error(
          "Cannot start sync: Video element or audio data missing."
        );
        sendStatusUpdate({
          state: "error",
          message: "Missing video or audio data.",
        });
        return;
      }
      // if (isSyncActive) {
      //   console.log("Sync is already active.");
      //   return;
      // }

      console.log(
        "Starting synchronized playback...",
        " setting isSyncActive true in line 107"
      );
      isSyncActive = true;
      initializeSyncComponents(); // Ensure audio element exists
      attachVideoListeners(); // Ensure listeners are attached

      // Initial sync based on current video state
      const currentTime = videoElement.currentTime;
      console.log("syncAudioData:", syncAudioData);
      const targetIndex = findSegmentIndexForTime(currentTime, syncAudioData);

      if (targetIndex < 0) {
        console.error("No valid segment found for current time.");
        sendStatusUpdate({
          state: "error",
          message: "No valid segment found for current time.",
        });
        return;
      }
      if (videoElement.paused) {
        console.log("Sync started while video paused.");
        prepareSegment(targetIndex, false); // Load segment but don't play
        sendStatusUpdate({ state: "paused", segmentIndex: targetIndex });
      } else {
        console.log("Sync started while video playing.");
        const offset =
          currentTime - (syncAudioData[targetIndex]?.startTime ?? currentTime);
        playSegment(targetIndex, offset); // Play immediately
        startSyncInterval(); // Start checking time periodically
        sendStatusUpdate({ state: "playing", segmentIndex: targetIndex });
      }
    }

    function stopSync() {
      if (!isSyncActive) return;
      console.log(
        "Stopping synchronized playback...",
        " setting isSyncActive false in line 141"
      );
      isSyncActive = false;
      stopSyncInterval(); // Stop checking time
      if (audioElement) {
        audioElement.pause();
        audioElement.removeAttribute("src"); // Release resource
      }
      currentSegmentIndex = -1;
      // Keep listeners attached in case user restarts sync quickly
      sendStatusUpdate({ state: "stopped" });
    }

    /** Creates Blob URL if needed, sets src, and handles playback */
    async function prepareSegment(
      index: number,
      shouldPlay: boolean,
      playOffset: number = 0
    ): Promise<boolean> {
      if (
        !syncAudioData ||
        index < 0 ||
        index >= syncAudioData.length ||
        !audioElement
      ) {
        console.log(
          `Cannot prepare segment: Invalid index ${index} or missing data/element.`
        );
        if (audioElement && !audioElement.paused) audioElement.pause();
        currentSegmentIndex = -1;
        return false;
      }

      const segment = syncAudioData[index];
      const segmentIdentifier = `Seg ${index} (${segment.startTime.toFixed(
        1
      )}s)`;
      // console.log(`Preparing ${segmentIdentifier}: "${segment.text.substring(0, 30)}..." (Play: ${shouldPlay}, Offset: ${playOffset.toFixed(2)}s)`);

      // Avoid reloading the same segment if it's already the current source
      // Note: audioElement.currentSrc might be the blob URL
      // A more robust check might involve storing the intended index
      if (
        currentSegmentIndex === index &&
        audioElement.currentSrc &&
        !audioElement.ended
      ) {
        // console.log(`${segmentIdentifier} already loaded.`);
        if (shouldPlay && audioElement.paused) {
          try {
            // Seeking might be inaccurate, especially near the start or end
            const targetTime = Math.max(0, playOffset);
            // Avoid seeking if very close to target already
            if (Math.abs(audioElement.currentTime - targetTime) > 0.1) {
              audioElement.currentTime = targetTime;
            }
          } catch (e) {
            console.error(
              `Error setting audio currentTime on resume for ${segmentIdentifier}:`,
              e
            );
          }
          playAudio(audioElement).catch((err) =>
            handleAudioError(err, segmentIdentifier)
          );
        } else if (!shouldPlay && !audioElement.paused) {
          audioElement.pause();
        }
        return true; // Segment was already loaded
      }

      // --- Load new segment ---
      currentSegmentIndex = index;
      let blobUrl = audioBlobUrls.get(index);

      if (!blobUrl) {
        try {
          // Assuming audioContent is a base64 data URL (data:audio/wav;base64,...)
          const base64Response = await fetch(segment.audioContent);
          if (!base64Response.ok)
            throw new Error(
              `Failed to fetch base64 data URL: ${base64Response.status}`
            );
          const blob = await base64Response.blob();
          blobUrl = URL.createObjectURL(blob);
          audioBlobUrls.set(index, blobUrl);
          // console.log(`Created Blob URL for ${segmentIdentifier}`);
        } catch (e) {
          console.error(`Error creating Blob URL for ${segmentIdentifier}:`, e);
          handleAudioError(`Blob creation failed for ${segmentIdentifier}`);
          return false;
        }
      }

      // console.log(`Setting src for ${segmentIdentifier} to ${blobUrl}`);
      audioElement.src = blobUrl;
      audioElement.load(); // Load the new source

      const playPromise = playAudio(audioElement);
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            // Play started successfully
            // console.log(`${segmentIdentifier} playback started via promise.`);
            // Set currentTime *after* play() promise resolves for potentially better accuracy
            if (playOffset > 0.1) {
              // Only seek if offset is significant
              try {
                audioElement!.currentTime = playOffset;
                // console.log(`Audio currentTime set to ${playOffset.toFixed(2)}s for ${segmentIdentifier}`);
              } catch (e) {
                console.error(
                  `Error setting audio currentTime after play for ${segmentIdentifier}:`,
                  e
                );
              }
            }
            if (!shouldPlay) {
              audioElement!.pause(); // Pause immediately if needed
              // console.log(`${segmentIdentifier} paused immediately after load.`);
            }
          })
          .catch((err) => {
            // Autoplay might be blocked or another error occurred
            handleAudioError(err, segmentIdentifier);
            // If it failed to play but should have, maybe try again on user interaction?
            // For now, we rely on video events to retry playback.
            if (shouldPlay) {
              console.warn(
                `${segmentIdentifier} failed to play automatically.`
              );
              // Ensure state reflects reality
              if (!audioElement?.paused) audioElement?.pause();
            }
          });
      } else {
        // Fallback for browsers where play() doesn't return a promise (older?)
        if (shouldPlay) {
          console.warn(
            `${segmentIdentifier} play() did not return a promise. Playback might be delayed or fail.`
          );
        } else {
          // Try pausing immediately, might not work reliably
          audioElement.pause();
        }
      }
      return true;
    }

    function playSegment(index: number, offset: number = 0) {
      prepareSegment(index, true, offset);
    }

    // --- Event Handlers ---

    function handleVideoPlay() {
      console.log("handleVideoPlay function called!");
      console.log("isSyncActive:", isSyncActive);
      console.log("videoElement:", videoElement);
      console.log("syncAudioData:", syncAudioData);
      if (!isSyncActive || !videoElement || !syncAudioData) return;
      console.log("Video Play Event");
      startSyncInterval(); // Start checking time

      const currentTime = videoElement.currentTime;
      const targetIndex = findSegmentIndexForTime(currentTime, syncAudioData);
      const offset =
        currentTime - (syncAudioData[targetIndex]?.startTime ?? currentTime);

      console.log("currentTime :", currentTime);
      console.log("targetIndex :", targetIndex);
      console.log("offset :", offset);

      if (
        targetIndex === currentSegmentIndex &&
        audioElement &&
        audioElement.paused
      ) {
        // Resume current segment if it's the correct one and was paused
        console.log(
          `Resuming segment ${currentSegmentIndex} at offset ${offset.toFixed(
            2
          )}s`
        );
        try {
          // Avoid seeking if very close
          if (Math.abs(audioElement.currentTime - Math.max(0, offset)) > 0.1) {
            audioElement.currentTime = Math.max(0, offset);
          }
        } catch (e) {
          console.error("Error setting time on resume:", e);
        }
        playAudio(audioElement).catch((err) =>
          handleAudioError(err, `Seg ${currentSegmentIndex}`)
        );
      } else if (
        targetIndex !== currentSegmentIndex ||
        !audioElement?.currentSrc
      ) {
        // Start the correct segment if different or not loaded
        console.log(
          `Video played, starting segment ${targetIndex} at offset ${offset.toFixed(
            2
          )}s`
        );
        playSegment(targetIndex, offset);
      } else {
        // Correct segment is loaded, but maybe it was already playing or ended?
        // The sync interval should handle corrections.
        console.log(
          `Video played, segment ${currentSegmentIndex} already loaded.`
        );
        // Ensure audio is playing if video is playing
        if (audioElement?.paused) {
          playAudio(audioElement).catch((err) =>
            handleAudioError(err, `Seg ${currentSegmentIndex}`)
          );
        }
      }
      sendStatusUpdate({ state: "playing", segmentIndex: currentSegmentIndex });
    }

    function handleVideoPause() {
      console.log("handleVideoPause function called!");
      if (!isSyncActive || !audioElement) return;
      console.log("Video Pause Event");
      stopSyncInterval(); // Stop checking time
      if (!audioElement.paused) {
        audioElement.pause();
        console.log(`Audio paused for segment ${currentSegmentIndex}`);
      }
      sendStatusUpdate({ state: "paused", segmentIndex: currentSegmentIndex });
    }

    function handleVideoSeeked() {
      console.log("handleVideoSeeked function called!");
      if (!isSyncActive || !videoElement || !syncAudioData) return;
      const newTime = videoElement.currentTime;
      console.log(`Video Seeked Event to ${newTime.toFixed(2)}s`);

      const targetIndex = findSegmentIndexForTime(newTime, syncAudioData);
      const offset =
        newTime - (syncAudioData[targetIndex]?.startTime ?? newTime);

      console.log(
        `Seeking audio to segment ${targetIndex} at offset ${offset.toFixed(
          2
        )}s`
      );

      // Play the new segment, whether video is paused or playing
      // If paused, prepareSegment will load and pause it.
      // If playing, prepareSegment will load and play it.
      playSegment(targetIndex, offset);

      // Update status based on whether video is playing after seek
      if (!videoElement.paused) {
        startSyncInterval(); // Ensure interval is running if playing
        sendStatusUpdate({ state: "playing", segmentIndex: targetIndex });
      } else {
        stopSyncInterval(); // Ensure interval is stopped if paused
        // Ensure audio is also paused if video is paused after seek
        if (audioElement && !audioElement.paused) audioElement.pause();
        sendStatusUpdate({ state: "paused", segmentIndex: targetIndex });
      }
    }

    function handleAudioEnded() {
      console.log("handleAudioEnded function called!");
      if (!isSyncActive || !videoElement || !syncAudioData) return;
      const endedSegmentIndex = currentSegmentIndex;
      console.log(`Audio ended for segment ${endedSegmentIndex}`);

      // Don't automatically play next if video is paused
      if (videoElement.paused) {
        console.log("Video is paused, not playing next segment automatically.");
        sendStatusUpdate({ state: "paused", segmentIndex: endedSegmentIndex });
        return;
      }

      // Check current video time to decide what to play next
      checkTimeAndPlayCorrectSegment();
    }

    function handleAudioError(
      event?: Event | Error | string,
      segmentId?: string
    ) {
      console.error(
        `Audio Playback Error for ${
          segmentId ?? `Seg ${currentSegmentIndex}`
        }:`,
        event
      );
      // Attempt to recover? For now, just log. Sync interval might correct it.
      // If the error is critical (e.g., decoding), we might need to stop sync.
      // Example: Check for specific error types if needed
      // if (event instanceof DOMException && event.name === 'NotSupportedError') {
      //     stopSync(); // Stop if format is unsupported
      //     sendStatusUpdate({ state: 'error', message: 'Audio format error.' });
      // }
    }

    // --- Time Synchronization Interval ---

    function startSyncInterval() {
      console.log("startSyncInterval function called!");
      stopSyncInterval(); // Clear any existing interval
      if (!isSyncActive || !videoElement) return;
      // console.log("Starting sync interval");
      timeUpdateInterval = setInterval(
        checkTimeAndPlayCorrectSegment,
        SYNC_INTERVAL
      );
    }

    function stopSyncInterval() {
      console.log("stopSyncInterval function called!");
      if (timeUpdateInterval) {
        // console.log("Stopping sync interval");
        clearInterval(timeUpdateInterval);
        timeUpdateInterval = null;
      }
    }

    /** Periodically checks video time and ensures the correct audio segment is playing */
    function checkTimeAndPlayCorrectSegment() {
      console.log("checkTimeAndPlayCorrectSegment function called!");
      if (
        !isSyncActive ||
        !videoElement ||
        videoElement.paused ||
        !syncAudioData ||
        !audioElement
      ) {
        // Stop interval if conditions aren't met (e.g., video paused externally)
        // stopSyncInterval(); // Let pause handler manage this
        return;
      }

      const currentTime = videoElement.currentTime;
      const targetIndex = findSegmentIndexForTime(currentTime, syncAudioData);

      if (targetIndex === -1) {
        // Before first segment or error
        if (!audioElement.paused) audioElement.pause();
        return;
      }

      if (targetIndex !== currentSegmentIndex) {
        // Need to switch segments
        // console.log(`Time check: Switching from ${currentSegmentIndex} to ${targetIndex} at ${currentTime.toFixed(2)}s`);
        const offset =
          currentTime - (syncAudioData[targetIndex]?.startTime ?? currentTime);
        playSegment(targetIndex, offset);
        sendStatusUpdate({ state: "playing", segmentIndex: targetIndex });
      } else {
        // Correct segment is loaded, check audio/video drift
        const expectedAudioTime =
          currentTime - (syncAudioData[targetIndex]?.startTime ?? currentTime);
        const actualAudioTime = audioElement.currentTime;
        const drift = expectedAudioTime - actualAudioTime;

        // Resync if drift is significant (e.g., > 0.5 seconds) or if audio stopped unexpectedly
        if (Math.abs(drift) > 0.5 || audioElement.paused) {
          // console.log(`Time check: Resyncing segment ${targetIndex}. Drift: ${drift.toFixed(2)}s. Audio paused: ${audioElement.paused}`);
          try {
            const targetTime = Math.max(0, expectedAudioTime);
            // Only seek if needed
            if (Math.abs(audioElement.currentTime - targetTime) > 0.1) {
              audioElement.currentTime = targetTime;
            }
            // Ensure it's playing
            if (audioElement.paused) {
              playAudio(audioElement).catch((err) =>
                handleAudioError(err, `Seg ${targetIndex}`)
              );
            }
          } catch (e) {
            console.error(
              `Error resyncing audio time for segment ${targetIndex}:`,
              e
            );
          }
        }
        // Update status even if no change, keeps popup informed
        // sendStatusUpdate({ state: 'playing', segmentIndex: targetIndex }); // Can be noisy
      }
    }

    // --- Video Listeners ---
    function attachVideoListeners() {
      console.log("attachVideoListeners function called!");
      if (!videoElement) return;
      // console.log("Attaching video listeners.");
      // Use options for passive listeners where appropriate
      videoElement.addEventListener("play", handleVideoPlay, { passive: true });
      videoElement.addEventListener("pause", handleVideoPause, {
        passive: true,
      });
      videoElement.addEventListener("seeked", handleVideoSeeked, {
        passive: true,
      });
      // Avoid 'timeupdate' - use interval instead
    }

    function detachVideoListeners() {
      console.log("detachVideoListeners function called!");
      if (!videoElement) return;
      // console.log("Detaching video listeners.");
      videoElement.removeEventListener("play", handleVideoPlay);
      videoElement.removeEventListener("pause", handleVideoPause);
      videoElement.removeEventListener("seeked", handleVideoSeeked);
    }

    // --- Communication ---

    function sendStatusUpdate(status: Partial<SyncStatus>) {
      // Send status to popup if it's listening
      browser.runtime
        .sendMessage({ action: ACTION.SYNC_STATUS_UPDATE, payload: status })
        .catch((err) => {
          if (err.message?.includes("Receiving end does not exist")) {
            /* Normal if popup closed */
          } else {
            console.warn("Error sending status update to popup:", err);
          }
        });
    }

    // --- Message Listener (from Popup/Background) ---
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // --- GET_TRANSCRIPTION ---
      if (message.action === ACTION.GET_TRANSCRIPTION) {
        console.log("Content Script: Received GET_TRANSCRIPTION");
        (async () => {
          try {
            const buttonClickedOrOpen = await clickTranscriptButton(); // Handle promise if async
            if (!buttonClickedOrOpen) {
              throw new Error(
                "Could not find or click the 'Show transcript' button/menu item."
              );
            }

            // Use MutationObserver to wait for transcript content
            let transcriptFound = false;
            const observerTargetNode = document.body;
            const observerOptions = { childList: true, subtree: true };

            const observerCallback: MutationCallback = (
              mutationsList,
              observer
            ) => {
              if (transcriptFound) return; // Already found and responded

              const currentTranscript = scrapeTranscript();
              if (currentTranscript) {
                console.log("Transcript detected via MutationObserver.");
                transcriptFound = true;
                observer.disconnect();
                transcriptData = currentTranscript; // Store locally
                sendResponse({
                  action: ACTION.TRANSCRIPTION_RESULT,
                  payload: transcriptData,
                });
              }
            };
            const observer = new MutationObserver(observerCallback);

            // Initial check + start observer
            setTimeout(() => {
              if (transcriptFound) return; // Check if already found by another mutation perhaps
              const initialData = scrapeTranscript();
              if (initialData) {
                console.log("Transcript found on initial check.");
                transcriptFound = true;
                transcriptData = initialData;
                browser.runtime.sendMessage({
                  action: ACTION.TRANSCRIPTION_RESULT,
                  payload: transcriptData,
                });
              } else {
                console.log(
                  "Transcript not found initially, starting MutationObserver..."
                );
                observer.observe(observerTargetNode, observerOptions);
                // Timeout for observer to prevent infinite waiting
                setTimeout(() => {
                  if (!transcriptFound) {
                    observer.disconnect();
                    console.error(
                      "Timeout waiting for transcript after button click."
                    );
                    browser.runtime.sendMessage({
                      action: ACTION.TRANSCRIPTION_ERROR,
                      payload: "Timeout waiting for transcript.",
                    });
                  }
                }, 10000); // 10 second timeout
              }
            }, 1500); // Wait 1.5s after click attempt for transcript to render
          } catch (error: any) {
            console.error("Error getting transcript:", error);
            browser.runtime.sendMessage({
              action: ACTION.TRANSCRIPTION_ERROR,
              payload: error.message || "Unknown error getting transcript.",
            });
          }
        })();
        // return true; // Indicate async response
      }

      // --- SYNC_AUDIO_READY ---
      if (message.action === ACTION.SYNC_AUDIO_READY) {
        console.log(
          "Content Script: Received SYNC_AUDIO_READY",
          message.payload
        );
        syncAudioData = message.payload as SegmentAudioData[];
        cleanupBlobUrls(); // Clean up any old URLs before potentially creating new ones
        console.log(
          `Received ${syncAudioData.length} audio segments for sync.`
        );
        console.log("isSyncActive:", isSyncActive);
        // If sync was requested and we were loading, start it now
        if (isSyncActive) {
          // Check if sync process was already initiated
          console.log("Audio ready, starting sync playback now.");
          startSync(); // Re-call startSync to handle initial playback
        } else {
          // Otherwise, just signal ready state
          sendStatusUpdate({
            state: "ready",
            message: "Audio ready for sync.",
          });
        }
        return false; // No response needed back to background
      }

      // --- SYNC_AUDIO_FAILED ---
      if (message.action === ACTION.SYNC_AUDIO_FAILED) {
        console.error(
          "Content Script: Received SYNC_AUDIO_FAILED",
          message.payload
        );
        stopSync(); // Stop any active sync attempt
        syncAudioData = null; // Clear data
        sendStatusUpdate({
          state: "error",
          message: `Audio generation failed: ${message.payload}`,
        });
        return false;
      }

      // --- START_SYNC_PLAYBACK ---
      if (message.action === ACTION.START_SYNC_PLAYBACK) {
        console.log("Content Script: Received START_SYNC_PLAYBACK");
        const { language } = message.payload;

        if (!transcriptData) {
          console.error("Cannot start sync: Transcript not available.");
          sendStatusUpdate({
            state: "error",
            message: "Get transcript first.",
          });
          return false;
        }

        console.log("setting isSyncActive to true in line 703");
        // Mark sync as active *before* requesting audio or starting
        isSyncActive = true; // Set flag to indicate user wants sync

        if (syncAudioData) {
          // Audio already loaded, just start
          console.log("Audio data present, starting sync immediately.");
          startSync(); // This will set state to playing/paused
        } else {
          // Need to request audio generation from background
          console.log("Requesting sync audio from background...");
          sendStatusUpdate({
            state: "loading",
            message: "Generating audio...",
          });
          browser.runtime
            .sendMessage({
              action: ACTION.REQUEST_SYNC_AUDIO,
              payload: {
                transcription: transcriptData,
                language: language,
              },
            })
            .catch((err) => {
              console.error(
                "Error sending REQUEST_SYNC_AUDIO to background:",
                err
              );
              stopSync(); // Reset sync state on error
              sendStatusUpdate({
                state: "error",
                message: "Failed to request audio generation.",
              });
            });
        }
        return false; // No response needed
      }

      // --- STOP_SYNC_PLAYBACK ---
      if (message.action === ACTION.STOP_SYNC_PLAYBACK) {
        console.log("Content Script: Received STOP_SYNC_PLAYBACK");
        stopSync();
        // Optional: Clean up blobs immediately on stop? Or keep for faster restart?
        // cleanupBlobUrls(); // Let's keep them for now
        // syncAudioData = null; // Keep data for potential restart
        return false; // No response needed
      }

      // Default: Indicate message not handled here
      // console.log("Content script received unhandled message:", message.action);
      return false;
    });

    // --- Initial Setup & Cleanup ---
    const videoFindRetryInterval = setInterval(() => {
      if (!videoElement) {
        findVideoElement();
      } else {
        clearInterval(videoFindRetryInterval); // Stop checking once found
      }
    }, 3000); // Check every 3 seconds initially

    // Cleanup on page navigation or script unload
    window.addEventListener("beforeunload", cleanupResources);

    console.log("Content script main function finished.");
  },
});
